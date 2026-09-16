---
related:
  - "[[Mix Transport Logos Storage Integration Plan]]"
  - "[[Mix Transport Logos Storage Integration - Download Transport Selection]]"
  - "[[Mix Transport Logos Storage Integration - Validation and Open Questions]]"
  - "[[Block Exchange Peer Stores]]"
---

# BlockExchange Mix Integration - Behavioral Changes and Experiments

Updated: 2026-09-16.

This is a decision and experiment record, not an implementation walkthrough. It preserves the rationale for behavioral changes considered during Mix integration, including changes that should be removed from the Direct path but may remain useful for separate experiments. A proposed benefit is not a measured improvement.

## Compatibility requirement

Direct downloads running alone must retain the original behavior and benchmark performance. The source comparison so far uses master baseline `9f61c851`, the common ancestor containing PR #1526. Any intentional difference in the Direct path needs an explicit justification and review. Concurrent Direct/Mix resource contention is outside this particular requirement.

The Mix path should also retain the established BlockExchange behavioral model unless a deviation is required by anonymous communication or explicitly chosen as an experiment. Transport isolation does not itself require different content-discovery or peer-selection policies.

The code comparisons below distinguish **master baseline**, **initial integration**, and **current agreed implementation**. Paths are relative to the Storage repository. Excerpts include function signatures; comments identify omitted code. Historical snippets explain the reviewed changes, not APIs that should be copied into new code.

## Reviewed policy overview

The comparison baseline is master at `9f61c851`, not a moving reference to future master changes. Each row describes a separate decision; enabling provider priority does not implicitly enable admission-based query suppression.

| Decision | Master baseline and current default (Direct and Mix) | Explicit experiment |
| --- | --- | --- |
| Initial candidates | All connected peers; shuffle and truncate only above the limit | Provider-first order, truncated without shuffling |
| Later candidates | All connected peers, without initial truncation | Provider-first order |
| Provider-only eligibility | Not required | `providersOnly = true` |
| Provider tracking | Not needed by selection | Enabled only for a transport whose policy needs it |
| New candidate refused by swarm | Still send presence query | `QueryAdmittedPeers` suppresses the query |
| Existing peer with complete availability | Skip presence query | Unchanged in both query policies |
| Direct provider registration | Switch `Joined` event, including relay exclusion | No alternate registration policy retained |
| Direct provider addresses | Pass the original list to libp2p; let libp2p select/reuse a connection | No filtering policy retained |
| Streaming reader binding | Master: arbitrary matching tree download; current: reader's own download ID | Accepted shared correctness correction, not an optional policy |

## Peer eligibility and provider priority

### Original behavior

The Direct engine collects connected peers from its peer-context store. Membership in that store does not establish that a peer has the requested content. BlockExchange sends presence queries to find out.

For the initial presence broadcast, the engine shuffles candidates only when their number exceeds the swarm limit, then truncates the list. Later presence broadcasts collect the connected peers without that initial shuffle-and-truncate operation.

### Change introduced during integration

Commit `b8669493` added `candidatePeers` in `storage/blockexchange/engine/engine.nim`. The helper places peers listed in a download's provider results first. Direct adds other connected peers afterward; Mix excludes peers not listed as providers for that download.

The initial shuffle was removed so it would not undo provider priority. These are distinct changes: provider-based eligibility, provider-first ordering, and removal of random selection when the initial list is too large.

### Motivation and possible benefit

Discovery identifies peers advertised as providers of the requested manifest CID. Prioritizing those peers could reduce presence queries to unrelated peers and shorten the search for useful providers. Restricting Mix queries to those providers could save Mix packets and return-path SURBs.

These benefits have not been established by comparative benchmarks. A manifest provider record is also not proof that the peer currently has every requested data block.

### Costs and limitations

A peer can have useful content without appearing in the provider results available to this download. Excluding that peer can discard a useful source. Without shuffling, a limited initial query can repeatedly select the same subset of peers.

An established Mix session already supplies a Mix communication path. The session does not prove content availability or BlockExchange protocol support, but an additional provider-record requirement is not necessary merely to separate Mix from Direct.

### Review decision and implementation

Both Direct and Mix now default to master's original peer-selection procedure: shuffle and truncate only an oversized initial list, and collect all peers for later queries. The engine receives independent policies through `directPeerSelectionPolicy` and `mixPeerSelectionPolicy`. The shared worker still controls when to query peers.

`newProviderPriorityPolicy()` preserves provider-first selection as an opt-in experiment. `newProviderPriorityPolicy(providersOnly = true)` separately enables provider-only eligibility. The initial provider-priority selection truncates without shuffling; later selection returns every eligible candidate. Neither experiment is implicitly enabled for Mix.

The default policy does not need provider information. With both defaults, the engine installs no discovery provider callback and does not scan downloads to populate provider sets. When only one transport opts in, the callback ignores discovery results for the other transport.

Provider-priority benefits remain unmeasured. Randomizing within provider and fallback groups remains a possible future experiment, not current behavior.


### Code comparison: candidate selection

In `storage/blockexchange/engine/engine.nim`, `downloadWorker` chooses candidates before calling `broadcastWantHave`. Master's initial selection was embedded in the worker (unrelated setup, sending, and the batch loop are omitted):

```nim
proc downloadWorker(
    self: BlockExcEngine, download: ActiveDownload
) {.async: (raises: []).} =
  # Other setup and surrounding try/except omitted.
  let maxSwarmPeers = download.ctx.swarm.config.deltaMax
  var connectedPeers = self.peers.toSeq()
  if connectedPeers.len > maxSwarmPeers:
    shuffle(connectedPeers)
    connectedPeers.setLen(maxSwarmPeers)
  # Broadcast to connectedPeers; then enter the batch loop.
```

The initial integration replaced that collection with the following helper, then truncated without shuffling. This is the historical behavior that introduced provider priority for Direct and provider-only eligibility for Mix:

```nim
proc candidatePeers(self: BlockExcEngine, download: ActiveDownload): seq[PeerContext] =
  # Known providers are considered first. Other direct peers remain fallback
  # probes; Mix downloads only probe providers discovered for their manifest.
  let peers = self.peersFor(download.ctx.transport)
  for peer in peers:
    if peer.id in download.ctx.providerPeers:
      result.add(peer)
  if download.ctx.transport == DownloadTransport.Direct:
    for peer in peers:
      if peer.id notin download.ctx.providerPeers:
        result.add(peer)
```

The current worker obtains the selected transport's policy and delegates candidate selection. This excerpt isolates the initial selection:

```nim
proc downloadWorker(
    self: BlockExcEngine, download: ActiveDownload
) {.async: (raises: []).} =
  # Other setup and surrounding try/except omitted.
  let
    peers = self.peersFor(download.ctx.transport)
    peerSelection = self.peerSelectionPolicies[download.ctx.transport]
    maxSwarmPeers = download.ctx.swarm.config.deltaMax
    connectedPeers = peerSelection.selectInitialPresencePeers(
      peers, download.ctx.providerPeers, maxSwarmPeers
    )
  # Broadcast to connectedPeers; the batch loop later uses selectPresencePeers.
```

The default methods in `storage/blockexchange/engine/peerselection.nim` preserve master's distinct initial and later selection rules:

```nim
method selectInitialPresencePeers*(
    policy: PresencePeerSelectionPolicy,
    peers: PeerContextStore,
    providers: HashSet[PeerId],
    limit: int,
): seq[PeerContext] {.base, gcsafe, raises: [].} =
  result = peers.toSeq()
  if result.len > limit:
    shuffle(result)
    result.setLen(limit)

method selectPresencePeers*(
    policy: PresencePeerSelectionPolicy,
    peers: PeerContextStore,
    providers: HashSet[PeerId],
): seq[PeerContext] {.base, gcsafe, raises: [].} =
  peers.toSeq()
```

Experiments opt in through these constructors. Provider-only eligibility is a separate choice; selecting Mix does not enable it:

```nim
proc newPresencePeerSelectionPolicy*(): PresencePeerSelectionPolicy =
  ## Master's selection: shuffle only an oversized initial candidate list.
  PresencePeerSelectionPolicy()

proc newProviderPriorityPolicy*(providersOnly = false): ProviderPriorityPolicy =
  ## Prioritize known providers. Excluding other peers is a separate opt-in.
  ProviderPriorityPolicy(providersOnly: providersOnly)
```

Provider tracking is controlled by `needsProviderTracking`: the default returns false, while `ProviderPriorityPolicy` returns true. The engine installs its discovery callback only if at least one policy needs it, and the callback ignores results for a transport whose policy does not.

## Approved isolation through injected policies

Keep the existing independent `BlockExcNetwork` instances, their connection handling, and the mounted `dispatchProtocol`. Do not introduce a duplicate `BlockExcMixNetwork`. Protocol duplication would not isolate variations that actually live in the engine, discovery, or download management.

Instead, preserve the shared operation flow and inject small policies at identified behavioral boundaries. Presence-peer selection is the first implemented boundary, in `engine/peerselection.nim`. This does not yet restore every Direct-path behavior: the remaining differences require individual review.

Swarm-admission gating is the second implemented boundary. The connection handling, mounted dispatcher, and swarm admission rules remain unchanged.

## Presence queries when swarm admission fails

### Master behavior

`broadcastWantHave` calls `ActiveDownload.addPeerIfAbsent` before sending a query. For an existing peer, master skips the query only when availability is complete. For a new peer, master attempts `swarm.addPeer`, ignores its Boolean result, and permits the query.

Consequently, a full swarm does not prevent asking another connected peer about content. A swarm ban also prevents admission but does not suppress that query. This is the baseline behavior being preserved, not a new recommendation about bans.

### Integration change and tradeoff

The integration returned the admission result instead. A full swarm or a swarm ban therefore suppressed the query. This can save requests and responses, including Mix traffic and SURBs, but prevents learning content availability from those candidates. Sending a query does not guarantee that its response can be used: the normal availability-update path still applies swarm admission rules.

Neither alternative has been shown to improve benchmark results.

### Decision and configuration

`PresenceQueryPolicy.QuerySelectedPeers` restores master behavior and is the default for Direct and Mix. `PresenceQueryPolicy.QueryAdmittedPeers` retains admission-based suppression as an explicit experiment. Existing incomplete peers remain queryable under either policy; existing complete peers are skipped under both.

`BlockExcEngine.new` accepts `directPresenceQueryPolicy` and `mixPresenceQueryPolicy`. For example, passing `mixPresenceQueryPolicy = PresenceQueryPolicy.QueryAdmittedPeers` changes only Mix queries. These arguments are independent of the candidate-selection policies introduced in the first increment and are not REST parameters.

The engine stores one query policy per transport. `broadcastWantHave` passes the selected policy into `addPeerIfAbsent`, which attempts admission once and decides whether to query. A small enum is sufficient for these two fixed behaviors; a new protocol subclass or duplicated sending loop is unnecessary.

The helper's name still describes its admission side effect, while its returned Boolean controls sending. Its API comment and the walkthrough explicitly explain that distinction. No policy forces admission, increases capacity, or removes a ban.

### Discussion and measurements still needed

Compare query counts, useful presence responses, completion latency, and Mix SURB use under a full swarm. Consider ban semantics separately before changing them: the default intentionally preserves master's querying behavior. These are proposed measurements, not recorded benefits.


### Code comparison: admission and permission to query

`broadcastWantHave` uses the Boolean returned by `addPeerIfAbsent` to decide whether to send. In `storage/blockexchange/engine/activedownload.nim`, master ignored failed admission for a new peer:

```nim
proc addPeerIfAbsent*(
    download: ActiveDownload, peerId: PeerId, availability: BlockAvailability
): bool =
  let existingPeer = download.ctx.swarm.getPeer(peerId)
  if existingPeer.isSome:
    # peer already tracked, skip if bakComplete
    return existingPeer.get().availability.kind != bakComplete

  discard download.ctx.swarm.addPeer(peerId, availability)
  return true # new peer added, send WantHave
```

The initial integration changed the final two statements to `return download.ctx.swarm.addPeer(peerId, availability)`. That made admission failure suppress the query. The current implementation explicitly selects the behavior:

```nim
proc addPeerIfAbsent*(
    download: ActiveDownload,
    peerId: PeerId,
    availability: BlockAvailability,
    queryPolicy: PresenceQueryPolicy = PresenceQueryPolicy.QuerySelectedPeers,
): bool =
  ## Attempts admission and returns whether to send a presence query, not
  ## whether admission succeeded. Existing complete peers need no query.
  let existingPeer = download.ctx.swarm.getPeer(peerId)
  if existingPeer.isSome:
    # peer already tracked, skip if bakComplete
    return existingPeer.get().availability.kind != bakComplete

  let admitted = download.ctx.swarm.addPeer(peerId, availability)
  return queryPolicy == PresenceQueryPolicy.QuerySelectedPeers or admitted
```

The caller in `engine/engine.nim` supplies the policy for the download's transport. Message construction and exception handling are omitted:

```nim
proc broadcastWantHave(
    self: BlockExcEngine,
    download: ActiveDownload,
    start: uint64,
    count: uint64,
    peers: seq[PeerContext],
) {.async: (raises: [CancelledError]).} =
  # Resolve range address and selected network; return if unavailable.
  for peerCtx in peers:
    if not download.addPeerIfAbsent(
      peerCtx.id,
      BlockAvailability.unknown(),
      self.presenceQueryPolicies[download.ctx.transport],
    ):
      # Skip presence request for peer with Complete availability, or when
      # QueryAdmittedPeers is selected and swarm admission failed.
      continue
    # Send WantHave using the existing message and timeout handling.
```

Both variation points are configured independently through the engine constructor:

```nim
proc new*(
    T: type BlockExcEngine,
    localStore: BlockStore,
    networks: BlockExcNetworks,
    discovery: DiscoveryEngine,
    advertiser: Advertiser,
    peerStore: PeerContextStore,
    downloadManager: DownloadManager,
    selectionPolicy = spSequential,
    directPeerSelectionPolicy: PresencePeerSelectionPolicy =
      newPresencePeerSelectionPolicy(),
    mixPeerSelectionPolicy: PresencePeerSelectionPolicy =
      newPresencePeerSelectionPolicy(),
    directPresenceQueryPolicy: PresenceQueryPolicy =
      PresenceQueryPolicy.QuerySelectedPeers,
    mixPresenceQueryPolicy: PresenceQueryPolicy = PresenceQueryPolicy.QuerySelectedPeers,
): BlockExcEngine
```

For example, passing `mixPeerSelectionPolicy = newProviderPriorityPolicy()` prioritizes providers for Mix, while passing `mixPresenceQueryPolicy = PresenceQueryPolicy.QueryAdmittedPeers` suppresses Mix queries after failed admission. Either argument can be supplied without the other; omitted arguments retain the defaults.

## Direct provider registration

### Master behavior and the integration change

At baseline `9f61c851`, Direct `dialPeer` calls `Switch.connect` without explicitly registering the provider afterward. The Switch's `Joined` event calls `handlePeerJoined`, which checks `excludedPeers` before registering the protocol peer and notifying the engine.

The integration added `await self.registerPeer(peer.peerId)` after `Switch.connect`. That extra path can notify the engine a second time and bypasses the relay-exclusion check. The current engine avoids duplicate peer contexts, but the extra callback still executes. An excluded peer registered this way can also have its later departure ignored by the exclusion check.

The added call ensures an explicit registration has completed before provider dialing returns. That timing difference is not required for transport selection and is not evidence that the event-driven path is broken.

### Decision

Remove the extra registration call. Direct uses Switch peer events; Mix continues using MixTransport session events. Keep the protocol-instance structure and dispatcher unchanged. Unlike the first two variations, no experimental policy is retained: competing lifecycle paths do not provide a demonstrated useful variation.

The registration correction left address filtering and already-connected checks untouched. The subsequent address-handling review, recorded below, removed filtering separately. A reused physical connection still need not emit another `Joined` event. If readiness becomes a demonstrated problem, address readiness explicitly rather than duplicating registration.

### Regression coverage

Two focused tests dial real Direct providers: one checks a single registration notification; the other checks that an excluded relay is not registered despite a successful connection and an observed Switch `Joined` event. Runtime outcomes belong in the separate validation note.


### Code comparison: the extra registration path

In `storage/blockexchange/network/network.nim`, the pre-review Direct branch performed both operations below. The checks and Mix branch are omitted:

```nim
proc dialPeer*(self: BlockExcNetwork, peer: PeerRecord) {.async.} =
  # Earlier checks and Mix branch omitted; historical Direct branch:
  let addresses = directAddresses(peer.addresses.mapIt(it.address))
  if addresses.len == 0:
    raise newException(StorageError, "Provider has no direct address")
  await self.switch.connect(peer.peerId, addresses)
  await self.registerPeer(peer.peerId)
```

The registration increment removed only the final call. The later address-handling increment separately restored forwarding the original address list, shown below. The current event handler remains responsible for exclusion and registration:

```nim
proc handlePeerJoined*(
    self: BlockExcNetwork, peer: PeerId
) {.async: (raises: [CancelledError]).} =
  if peer in self.excludedPeers:
    return
  await self.registerPeer(peer)
```

`BlockExcNetwork.init` subscribes the Direct instance to Switch events and routes `Joined` to this handler. Mix retains its separate session-event subscription.

## Direct provider-address handling

### Master behavior and the integration change

Master passes each provider's original address list to `Switch.connect` for BlockExchange and `Switch.dial` for Manifest. Libp2p handles connection reuse and, when a new connection is needed, attempts supported candidates in order.

The integration added `directAddresses` to remove Mix advertisements, then rejected an empty filtered list before invoking libp2p. Our normal advertisement flow adds Mix information alongside ordinary addresses, so a Mix-only record is not an established normal-operation failure scenario. The empty-list argument was a theoretical compatibility difference, not a reproduced advertisement bug.

### Decision and evidence

Restore master's Direct calls in both protocols and remove the unused filtering helper. No alternative filtering policy is retained. The Mix path continues to validate Mix advertisements and does not fall back to Direct.

The inspected libp2p TCP and QUIC transports require full address-pattern matches. Relay transport requires a terminal `p2p-circuit` component. A normal address ending in `mix-transport` is therefore declined by these ordinary transports. Correctness does not require the Mix entry to be last. The dialer can reuse an existing connection, or try supported address candidates until one succeeds within the dialing deadline.

The real Direct/Mix integration fixture now puts the Mix advertisement before the ordinary endpoint. This exercises mixed address input without relying on the normal append order. Runtime results are recorded separately in the validation note.


### Code comparison: forwarding provider addresses

The historical filtering and empty-list rejection for BlockExchange are shown in the preceding registration snippet. The current Direct branch in `network/network.nim` is again master's call (other branches omitted):

```nim
proc dialPeer*(self: BlockExcNetwork, peer: PeerRecord) {.async.} =
  # Earlier checks and Mix branch omitted; current Direct branch:
  await self.switch.connect(peer.peerId, peer.addresses.mapIt(it.address))
```

Manifest had the equivalent filtering in `storage/manifest/protocol.nim`. This historical excerpt omits the Mix branch, protocol I/O, and error handling:

```nim
proc fetchManifestFromPeer(
    self: ManifestProtocol, peer: PeerRecord, cid: Cid, transport: DownloadTransport
): Future[?!bt.Block] {.async: (raises: [CancelledError]).} =
  var conn: Connection
  # Surrounding try, Mix branch, protocol I/O and finally omitted.
  # Historical Direct branch:
  let addresses = directAddresses(peer.addresses.mapIt(it.address))
  if addresses.len == 0:
    return failure("Provider has no direct address")
  conn = await self.switch.dial(peer.peerId, addresses, ManifestProtocolCodec)
```

The current Direct branch restores master's dialing expression; the transport parameter remains for selecting the separate Mix branch:

```nim
proc fetchManifestFromPeer(
    self: ManifestProtocol, peer: PeerRecord, cid: Cid, transport: DownloadTransport
): Future[?!bt.Block] {.async: (raises: [CancelledError]).} =
  var conn: Connection
  # Surrounding try, Mix branch, protocol I/O and finally omitted.
  # Current Direct branch:
  conn = await self.switch.dial(
    peer.peerId, peer.addresses.mapIt(it.address), ManifestProtocolCodec
  )
```

## Advertisement preservation: separate follow-up

The Mix mapper appends an advertisement to its input; it is not guaranteed to be the final mapper. The earlier contributor objection concerned needing the last position for a proposed endpoint-derivation fix, not an existing last-position guarantee.

`PeerInfo.expandAddrs` replaces its working list with each mapper's returned list. A later mapper is therefore able to omit the Mix entry. Current AutoRelay preserves its input and prepends relay addresses; it does not itself discard the entry. NAT mapping and the final address policy have their own transformation/filtering behavior, so general preservation must not be assumed.

There is also a separate branch: non-empty `announcedAddrs` bypasses the mapper chain entirely. Storage's explicit external-IP setup populates that field. A Mix advertisement will not be appended through the mapper on that branch unless included through another mechanism. This is source-level evidence requiring focused end-to-end validation, not a reproduced field failure.

Losing the advertisement prevents peers relying on newly discovered provider metadata from learning Mix capability/contact information. It does not itself close established sessions. Investigate final advertisement generation and preservation separately; do not expand the Direct-dialing correction into a mapper redesign.

## Streaming-reader binding: accepted shared correction

### Master behavior

Master starts a fresh foreground download for each streaming request, but gives the reader the node-wide `NetworkStore`. That store selects a download by tree CID, returning the first entry encountered in the per-tree table. This is not an intentional oldest/fastest selection policy and need not select the operation created for the reader.

With two Direct downloads of the same tree, a reader can therefore await another download's block future while its lifecycle task monitors its own download's completion. Cancellation or failure of the selected other download can affect the read. A block arriving through the reader's own operation does not directly complete the other operation's handle.

### Current behavior and decision

Keep the download-ID-bound store view for both Direct and Mix. The reader selects `(downloadId, treeCid)`, aligning its missing-block waits with its lifecycle. The view shares the existing engine and local store; it does not create a separate cache or download. If the bound download has gone, the view reads locally instead of attaching to another download.

This is an explicitly accepted Direct-path correctness correction, not exact behavioral equivalence with master for concurrent same-tree downloads. No legacy-selection policy is retained. The additional wrapper allocation and ID-based lookup remain costs to measure; no benchmark equivalence is claimed.

Focused regression coverage includes Direct/Direct cancellation isolation and the existing Direct/Mix handle-isolation test. Validation outcomes belong in the separate validation note.


### Code comparison: reader ownership

The retained diagnostic in `tests/storage/blockexchange/testdownloadmanager.nim` observes which download the tree-only lookup actually returns; it does not assume insertion order. Cancelling that selected download fails the unbound read while the other operation remains active. The complementary binding test binds the reader to the opposite download and confirms that cancelling the tree-selected operation does not affect that read. Table iteration can be stable for given contents without providing an ownership guarantee.

In `storage/node.nim`, master's `streamEntireDataset` created a download but passed the node-wide store to the reader. The construction excerpt omits logging, monitoring tasks, and the final return:

```nim
proc streamEntireDataset(
    self: StorageNodeRef, md: ManifestDescriptor, fetchLocal: bool = false
): Future[?!LPStream] {.async: (raises: [CancelledError]).} =
  let
    download = ?self.engine.startTreeDownloadOpaque(md, fetchLocal = fetchLocal)
    stream = LPStream(StoreStream.new(self.networkStore, md.manifest, pad = false))
  # Monitor this download and the stream; return the stream.
```

The initial integration introduced the binding below, which the review deliberately retains:

```nim
proc streamEntireDataset(
    self: StorageNodeRef,
    md: ManifestDescriptor,
    fetchLocal: bool = false,
    transport: DownloadTransport = DownloadTransport.Direct,
): Future[?!LPStream] {.async: (raises: [CancelledError]).} =
  let
    download = ?self.engine.startTreeDownloadOpaque(
      md, fetchLocal = fetchLocal, transport = transport
    )
    downloadStore = NetworkStore.new(
      self.engine, self.networkStore.localStore, downloadId = some(download.downloadId)
    )
    stream = LPStream(StoreStream.new(downloadStore, md.manifest, pad = false))
  # Monitor this download and the stream; return the stream.
```

The corresponding selection in `storage/stores/networkstore.nim` is below. Master used only the tree-CID lookup now shown in the `else` branch. The remainder obtains the selected download's handle, checks local storage, and awaits that handle only if the block is missing:

```nim
method getBlock*(
    self: NetworkStore, address: BlockAddress
): Future[?!Block] {.async: (raises: [CancelledError]).} =
  let downloadOpt =
    if self.downloadId.isSome:
      self.engine.downloadManager.getDownload(self.downloadId.get(), address.treeCid)
    else:
      self.engine.downloadManager.getDownload(address.treeCid)
  # Existing local lookup and handle-completion/waiting code omitted.
```

## Concurrent downloads and duplicate storage

During this review we also found an existing CacheStore duplicate-insert accounting bug: replacing a CID increases `currentSize` again and can cause premature eviction. Normal nodes use RepoStore, but tests use CacheStore. The follow-up is recorded in [[Mix Transport Logos Storage Integration - Validation and Open Questions#CacheStore duplicate-insert accounting — follow-up]]. No fix is included in the integration review.

Master's manager creates a new ID on every `startDownload` call. Foreground streaming requests do not coalesce by tree CID. The background-download entry point separately checks for an existing background operation and returns its ID. The integration adds transport matching to that background lookup; it does not introduce foreground duplication.

Two Direct downloads and a Direct/Mix pair both share local storage, while retaining independent schedulers, pending requests, and block handles. Workers check the local store before issuing batches, so already-stored blocks may avoid later transfers. Requests already in flight can still duplicate transfer and validation work.

The unchanged RepoStore path keys blocks by CID and leaf metadata by `(treeCid, index)`. Block deliveries are validated before storage. Existing blocks are reported as `AlreadyInStore`, and existing leaf metadata is retained. Quota/block-count increments occur for new blocks, and reference-count increments for new leaf metadata. The backend `modifyGet` implementations provide locking or version-checked updates. These are storage mechanisms shared by both concurrency cases, not special Mix behavior.

This does not prove all failure interleavings safe. Block insertion and proof insertion are separate awaited operations; the existing engine attempts block deletion if proof storage fails. Crash/failure recovery and interactions with deletion require their own review, and are unchanged by reader binding. No storage redesign is included here.

Shared cached content has no transport provenance: a Mix reader may consume bytes already cached by a Direct operation, and vice versa. Transport selection controls network requests, not a private cache. Coalescing Direct and Mix downloads into one operation could violate the chosen network mode; even same-mode coalescing would need shared ownership and cancellation rules rather than an unconditional reuse by CID.

## Remaining changes to review individually

- Callback/future construction; the mounted dispatcher and protocol connection handling are already accepted.
- Provider bookkeeping, discovery keys, and periodic maintenance overhead.
- REST transport selection and other integration boundaries.

For each item, record the master behavior, the changed behavior, motivation, possible benefit, downside, decision for Direct, decision for Mix, and any measured results. Keep implementation walkthroughs focused on the code that actually exists; keep proposed policies and benchmark findings in this note or the linked validation note.
