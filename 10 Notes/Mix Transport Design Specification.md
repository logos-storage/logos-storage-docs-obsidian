---
related:
  - "[[Mix Transport Implementation Walk Through]]"
  - "[[Mix Transport SURB Replenishment Strategy]]"
  - "[[Mix Transport - Pluggable Integration Model]]"
  - "[[Mix Transport Logos Storage Integration - Download Transport Selection]]"
  - "[[Mix Transport Documentation Maintenance]]"
---
# Mix Transport Design Specification

## Abstract

MixTransport defines a session and multiplexed byte-stream protocol over the anonymous packet service provided by the [Mix Protocol](https://lip.logos.co/anoncomms/raw/mix.html). An initiator addresses a known destination. The destination replies through single-use reply blocks supplied by the initiator, without learning an initiator network address from the transport handshake. Both endpoints can open application streams within an established session.

This specification describes transport frame version **3**, carried under the Mix service codec `/libp2p/mix-transport/1.0.0`. The codec suffix and envelope version are distinct identifiers. It defines the framing and endpoint behavior of the reference implementation, with local policy defaults identified separately. It is not a specification of Sphinx cryptography or a claim of unconditional delivery or anonymity.

## 1. Scope and Requirements Language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** express protocol requirements in this document. Requirements on transmitted frames apply to a conforming sender; receive-side validation and discard behavior are described separately. Implementation-specific APIs and task structure are explained in [[Mix Transport Implementation Walk Through]].

MixTransport provides session establishment, stream admission, byte ordering, duplicate suppression, acknowledgements, bounded per-stream flow control, SURB replenishment, and remote teardown notifications. It does not select content providers, define application messages, or decide whether an application should use anonymous transport. [[Mix Transport Logos Storage Integration - Download Transport Selection]] describes these consumer responsibilities for Logos Storage.

Mix supplies Sphinx routing, packet processing, public SURB creation and use, and private reply recovery. MixTransport does not replace these mechanisms or bypass Mix's intentional delays.

## 2. Terminology

**Session initiator:** the endpoint creating a session. It knows the destination's real libp2p peer identity and Mix destination information.

**Session recipient:** the destination accepting that session. It knows the initiator by a session pseudonym, not by an address usable for a new forward connection.

**Session pseudonym (`sessionId`):** an initiator-generated random value represented as a valid libp2p `PeerId`. Both endpoints include it in transport frames. It is not proof of ownership of an authenticated libp2p identity.

**Forward frame:** a frame from initiator to recipient, delivered as a Mix service payload. **Reverse frame:** a frame from recipient to initiator, delivered through a SURB. These directions do not change when the recipient opens a stream.

**Stream opener / acceptor:** the endpoint requesting a particular stream and the endpoint admitting it. Either session role can be the opener.

**Public SURB:** a single-use reply block created by the initiator and given to the recipient. **Reply credential:** the corresponding private recovery material, retained only by the initiator.

**Redundancy batch:** the SURBs selected for redundant copies of one reverse frame. It exists only during transmission and has no wire identifier or persistent group representation. The reference profile uses two SURBs per batch.

**Supply sequence:** a session-wide number identifying one public SURB supplied to the recipient's bounded queue. It is independent of stream Data sequences.

**Receive base:** the beginning of an acknowledgement window. For Data, it is the next sequence not yet delivered into the ordered application-facing buffer. For supply, it is the first sequence not yet received in the contiguous prefix.

## 3. Architecture and Identity

### 3.1 Mix service boundary

The application destination is the final Mix node: exit equals destination. That node dispatches the opaque payload to MixTransport's service handler. There is no external exit-to-destination connection or application-specific Mix read instruction on this path.

Forward delivery uses the destination's Mix public information. The relay pool supplies intermediate nodes; an explicitly supplied destination need not be enrolled in that pool. Acquisition and validation of destination information are outside this protocol. The address-aware API accepts the representation described in [[Mix Discovery through Provider Records]].

At the initiator, a raw reply identifier selects its private credential. Successful recovery yields a transport frame; its `sessionId` MUST match the session owning the credential before dispatch. An unknown reply identifier may be offered to another Mix consumer. Recognized active or retained retired identifiers are handled by MixTransport rather than falling through to unrelated reply stores.

### 3.2 Application-facing identity

| Endpoint | Application-facing peer identity |
| --- | --- |
| Initiator | Real destination `PeerId` |
| Recipient | Session pseudonym `sessionId` |

The recipient MUST NOT pass the pseudonym to ordinary `Switch.connect` or `Switch.dial`. It MAY use the pseudonym with MixTransport to find the existing session and open another stream. It cannot establish a new session to the otherwise unknown initiator.

The pseudonym remains stable for the session lifetime. Stream closure does not change it. A fresh initiator session uses a fresh pseudonym. Streams share session identity and return capacity; the protocol does not provide unlinkability between streams within a session.

## 4. Wire Representation

### 4.1 Envelope

Each frame is a Protobuf message within one Mix service payload. Required envelope fields MUST be present, and `version` MUST be `3`. Unsupported versions, malformed Protobuf, oversized frames, and invalid combinations of known fields are discarded before frame handling.

| Number | Name | Protobuf representation | Meaning |
| --- | --- | --- | --- |
| 1 | `version` | required uint32 varint | Transport envelope version |
| 2 | `sessionId` | required bytes | Binary `PeerId`, nonempty, at most 39 bytes |
| 3 | `kind` | required enum varint | Frame kind from §4.2 |
| 4 | `streamId` | optional fixed32 | Nonzero virtual-stream identifier |
| 5 | `sequence` | optional fixed32 | Data sequence |
| 6 | `payload` | optional bytes | Nonempty Data chunk |
| 7 | `codec` | optional string | Application protocol, nonempty, at most 255 bytes |
| 8 | `receiveBase` | optional fixed32 | Data acknowledgement base |
| 9 | `acknowledgementBitmap` | optional bytes | Exactly 32 bytes |
| 10 | `firstSurbSequence` | optional fixed32 | First numbered SURB in this frame |
| 11 | `surbSupplyReceiveBase` | optional fixed32 | Supply acknowledgement base |
| 12 | `surbSupplyAcknowledgementBitmap` | optional bytes | Exactly 32 bytes |
| 13 | `surbSupplyLimit` | optional fixed32 | Exclusive supply credit limit |
| 14 | `surbs` | repeated bytes | Independently serialized public SURBs |
| 15 | `rejectionReason` | optional string | Diagnostic text, at most 255 bytes |
| 16 | `finalSequence` | optional fixed32 | Final Data sequence on graceful close |

Protobuf `fixed32` uses little-endian encoding. Optional-field presence is significant: absence is not interchangeable with an explicitly encoded zero. Both bitmaps number bits least-significant-bit first within each byte: offset `i` uses byte `i div 8` and mask `1 << (i mod 8)`.

### 4.2 Frame kinds and field presence

Every frame requires the three envelope fields. A supply snapshot is the indivisible tuple of fields 11–13: if any is present, all three MUST be present.

| Value | Kind | Required additional fields | Direction and public SURBs |
| --- | --- | --- | --- |
| 1 | `Connect` | — | Forward; 2–5 SURBs; first two for response, suffix numbered |
| 2 | `ConnectAck` | Supply snapshot | Reverse through Connect response SURBs |
| 3 | `OpenStream` | `streamId`, `codec` | Forward: 2–4 SURBs; reverse: none |
| 4 | `StreamAck` | `streamId` | Acceptor to opener |
| 5 | `Data` | `streamId`, `sequence`, `payload` | Either direction; no SURBs |
| 6 | `Ack` | `streamId`, `receiveBase`, `acknowledgementBitmap` | Either direction; no SURBs |
| 7 | `CloseStream` | `streamId`, `finalSequence` | Either direction |
| 8 | `ResetStream` | `streamId` | Either direction |
| 9 | `Disconnect` | — | Either direction |
| 10 | `ResetSession` | — | Either direction |
| 11 | `StreamReject` | `streamId` | Acceptor to opener; optional `rejectionReason` |
| 12 | `SurbSupply` | `firstSurbSequence` | Forward; 1–5 numbered SURBs |
| 13 | `SurbStatusProbe` | — | Forward; sender supplies two response SURBs |
| 14 | `SurbStatus` | Supply snapshot | Reverse through probe response SURBs |

`firstSurbSequence` is also required on `Connect` and forward `OpenStream` when a numbered suffix follows the first two SURBs; otherwise it MUST be absent. Suffix numbering starts after the two unnumbered response entries. In `SurbSupply`, numbering starts with the first entry. A consecutive supply range MUST NOT overflow.

All ordinary reverse frames carry a supply snapshot: `OpenStream`, `StreamAck`, `StreamReject`, `Data`, `Ack`, `CloseStream`, `ResetStream`, `Disconnect`, and `ResetSession`. `ConnectAck` and `SurbStatus` require it in structural validation. For the other eligible kinds, structural validation permits a complete snapshot; the sending path attaches it for the Recipient role. Snapshots are forbidden on `Connect`, `SurbSupply`, and `SurbStatusProbe`.

Other known fields MUST be absent unless assigned to that kind above. The receiver enforces the role-dependent SURB rules for `OpenStream` after session lookup. Probe reception requires at least two SURBs and uses two valid entries; a conforming sender supplies exactly two.

### 4.3 Packet-size bounds

Let `F` be the maximum opaque message size reported by Mix for the transport codec with zero embedded legacy SURBs. The complete encoded frame MUST fit within `F`. Public SURBs use Mix's canonical serialization and count toward that bound.

The maximum Data payload is `F − 102` bytes. The allowance covers the maximum session identifier, fixed stream and Data sequence fields, payload tag and length prefix, and the complete reverse supply snapshot. Both directions use this bound. The encoder independently checks final frame size.

Under the reference Mix packet profile, `Connect` fits five SURBs, `OpenStream` four even at the maximum codec length, and `SurbSupply` five. These are frame capacities, not persistent groups. Shorter codecs do not increase the declared OpenStream limit. A different packet profile must accommodate this version's bounds to interoperate.

The decoder validates frame structure without requiring every SURB to deserialize successfully. Numbered entries are decoded independently so a bad entry does not discard valid neighbors. This does not relax the requirement for a usable dedicated handshake response batch.

## 5. Session Establishment

The initiator creates a Pending session with a fresh pseudonym, retains private reply credentials, and sends `Connect` with two response SURBs and numbered bootstrap supply beginning at sequence zero when included.

The recipient ignores `Connect` for an already registered session ID. For a new session it decodes both dedicated response SURBs, initializes its supply queue, accepts valid numbered suffix entries, and prepares `ConnectAck` with its initial supply snapshot.

The recipient MUST become operational before submitting the first acknowledgement copy. An initiator may receive that copy while another is still being submitted; subsequent frames must find an Established session. Complete failure to submit any acknowledgement copy causes local rollback. Cancellation also terminates the local attempt.

The initiator becomes Established only after recovering a matching `ConnectAck` for its Pending session and applying a valid supply snapshot. Submission of Connect is not confirmation of establishment. Later copies do not repeat the transition.

The reference implementation submits Connect once and uses a configurable timeout. Loss of Connect or all acknowledgement copies fails that attempt. It does not retransmit Connect or re-acknowledge duplicate Connect frames. Session establishment is not a reliable retry protocol in this version.

Repeated local `connect` calls reuse an established session. Concurrent calls for one destination share a transport-owned attempt. A caller can cancel its wait; the attempt is cancelled when its final waiter leaves or transport shutdown cancels all attempts. These are local API semantics, not additional wire exchanges.

## 6. Stream Establishment and Admission

### 6.1 Identifiers

A stream is identified by `(sessionId, streamId)`. The session initiator allocates odd IDs starting at 1; the recipient allocates even IDs starting at 2. IDs are unsigned 32-bit values. Each endpoint MUST allocate monotonically in its own parity and MUST NOT wrap or reuse IDs within a session.

### 6.2 Opening in either direction

The opener registers a Pending stream and sends `OpenStream` with the application codec. An initiator-originated opening includes two dedicated response SURBs and up to two numbered supply entries, subject to available credit. A recipient-originated opening consumes ordinary session SURBs, carries a supply snapshot, and includes no public SURBs. Its response uses the forward path.

The acceptor verifies session state and remote stream-ID parity, records the opening attempt, resolves the codec in its mounted protocol registry, and applies incoming-stream admission limits. Unsupported protocols or exhausted admission return `StreamReject` when a response path is available. Rejection reasons are bounded diagnostics, not machine-readable error codes.

Before sending `StreamAck`, the acceptor MUST register and establish the stream and install Data receive, ACK, retransmission, and teardown handling. After successful response submission it runs the application handler independently of frame delivery. The opener returns an application connection only after `StreamAck`. Rejection, timeout, cancellation, or complete response-submission failure releases the relevant pending resources.

### 6.3 Duplicate and late openings

Removing a stream MUST NOT make its opening ID admissible again. The receiver tracks remote allocation positions `(streamId − 1) div 2` in a 1024-position sliding bitmap. Each attempt is recorded before suspension or protocol admission. An already recorded position, wrong-parity ID, or position below the retained window is discarded without another handler invocation.

Window advancement makes older positions permanently inadmissible, including previously unseen openings delayed beyond the window. Duplicates are discarded rather than re-acknowledged. Late `StreamAck` and `StreamReject` affect only a matching Pending outbound stream. Both session roles use these rules.

## 7. Data Transfer and Flow Control

### 7.1 Byte-stream semantics

Each stream direction has an independent Data sequence starting at 1. Valid Data sequences end at `2^32 − 2`; `2^32 − 1` is reserved as the terminal receive base. Sequences MUST NOT wrap. Application writes are divided into nonempty chunks within §4.3's bound. Concurrent writes on one stream are serialized; write boundaries are not preserved remotely.

Each endpoint retains at most 64 unacknowledged outbound chunks and respects a 256-position remote receive window. With remote base `B`, the exclusive send limit is `min(B + 256, 2^32 − 1)`, calculated without overflow. A new sequence MUST be below that limit and within the valid Data sequence space.

### 7.2 Receive processing

Data is admitted only for an established session and stream. A sequence within `[receiveBase, receiveBase + 256)` is stored once and marked in the bitmap. Data below the base or already marked is a duplicate: it is not delivered twice, but triggers an ACK. Data beyond the receive window is discarded without an ACK.

Only the chunk at the base may enter the ordered application-facing buffer. After insertion completes, the receiver advances the base and shifts the bitmap. A full bounded buffer suspends insertion and stops base advancement. The reference `BufferStream` queue has capacity one; credit means admission to this bounded path, not proof that the application consumed or processed the bytes.

### 7.3 Acknowledgements

An `Ack(B, bitmap)` is an absolute snapshot. Sequences below `B` have entered the ordered buffer; bit `i` acknowledges `B + i` as retained by the receiver. The sender removes corresponding retained chunks. It rejects a base ahead of its next allocated sequence and ignores an older base; another bitmap at the same base can acknowledge additional chunks.

Bitmap acknowledgement does not itself advance receive-window credit: the base controls that credit. Duplicate ACKs do not grant capacity twice. The reference implementation requests ACKs on receive-state changes and duplicates without an intentional batching delay. Changes during a send may be coalesced into subsequent snapshots.

### 7.4 Retransmission and reliability limits

Data retransmission is enabled by default and can be disabled locally. A retained chunk is scheduled after its send attempt completes. A retry uses the same sequence and payload; a reverse retry uses fresh SURBs. ACK processing removes retained entries, and retry completion MUST NOT recreate an entry removed by an ACK.

The reference retry interval is fixed, without a retry-count limit. Stream closure stops retries. Disabling retries does not disable ACK processing, in-flight bounds, or receive-window enforcement.

Failed ACK sends are not independently retried. Duplicate outstanding Data can elicit another ACK. There is no Data-window persist probe: if all outstanding Data has been bitmap-acknowledged and the final base-advancing ACK is lost, a sender can remain blocked. A SURB status probe reports supply credit, not Data-window credit. This version does not guarantee recovery from every loss pattern.

## 8. Reverse Capacity and SURB Replenishment

### 8.1 Session-wide queue and single use

The recipient stores numbered SURBs in one bounded queue shared by all streams. For an ordinary reverse frame it waits for a redundancy batch, removes those entries atomically with respect to other reverse sends, and submits the same encoded frame through each once. The reference implementation awaits submissions sequentially. Success means at least one local submission succeeded, not confirmed remote receipt.

There is no protected control reserve or refill-request frame. Empty ordinary capacity suspends reverse sends until supply arrives. Connect, forward OpenStream, and status-probe responses use their dedicated SURBs instead of the queue.

### 8.2 Numbering, credit, and receipt

Supply numbering starts at zero and ends at `2^32 − 2`. The recipient advertises an exclusive absolute limit `L`. The initiator MUST introduce a new sequence only below both `L` and `surbSupplyReceiveBase + 256`. The initial Connect suffix is a bootstrap exception, sent before the first credit snapshot.

The recipient's queue capacity `C` MUST accommodate the maximum three-SURB bootstrap suffix. Its initial limit is `C`. Removing a queued SURB for use grants one replacement position by increasing the limit, saturating at `2^32 − 1`. Dedicated response SURBs do not occupy the queue and do not grant numbered credit.

For each numbered entry, the recipient checks the credit limit, receipt window, duplicate state, and queue capacity. A valid new entry is queued and marked received. The base advances across the contiguous received prefix, independently of consumption. Unlike the Data bitmap, the supply bitmap records receipt rather than ordered application delivery.

A snapshot carries the base, 32-byte bitmap, and `L`. At the initiator, acknowledgement releases retained public serialization, but NOT the private credential: the recipient may still hold the public SURB. Accepted bases and limits only move forward. A snapshot whose base exceeds allocated supply, or whose limit is below its base, is invalid.

### 8.3 Watermark policy

One supplier task per initiator session allocates new SURBs and repairs outstanding supply. Let `S` be the unallocated positions allowed by the latest credit and receipt window. Projected inventory is `max(0, C − S)`, counting allocated supply as potentially in transit instead of immediately replacing it.

When projection is at or below the low watermark and credit is available, a replenishment cycle starts. It continues until available credit is allocated, using packets of at most five SURBs. Default capacity is 16 and watermark 11. A reverse frame consuming two SURBs therefore does not normally trigger its own two-SURB replacement packet. Batch size still depends on available credit and sequence-window space.

### 8.4 Supply retransmission and credential lifetime

Until receipt is acknowledged, the initiator retains each numbered public serialization and credential identifier. Retransmission sends the same SURB at the same sequence, without creating another credential. Receipt tracking prevents it entering the queue twice even if its first copy has been consumed.

Before retrying, the initiator purges expired credentials and checks the corresponding credential is active. If not, the public entry is discarded rather than retransmitted. No replacement is assigned that old sequence. This version has no explicit supply-gap abandonment exchange; a persistent missing sequence can constrain receipt-window progress. Expiry is not equivalent to acknowledgement or guaranteed recovery of capacity.

### 8.5 Status probes

After a configured interval without a valid reverse snapshot, the initiator sends a forward `SurbStatusProbe` with two fresh dedicated response SURBs. The recipient uses them immediately for `SurbStatus`, even when its ordinary queue is empty. This provides a response path without requiring queue credit.

Unanswered probes are retried at the configured interval using fresh SURBs. Valid reverse activity resets the attempt count and inactivity deadline. After the final attempt, the initiator waits one full retry interval; continued silence removes that session, its streams, and credentials. Other sessions are unaffected. This detects lack of response at the initiator; it does not guarantee the recipient learns of local failure.

## 9. Teardown and Resource Lifetime

`CloseStream` reports the sender's final allocated Data sequence, or zero if it sent none. The receiver records this boundary and closes after its ordered base passes it. Data above an accepted boundary is not admitted. A conflicting boundary cannot replace the recorded one.

`ResetStream` aborts immediately. The application-facing stream distinguishes remote reset from graceful EOF. Higher-level reads such as `readExactly` and `readLp` preserve that distinction through `readOnce`.

Local close stops stream tasks, including retransmission, and makes a best-effort notification. It does not first guarantee acknowledgement of pending outbound chunks. Lost Data before the boundary, or a lost close notification, can prevent remote graceful completion. Close is not a reliable flush or half-close protocol in this version.

Local `Disconnect` requires an idle session. A received Disconnect is remembered while streams remain and completes after their removal, allowing notifications to arrive out of order. `ResetSession` aborts all streams. Unknown-session or unknown-stream teardown frames do not create state.

Teardown notifications are not acknowledged or retransmitted. Reverse teardown does not wait indefinitely for SURBs: without a batch, local cleanup proceeds without notification. Transport shutdown attempts one session reset per detached session, unregisters delivery handlers, and awaits session and stream cleanup. Whole-session teardown suppresses redundant per-stream notifications.

Successful reply recovery consumes the individual private credential. Cryptographic recovery failure preserves an active credential; successful recovery followed by invalid payload decoding consumes it. A bounded retired-identifier set suppresses known repeats. Expiry and session removal release credentials; capacity exhaustion rejects new registration instead of evicting unrelated active credentials.

## 10. Reference Policy Defaults

These defaults are local policy, not fields negotiated in the handshake. Supply limits communicate recipient credit, not timer values. Constructor settings must satisfy their local bounds. Changing wire widths, bitmap lengths, or identifier semantics is not merely a policy adjustment.

| Policy | Default |
| --- | --- |
| Connect / stream-open timeout | 30 seconds each |
| Data retry interval | 30 seconds; enabled |
| Supply retry interval | 30 seconds |
| Reverse inactivity before probing | 2 minutes |
| Probe retry interval / attempts | 30 seconds / 3 |
| Recipient queue capacity | 16 SURBs |
| Replenishment low watermark | 11 SURBs |
| Reply redundancy | 2 |
| Private credential lifetime | 30 minutes |
| Active credentials / retained retired identifiers | 100,000 each |

Per-stream Data state, receipt windows, recipient supply, and credential storage are bounded. The implementation has no global runtime session-count limit. Applications and deployments must account for aggregate resource use and admission limits when exposing protocols to anonymous peers.

## 11. Security and Privacy Considerations

MixTransport inherits Mix's assumptions about routing, delay, replay protection, and adversaries. It does not independently prove sender anonymity, resist arbitrary traffic correlation, or authenticate a pseudonym as a real peer. Establishment demonstrates a return path; it is not a new identity-authentication handshake.

Payloads, codecs, timing, and activity within a session can reveal relationships to the endpoints. Discovery, provider announcements, direct serving, and application identifiers can reveal content interest even when transfer uses Mix. Consumers MUST NOT treat Mix selection as automatic private discovery or private storage, and must not silently fall back to a direct application connection when anonymity is required.

The destination is the Mix exit, so no additional external exit receives the plaintext for forwarding. Nevertheless, MixTransport adds no independent end-to-end key exchange or authentication above Mix. Destination-record authenticity and freshness remain responsibilities of the surrounding discovery and identity system.

Private reply credentials MUST remain at the initiator. Public SURBs MUST NOT be used for multiple reply submissions. Mix packet replay protection, credential consumption, stream-opening history, Data sequences, and supply sequences handle duplication at different layers. None alone provides a global denial-of-service defense; resource limits, protocol admission, and underlying Mix abuse controls remain necessary.

## 12. Related Documents

- [Mix Protocol specification](https://lip.logos.co/anoncomms/raw/mix.html): packet service and security model.
- [[Mix Transport - Pluggable Integration Model]]: service and reply-handler integration.
- [[Mix Transport Implementation Walk Through]]: implementation map and contextual code examples.
- [[Mix Transport SURB Replenishment Strategy]]: rationale and supply examples.
- [[Mix Transport Logos Storage Integration - Download Transport Selection]]: consumer transport selection and lifecycle.
- [[Mix Transport Documentation Maintenance]]: baseline and maintenance record, outside the protocol contract.
