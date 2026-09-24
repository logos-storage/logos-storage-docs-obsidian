---
related:
  - "[[Mix Transport Implementation Walk Through]]"
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through - Reply Credential Store]]"
  - "[[Mix Transport SURB Replenishment Strategy]]"
  - "[[Mix Transport Implementation Walk Through - SURB Replenishment]]"
---
This note describes the transport-owned registry used by the `Connect` handshake, virtual streams and session-level SURB supply. `SessionStore` provides both the frame-routing lookup by pseudonym and the `connect(destination)` reuse lookup by real destination.

The implementation is in `libp2p_mix_transport/sessions.nim`.

## What a Transport Session Represents

A `TransportSession` represents a long-lived relationship between two MixTransport endpoints. Once the session is established, the endpoints can open multiple virtual streams through it. Closing one of those streams does not close the session; the session remains available until MixTransport explicitly drops the peer.

Each session has a random `sessionId` represented as a valid libp2p `PeerId`. The initiator generates this identifier before sending `Connect`. Both endpoints then include the same `sessionId` in transport frames so that an incoming frame can be routed to the correct local session.

Although `sessionId` has the `PeerId` type, it is a session pseudonym rather than the initiator's authenticated libp2p identity. The recipient learns this pseudonym through Mix. The handshake does not disclose the initiator’s real peer identity; this is not a guarantee against information disclosed by the application or inferred from traffic.

## What Each Endpoint Knows

The two endpoints store different information because they have different views of the anonymous connection.

On the initiator:

- `destination` is the real `PeerId` of the remote Mix node selected by the initiator.
- `sessionId` is the random pseudonym generated for the transport session.
- `peerId` returns `destination`, because higher-level protocols on the initiator already know which remote node they asked MixTransport to connect to.

On the recipient:

- `destination` is absent because this field would have to identify the anonymous initiator, whose authenticated `PeerId` is not revealed by Mix.
- `sessionId` is the pseudonym received in the initiator's `Connect` frame.
- `peerId` returns `sessionId`, because the pseudonym is the only peer identifier that the recipient can expose to higher-level protocols for this session.

This distinction lets higher-level protocols use a `PeerId` on both endpoints without claiming that the recipient has learned the initiator's real identity. The recipient must therefore treat the pseudonym as local transport identity only. It must not pass it to `Switch.connect`, `Switch.dial`, or an ordinary libp2p peer store, because those APIs expect an authenticated libp2p identity.

## Role and Establishment State

Every session records a role and an establishment state:

```nim
SessionRole = Initiator | Recipient
SessionState = Pending | Established | Closed
```

The role records which endpoint created the local session state. An initiator session was created by the endpoint that started the handshake. A recipient session was created by the endpoint that received the corresponding `Connect` frame.

Both roles initially use `Pending`, but the state has a different immediate meaning on each endpoint. On the initiator, `Pending` means that `Connect` has not yet produced a valid `ConnectAck`. On the recipient, it means that the incoming `Connect` is being validated and its acknowledgement is being prepared. The recipient calls `establish` immediately before submitting `ConnectAck`, so the recipient can process session traffic as soon as the first redundant acknowledgement reaches the initiator. The initiator calls `establish` after recovering a valid matching acknowledgement.

`Established` means that the transport relationship is ready to carry virtual streams. The state belongs to `TransportSession` because it describes the relationship between the two transport endpoints, rather than the lifetime of any individual stream opened through that relationship.

The type keeps the state that must survive individual stream operations:

```nim
TransportSession* = ref object
  sessionId: PeerId
  destination: Opt[PeerId]
  role: SessionRole
  state: SessionState
  established: AsyncEvent
  receivedSurbs: Deque[SURB]
  recipientSurbCapacity: int
  surbSupplyInitialized: bool
  surbSupplyReceiveBase: SurbSupplySequence
  surbSupplyAcknowledgementBitmap: seq[byte]
  surbSupplyLimit: SurbSupplySequence
  replyCapacityStateChanged: AsyncEvent
  replySendLock: AsyncLock
  remoteSurbSupplyReceiveBase: SurbSupplySequence
  remoteSurbSupplyLimit: SurbSupplySequence
  nextSurbSupplySequence: Opt[SurbSupplySequence]
  pendingSurbSupply: Table[SurbSupplySequence, PendingSurbSupply]
  surbSupplyStateChanged: AsyncEvent
  surbSupplierTask: Future[void].Raising([CancelledError])
  nextSurbStatusProbeAt: Opt[Moment]
  unansweredSurbStatusProbes: int
  streams: Table[StreamId, TransportStream]
  nextOutboundStreamId: Opt[StreamId]
```

The `established` event is how `connect` waits for `ConnectAck` without polling. The recipient-side fields store a bounded queue of public SURBs, a receive base and bitmap that suppress duplicate numbered supply, and an absolute supply limit that grants replacement credit when the recipient consumes a SURB.

The initiator-side fields record the recipient's latest supply snapshot, the next unused supply sequence, retained public serializations awaiting acknowledgement and the task that creates or retransmits supply. `nextSurbStatusProbeAt` and `unansweredSurbStatusProbes` bound the time for which the initiator keeps a session that produces no valid reverse response. The stream table routes a frame carrying `streamId` after the session has first been selected by `sessionId`.

## How Sessions Are Found

`SessionStore` keeps two tables because the transport needs to answer two different questions:

```text
bySessionId:   session pseudonym -> local TransportSession
byDestination: real destination -> local initiator TransportSession
```

The first table is used when a transport frame arrives. Every frame carries a `sessionId`, so MixTransport looks up that pseudonym in `bySessionId` to find the local session that should process the frame. Both initiator and recipient sessions are stored in this table because both endpoints receive frames carrying the session pseudonym.

The second table is used when the local application asks MixTransport to connect to a destination. For an initiator session, the store maps the destination's real `PeerId` to the existing session. A later `connect(destination)` call can therefore reuse that session instead of creating a second session with a new pseudonym.

The two lookup operations make that distinction explicit:

```nim
proc get*(store: SessionStore, sessionId: PeerId): Opt[TransportSession] =
  store.bySessionId.withValue(sessionId, session):
    return Opt.some(session[])
  Opt.none(TransportSession)

proc getByDestination*(
    store: SessionStore, destination: PeerId
): Opt[TransportSession] =
  store.byDestination.withValue(destination, session):
    return Opt.some(session[])
  Opt.none(TransportSession)
```

For example, `handleReplyFrame` calls `get(frame.sessionId)` because the sender placed the pseudonym in the frame. In contrast, `connect(destination)` calls `getByDestination(destination)` because its caller knows the real node it wants to reach.

Recipient sessions are not stored in `byDestination`. The recipient does not know the anonymous initiator's authenticated `PeerId`, so it has no real destination value that could serve as a key in this table. Incoming frames find it through `sessionId`. Local `connect` and `dial` calls can also use that pseudonym to reuse the established session, as described in [[Mix Transport Implementation Walk Through - Recipient-Originated Streams]].

## Adding a Session Without Leaving Partial State

`addInitiatorSession(destination, sessionId)` must add one session to both tables. Before changing either table, it checks that:

- `destination` and `sessionId` are not empty;
- `byDestination` does not already contain a session for `destination`; and
- `bySessionId` does not already contain a session for `sessionId`.

Only after all checks succeed does the function create the `TransportSession` and insert the same object into both tables. If either identifier is already in use, the function returns an error before performing either insertion. This prevents a failed registration from leaving one table changed while the other still describes the previous state, and it preserves the session that was registered first.

The successful registration ends with both keys referring to the same `ref object`:

```nim
let session = TransportSession(
  sessionId: sessionId,
  destination: Opt.some(destination),
  role: SessionRole.Initiator,
  state: SessionState.Pending,
  established: newAsyncEvent(),
  receivedSurbs: initDeque[SURB](),
  recipientSurbCapacity: store.recipientSurbCapacity,
  surbSupplyAcknowledgementBitmap: newSeq[byte](SurbSupplyAckBitmapBytes),
  replyCapacityStateChanged: newAsyncEvent(),
  replySendLock: newAsyncLock(),
  nextSurbSupplySequence: Opt.some(SurbSupplySequence(0)),
  pendingSurbSupply: initTable[SurbSupplySequence, PendingSurbSupply](),
  surbSupplyStateChanged: newAsyncEvent(),
  streams: initTable[StreamId, TransportStream](),
  nextOutboundStreamId: Opt.some(StreamId(1)),
)
store.bySessionId[sessionId] = session
store.byDestination[destination] = session
```

The recipient constructor uses the same session-owned resources, but stores `destination: Opt.none(PeerId)`, uses role `Recipient`, starts outbound stream allocation at `2`, and inserts the session only into `bySessionId`.

`addRecipientSession(sessionId)` changes only `bySessionId`. It rejects an empty pseudonym or one that is already registered, then creates a pending recipient session. It does not accept a destination because the recipient has no authenticated identity for the anonymous initiator.

## Establishing and Removing a Session

`establish(session)` changes the session state from `Pending` to `Established`. It does not move the session or change either lookup table, so the same session remains reachable by all identifiers under which it was registered.

`remove(sessionId)` begins with the lookup available on both endpoints: the session pseudonym. If no session has that pseudonym, it returns `none` and changes nothing.

When it finds an initiator session, it removes the entry from `bySessionId` and also removes the entry keyed by the real destination from `byDestination`. When it finds a recipient session, it removes only the `bySessionId` entry because no destination entry exists for that role. The function returns the removed session so that later teardown code can cancel its tasks and release the resources attached to it.

Calling `remove` again with the same `sessionId` is harmless: the first call has already removed the session, so the second call returns `none`.

`MixTransport` owns one `SessionStore`. A current `TransportSession` owns its stream table, individual received SURBs, numbered supply state, supplier task, reply-capacity event and per-session reply-send lock. Per-stream Data retransmission payloads and tasks live in each `TransportStream`. During shutdown, `stop` detaches the sessions and waits for each session to cancel its supplier and shut down its streams before clearing reply credentials. `Disconnect` closes an idle session, while `ResetSession` aborts its streams; [[Mix Transport Implementation Walk Through - Remote Teardown]] follows these paths.


## How the Handshake Uses the Registry

The `Connect` handshake uses these operations directly. The initiating MixTransport generates a fresh session pseudonym and calls `addInitiatorSession(destination, sessionId)` before sending `Connect`. Keeping the session in `Pending` state gives the returning `ConnectAck` handler a stable object to find through the `sessionId` carried by the acknowledgement.

The recipient's `Connect` handler reads the pseudonym from the frame and calls `addRecipientSession(sessionId)`. It decodes the first two public SURBs as dedicated response paths, initializes numbered supply, accepts valid suffix entries into the session queue, and prepares `ConnectAck` and marks the recipient session established before sending the first redundant acknowledgement copy. The initiator can therefore act on an acknowledgement without racing the recipient's state transition.

The relevant order is:

```nim
var replyBatch = newSeqOfCap[SURB](DefaultReplySurbRedundancy)
for index in 0 ..< DefaultReplySurbRedundancy:
  let surb = frame.surbs[index].deserializeSurb().valueOr:
    return
  replyBatch.add(surb)
let session = self.sessions.addRecipientSession(frame.sessionId).valueOr:
  error "error registering session", error = error
  return

var keepSession = false
defer:
  if not keepSession:
    discard self.sessions.remove(frame.sessionId)

session.initializeSurbSupply().isOkOr:
  return
if frame.surbs.len > DefaultReplySurbRedundancy:
  let firstSequence = frame.firstSurbSequence.get()
  for index in DefaultReplySurbRedundancy ..< frame.surbs.len:
    let surb = frame.surbs[index].deserializeSurb().valueOr:
      continue
    let sequence =
      firstSequence + SurbSupplySequence(index - DefaultReplySurbRedundancy)
    discard session.acceptSurbSupply(sequence, surb)
var acknowledgement = MixTransportFrame(
  version: MixTransportVersion, sessionId: frame.sessionId, kind: FrameKind.ConnectAck
)
session.attachSurbSupplySnapshot(acknowledgement)
let payload = acknowledgement.encode().valueOr:
  return

# Marks the session as established BEFORE sending out ACKs
# or the other side might try to use it before it's ready
# and have its frames dropped.
session.establish()
(await self.sendWithSurbRedundancyBatch(replyBatch, payload)).isOkOr:
  return

keepSession = true
```

This order matters because `sendWithSurbRedundancyBatch` awaits the redundant sends sequentially. The first copy may reach the initiator while the recipient is still submitting the remaining copies. Establishing the recipient session first guarantees that an immediate `OpenStream` or Data frame is not discarded as traffic for a pending session.

If every copy fails, `sendWithSurbRedundancyBatch` returns an error and the deferred cleanup removes the session. If cancellation interrupts acknowledgement submission, the same cleanup removes the session because cancellation explicitly ends the local handshake, regardless of whether an earlier copy escaped. If submission completes with at least one successful copy, `keepSession` preserves the established state needed to process the traffic that the acknowledgement authorized.

When the initiator recovers and validates `ConnectAck`, it looks up the pending session by `sessionId`, applies the initial supply snapshot, marks that same object established and starts its supplier task. A later `connect(destination)` call finds the session through `byDestination` and returns the existing object instead of starting another handshake. The complete exchange is described in [[Mix Transport Implementation Walk Through - Connect Handshake]], and the session-owned supply state is described in [[Mix Transport Implementation Walk Through - SURB Replenishment]].
