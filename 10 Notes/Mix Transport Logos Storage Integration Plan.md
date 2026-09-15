---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Logos Storage Integration Example]]"
  - "[[Mix Discovery through Provider Records]]"
  - "[[Block Exchange Peer Stores]]"
  - "[[Mix Transport Block Exchange Integration - Session Events]]"
---

# Mix Transport Logos Storage Integration Plan

## Baseline after PR 1526 — 12 September 2026

This note is the working plan for integrating MixTransport with manifest fetching and BlockExchange. The generic transport is already implemented; the remaining work concerns how Storage selects that transport, discovers suitable providers, and manages peers for individual downloads. The current implementation walkthrough is [[Mix Transport Logos Storage Integration - Download Transport Selection]]; [[Mix Transport Logos Storage Integration Example]] retains the earlier reference example. Planned behavior below must not be mistaken for behavior already available.

Storage's `feat/mix-transport` branch has been rebased on master at `9f61c851`, which includes PR 1526. The dependency has one canonical path, `vendor/libp2p-mix-transport`, pinned to `b842db0464b58fe4166fa03331157dcdafd8b056`. The older integration-specific `vendor/nim-libp2p-mix-transport` registration is no longer needed. Mix is pinned to `427b0909673b8445ac684f621fbf7df25dec87b9`, which provides the explicit-destination send API required by the transport.

PR 1526 supplies Mix-address advertisement and the shared multiaddress codec registration. The rebased integration attaches MixTransport to BlockExchange and the manifest protocol, and uses transport session events for application-peer lifecycle. The existing DHT proxy behavior remains unchanged.

At the rebase baseline, the integration selected Mix at node level through `mixEnabled` and dialed by peer ID. The working increment now adds per-download selection and address-aware dialing; see [[Mix Transport Logos Storage Integration - Download Transport Selection]] for the implementation walkthrough. Local verification passed: a Storage compile-only build, 8 network tests, 57 download-manager tests, 117 engine tests, and 3 transport-selection tests including real Mix manifest/block exchanges. The download-selection increment was subsequently committed and pushed.

The end-to-end test exposed a gap in the original reference integration: a recipient tried to dial an anonymous session ID to send presence before MixTransport supported that operation. The temporary incoming-stream reuse workaround has been replaced by normal recipient-side dialing within the existing session. Remaining validation should cover real provider-record propagation, the REST endpoints over HTTP, and sustained concurrent downloads; the current end-to-end test uses a discovery stub.

## Current increment: independent BlockExchange protocol instances

**2026-09-15:** Direct and Mix are independent `BlockExcNetwork` instances. The shared `BlockExcNetworks` holder is passed to discovery and the engine. Storage creates Direct during construction and creates Mix only during Mix-enabled startup, with a non-nil MixTransport supplied to the constructor. No protocol instance recursively owns another instance.

The holder exposes one mounted codec handler, which dispatches `TransportStream` to Mix and ordinary connections to Direct. Both incoming paths retain one shared incoming-stream quota. The engine's `configureNetwork` installs the same kinds of callbacks for each transport, with the selected transport captured explicitly. Mix shutdown removes the Mix instance and its session subscription; Direct remains separate.

The refactoring is ready for review after the checks recorded in [[Mix Transport Logos Storage Integration - Validation and Open Questions]]. The code walkthrough is updated in [[Mix Transport Logos Storage Integration - Download Transport Selection]]. This increment is not committed by the assistant.

## Implemented: select the transport for a download

Live verification results, the reported DHT-over-Mix crashes, and outstanding integration checks are maintained in [[Mix Transport Logos Storage Integration - Validation and Open Questions]]. Keep those records separate from the implementation walkthrough.

**2026-09-14 follow-up:** MixTransport recipient-side opening was committed and pushed as `edd2423`; all 85 transport tests passed. Storage now pins that revision and removes the incoming-stream reuse workaround and recipient-dial prohibition. BlockExchange presence uses its normal retained sending connection, opening another stream within the same session when necessary. See [[Mix Transport Implementation Walk Through - Recipient-Originated Streams]] and [[Mix Transport Logos Storage Integration - Download Transport Selection]]. The Storage compile-only check and all three download-selection tests pass, including real-network recipient-originated presence, reuse, and replacement after stream closure. Those Storage changes were subsequently committed and pushed.

The implemented choice is `DownloadTransport.Direct` or `DownloadTransport.Mix`, with Direct as the default. REST network-download endpoints accept `?transport=direct|mix`. The same choice is passed through manifest fetching and block download creation. Enabling Mix on the node makes Mix available without forcing other downloads to use it.

One download's swarm must use one transport consistently. A Mix download must not silently fall back to a direct connection when no suitable Mix provider is available. Failure to discover or contact a Mix-capable provider should instead produce an explicit failure or remain within the download's existing bounded discovery/retry policy.

The request-path audit also found two reuse boundaries beyond the final dial: background downloads were reused by tree CID, and streaming reads selected a download by tree CID. Background reuse now includes the selected transport; a streaming store view waits on the specific download ID that created it. Direct and Mix protocol instances, engine peer stores, and in-flight trackers are separate. Both transports intentionally share verified local content.

## Provider capabilities and swarm admission

A provider's advertised Mix address supplies the endpoint and public keys needed to contact that provider over Mix. Store usable address information alongside the peer's capabilities, rather than retaining only a Boolean that says the peer supports Mix. Validate the address against the provider's peer ID before using it. Advertisement is evidence of capability, not proof that the endpoint is currently reachable or that the destination protocol is mounted.

For a Mix download, admit candidates with usable Mix contact information. For a direct download, use suitable ordinary addresses. Prefer providers discovered for the requested content over arbitrary peers from the node-wide peer store. The existing broad admission and ignored `Swarm.addPeer` result are documented in [[Block Exchange Peer Stores]]; incorporate those findings when changing admission instead of merely adding a capability filter to the broad selection.

Discovery is not the only source of peer state. Audit Switch events, Mix session events, and incoming protocol streams as well. In particular, a recipient learns an anonymous peer through an incoming Mix session, not through a provider record identifying that peer. Capability checks on outbound provider selection must not reject this legitimate incoming-session path.

## Connect using the discovered destination

Pass the discovered Mix address to MixTransport's address-aware connection API. MixTransport can then use Mix's explicit-destination API to supply the final hop. A content provider does not need to be inserted into the relay pool merely to become a destination: the pool supplies intermediate relays, while the provider record supplies destination information.

Keep this change at the discovery-to-connection boundary. Do not temporarily replace entries in libp2p's peer store, and do not reintroduce destination enrollment in the relay pool as a workaround. Update the manifest connection path as well as BlockExchange, since a download needs both protocols to honor the same choice.

## Peer lifecycle when both transports are available

The same real provider can be used by a direct download and a Mix download concurrently. The implementation uses separate peer state for each transport, while retaining one download manager and one download-ID namespace. This avoids changing every protocol-facing peer-ID callback and prevents one transport's departure from evicting the other transport's peer context.

Retain Switch events for direct application connections and Mix session events for Mix application sessions. A physical connection to a Mix relay must not be treated as a BlockExchange peer merely because the Switch reports it. On the recipient, continue using the anonymous session identity exposed by the transport. The existing recipient-side session-reset limitation should remain explicit until a suitable transport lookup/reset API is available.

## Verification and walkthroughs

Build the next increment around a small set of end-to-end cases: a direct manifest-and-block download, a Mix manifest-and-block download, rejection of unsuitable candidates for Mix, and concurrent direct/Mix use of the same provider without connection reuse across modes. Include a failure case proving that a Mix request does not fall back to direct dialing. Extend stress and loss tests in later increments rather than making the first integration step depend on a large experiment campaign.

For each increment, update the design specification and the relevant walkthrough together with the implementation. Introduce each operation before showing its code, include function signatures, and explain which caller passes the transport choice to the next layer. Document the reason for each state transition, not only the names of fields that change.

## Deferred issues

The AutoNAT address-mapper ordering issue remains unresolved. The reverted input-based mapper fix must not be restored: a later mapper may supply the reachable endpoint, so the Mix mapper's input is not necessarily final. The current mapper uses the endpoint retained from an earlier address update. A proper solution needs a reliable final-address stage and a regression test involving a later endpoint-producing mapper.

Keep the existing DHT proxy protocol outside this increment. Provider-record freshness and size constraints, recipient-session reset support, and the unfinished high-concurrency harness investigation remain follow-up work; the rebase does not establish that those issues are resolved.
