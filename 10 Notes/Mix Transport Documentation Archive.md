---
related:
  - "[[Mix Transport Documentation Maintenance]]"
---
# Mix Transport Documentation Archive

This is a historical archive of test descriptions and proposals separated from current walkthroughs on 24 September 2026. They are retained for development context, not as current validation claims or integration instructions. Some refer to superseded APIs, earlier tests or previously unfinished work. Follow [[Mix Transport Documentation Maintenance]] for the reference baseline and current documentation map.

## Mix Transport Implementation Walk Through - Wire Format Foundation — Tests

`tests/test_wire.nim` verifies:

- Data preserves session, stream, sequence and payload across a Protobuf round trip.
- ACK preserves `receiveBase` and the fixed bitmap, while a 31-byte bitmap is rejected when 32 bytes are required.
- Numbered supply preserves its first sequence and individual public SURBs.
- A supply snapshot preserves its fixed receive base, 32-byte bitmap and absolute limit, while an incomplete or incorrectly sized snapshot is rejected.
- Individual SURBs agree with Mix's canonical `serializeSurb` and `deserializeSurb` boundary.
- Fields that contradict `kind` are rejected.
- Stream rejection preserves its diagnostic reason and also permits the defined no-reason fallback case.
- Unsupported versions, oversized frames, malformed Protobuf and incomplete Protobuf are rejected.

The live component test creates cryptographically valid SURBs and exercises initiator-driven supply, Data and ACK through a real five-node Mix path. The wire unit tests stay focused on the serialization and validation boundary.

## Mix Transport Implementation Walk Through - Reply Credential Store — Tests

The focused tests create real Mix `ReplyCredential` values by generating a minimal one-hop return path and calling `createSURB`. To exercise successful recovery, the helper builds a normal empty-codec Mix reply, pads it to the fixed Sphinx message size with `addPadding`, sends it through the SURB with `useSURB`, processes the return hop and passes the resulting `RawSurbReply` to the store. This path avoids constructing opaque credentials by assigning their private cryptographic fields.

The tests establish the essential behavior:

- consuming one credential leaves other independently registered credentials active;
- a full store rejects a new atomic addition while preserving active credentials;
- retired identifiers are independently bounded, become semantically inactive at their deadline and remain stored until an explicit purge;
- removing one session retires its active identifiers while preserving another session's credentials;
- an expired credential is invisible before `purgeExpired` removes its table entry;
- an unknown identifier remains available to Mix's embedded fallback path;
- every successfully recovered redundant copy consumes only its matching credential;
- Sphinx corruption retains the matching credential for a potentially valid later packet;
- a cryptographically recovered but malformed Mix payload consumes only the matching credential.

`MixTransport` owns one `ReplyCredentialStore`, clears the store during shutdown and uses it from the registered raw-reply callback. Recovered bytes are decoded as a `MixTransportFrame`, and the frame's `sessionId` must match `StoredReplyCredential.sessionId` before the frame is dispatched to the live session.

## Mix Transport Implementation Walk Through - Session Registry — What the Tests Demonstrate

The first test creates an initiator session and verifies both views of its identity. Looking it up by `sessionId` returns the session used to route transport frames, while looking it up by the real destination returns the same object used to satisfy future `connect(destination)` calls. The test also calls `establish` and verifies the transition from `Pending` to `Established`.

The second test creates a recipient session. It verifies that the destination is absent, that `peerId` exposes the session pseudonym, and that the session can be found by `sessionId` but not through the destination table.

The third test first registers an initiator session. It then tries to reuse that destination with another pseudonym and to reuse that pseudonym for a recipient session. Both operations must fail, the store must still contain exactly one session, and both lookups must still return the original object. This test protects the rule that a rejected registration cannot partially modify the store or replace an established mapping.

The fourth test removes an initiator session by its `sessionId`. It verifies that the session disappears from both tables and that repeating the removal returns `none` without changing any other state.

The supply tests exercise state that is also owned by the session. The recipient test initializes a six-SURB capacity, accepts numbered SURBs out of order, verifies that a duplicate does not enter the queue twice and checks that consuming two SURBs advances the absolute supply limit by exactly two. The initiator test applies a snapshot, registers supply up to its credit, acknowledges a contiguous prefix and one later bitmap position, and verifies that only the missing serialization remains pending. A retransmission test schedules deadlines, takes the earliest due serialization and verifies that a later snapshot removes retained entries even when they have retry deadlines.

## Mix Transport Implementation Walk Through - Connect Handshake — End-to-End Test

`tests/test_connect.nim` creates five real MixProtocol nodes. Five nodes provide enough candidates for the three-node forward path while excluding the selected destination where required, and enough candidates for the return paths encoded in the SURBs.

Every node mounts MixProtocol on a TCP libp2p switch and knows the other nodes' `MixPubInfo`. The test starts MixTransport on the first and last nodes, then calls `connect` from the first transport using the last node's real `PeerId`.

Success exercises the complete path:

```text
initiator MixTransport
  -> Connect encoded as Protobuf
  -> MixProtocol.send
  -> three-hop forward Sphinx path
  -> recipient MixTransport delivery handler
  -> ConnectAck through two public SURBs
  -> return Sphinx paths
  -> initiator raw reply handler
  -> credential recovery
  -> pending session becomes established
```

The test verifies that the returned session has the initiator role, is established and exposes the real destination as its consumer-facing `peerId`. It then calls `connect` again with the same destination and verifies that MixTransport returns the identical `TransportSession` rather than generating a new pseudonym or sending another handshake. Before opening a stream, the test waits until initiator-driven numbered supply fills the recipient's advertised capacity. The test also observes redundant raw replies and verifies that each independent credential recovers its copy while only the first copy of a logical acknowledgement changes session or stream state.

## Mix Transport Implementation Walk Through - Virtual Stream Registry — Tests

`tests/test_streams.nim` verifies that:

- the session initiator allocates odd IDs while the recipient allocates even IDs;
- multiple locally opened streams receive distinct sequential identifiers;
- an inbound stream keeps the exact identifier chosen by its remote opener;
- an endpoint rejects inbound IDs from its own allocation space, identifier zero, and duplicate IDs;
- streams cannot be created before their transport session is established;
- removing a stream leaves its established session available.

## Mix Transport Implementation Walk Through - Stream Establishment Round Trip — Component Test

`tests/test_connect.nim` starts five real Mix nodes with deterministic zero relay delay. The first and last nodes run `MixTransport`; the three middle nodes provide the Mix paths. The test performs `Connect`, reuses the established session, and then calls `dial` for a test codec.

The destination Switch mounts the test codec before `dial` is called. After the first `dial` returns, the test verifies that the initiator and recipient hold the same session ID, stream ID and codec, and that both streams are established with the expected local directions. The same test now proceeds through a request and response using the ordinary connection API.

The test then calls `dial` with a codec that is not mounted at the destination. It verifies that the call returns `requested protocol is not supported`, the reason provided by the destination, and that neither endpoint retains the rejected stream. The wire test separately verifies that a rejection without a reason still encodes and decodes, allowing the receiving transport to apply its unknown-reason fallback. Finally, the component test waits for both redundant `ConnectAck` replies, both redundant `StreamAck` replies, and both redundant `StreamReject` replies. This explicit synchronization ensures that teardown begins only after every expected return packet has passed through the raw reply handler.

## Mix Transport Implementation Walk Through - Application Connection and Protocol Dispatch — Component Test

The five-node component test mounts a protocol whose handler reports the stream and selected codec through an `AsyncQueue`, reads a length-prefixed request from the virtual connection, writes a length-prefixed response, and then waits on an `AsyncEvent` so that it remains active while the test inspects the connection. Queues, connection reads and the event provide explicit synchronization rather than sleeps.

After `dial` receives `StreamAck`, the test verifies that the mounted handler was invoked with the exact recipient-side `TransportStream`, not a separate wrapper. It verifies the codec and peer-identity rules, then exchanges application bytes in both directions through `writeLp` and `readLp`. During teardown, cancelling the waiting handler exercises the tracked-task cleanup path.

## Mix Transport Implementation Walk Through - Bounded Data Flow — The Tests as an Executable Walkthrough

The tests cover the flow at three different boundaries. `tests/test_streams.nim` tests receive-window state without a live Mix network. `tests/test_wire.nim` tests the Protobuf representation accepted by both endpoints. `tests/test_connect.nim` runs the application-visible exchange through five live Mix nodes.

The test named `the acknowledgement bitmap retains and orders received chunks` creates one established inbound stream and calls `receiveData` directly. The test inserts sequence `2` before sequence `1`. Because `pendingInbound` does not yet contain the current `receiveBase`, `takeNextInbound` must return `none`. After sequence `1` arrives, the test verifies that a repeated sequence `2` is classified as a duplicate and that both original payloads are delivered in order:

```nim
test "the acknowledgement bitmap retains and orders received chunks":
  # Session and stream construction omitted from this excerpt.
  check:
    stream.receiveData(2, @[2'u8]) == InboundDataDisposition.Accepted
    stream.takeNextInbound().isNone
    stream.receiveData(1, @[1'u8]) == InboundDataDisposition.Accepted
    stream.receiveData(2, @[2'u8]) == InboundDataDisposition.Duplicate

  var first = stream.takeNextInbound().expect("sequence 1 was not ready")
  stream.advanceReceiveWindow(first.sequence)
  var second = stream.takeNextInbound().expect("sequence 2 was not ready")
  stream.advanceReceiveWindow(second.sequence)

  check:
    stream.receiveBase == 3
    stream.pendingInboundCount == 0
```

The test named `acknowledgement bitmap has the fixed receive-window size` constructs an `Ack` frame, encodes and decodes it, and compares the decoded base and bitmap with the original values. It then replaces the bitmap with a value one byte shorter than `AckBitmapBytes` and verifies that frame validation rejects it:

```nim
test "acknowledgement bitmap has the fixed receive-window size":
  # Valid frame construction and round trip omitted from this excerpt.
  var wrongSize = frame
  wrongSize.acknowledgementBitmap = Opt.some(newSeq[byte](AckBitmapBytes - 1))
  check wrongSize.encode().isErr
```

The component test in `tests/test_connect.nim` starts an initiator-side `MixTransport`, a recipient-side `MixTransport` and the five-node live Mix overlay between them. After the `Connect` and `OpenStream` round trips complete, the initiator writes a length-prefixed request through the standard libp2p connection API:

```nim
await initiatorStream.writeLp(TestRequest)
```

On the recipient, the mounted protocol handler receives the established inbound `TransportStream`. The handler reads the request from that stream and writes a response through the same connection object:

```nim
let request = await stream.readLp(1024)
await requests.put(request)
await stream.writeLp(TestResponse)
```

The response is divided into transport Data frames. For each frame, the recipient forms a temporary redundancy batch from its queue of individual SURBs and sends the frame through every SURB in that batch. The initiator reorders the recovered frames, feeds the reconstructed bytes into its `BufferStream`, and completes the pending `readLp`:

```nim
let receivedResponseFuture = initiatorStream.readLp(1024)
if not await receivedResponseFuture.withTimeout(TestOperationTimeout):
  raise newException(LPError, "initiator did not receive stream response")
let receivedResponse = await receivedResponseFuture
```

This exchange exercises both directions explicitly. Initiator Data travels through forward Mix delivery, and the recipient returns its ACK through a temporary batch of individual SURBs. Recipient Data travels through another temporary SURB batch, and the initiator returns its ACK through forward Mix delivery. Before the stream opens, the test waits for initiator-driven numbered supply to fill the recipient's advertised capacity. `TestOperationTimeout` is a failure guard for operations that never complete; successful synchronization comes from transport handshakes, queue notifications and stream reads rather than fixed sleeps.

After the request and response have completed, the same live test closes the initiator stream and waits on the recipient stream's `join` future. It then calls `disconnect` and waits for the recipient session's `closedEvent`. The test therefore verifies that the bounded Data path hands control to graceful stream and session teardown without relying on fixture shutdown.

## Mix Transport Implementation Walk Through - SURB Replenishment — 13. What the Tests Establish

`tests/test_wire.nim` verifies the physical frame capacities using raw Protobuf lengths. `Connect` fits five SURBs, a maximum-length `OpenStream` fits four, and a dedicated `SurbSupply` frame fits five; adding one SURB to any of these full frames exceeds `MaxTransportFrameBytes`. The same tests verify that the first two handshake SURBs remain the unnumbered response batch and that any suffix has numbered-supply metadata.

`tests/test_sessions.nim` verifies the bounded queue and sequence rules directly. The Connect bootstrap test registers three initial sequences before credit exists, applies a snapshot with receive base three and supply limit sixteen, and verifies that the projected inventory begins at three. After allocating the remaining thirteen positions, the projection reaches sixteen. A snapshot granting two replacement positions lowers the projection to fourteen and does not cross the default watermark. A later snapshot grants five positions, lowers the projection to eleven and makes a replenishment cycle due. The status-probe test verifies that attempts advance their deadline and that valid reverse activity resets the counter.

`tests/test_lifecycle.nim` verifies that the default watermark equals recipient capacity minus one full `SurbSupply` packet and that the constructor accepts an explicit watermark for deployments that tune the policy through field measurements.

`tests/test_connect.nim` runs the protocol through a live five-node Mix topology. The test establishes a session and stream, waits for the initiator-driven numbered supply to fill the recipient's advertised capacity, and exchanges application data through the standard `Connection` interface.

## Mix Transport Implementation Walk Through - Remote Teardown — 8. Tests cover the semantic boundaries

`tests/test_wire.nim` verifies that `CloseStream` survives a Protobuf round trip with `finalSequence`, and that the validator rejects both a missing final sequence and a final sequence attached to `ResetStream`.

`tests/test_streams.nim` delivers Data sequence `2` before sequence `1` after recording a remote final sequence of `2`. The test confirms that the close condition remains false until both payloads have advanced through the ordered receive path. A separate test blocks in `readOnce`, applies a remote reset and verifies that the pending read raises `LPStreamResetError`.

`tests/test_connect.nim` exercises graceful teardown through five live Mix nodes. After the request and response have crossed the virtual connection, the initiator closes its `TransportStream` and waits for the recipient's matching stream to close. The initiator then calls `disconnect` and waits for the recipient session's `closedEvent`. Both session stream tables are empty before the surrounding test fixture stops either transport.

The same test module also dispatches `ResetSession` through the registered Mix delivery handler. The test confirms that the recipient removes the session, closes its stream and wakes a blocked stream read with `LPStreamResetError`.

## Mix Transport Implementation Walk Through - Session Lifecycle Events — Test coverage

`tests/test_lifecycle.nim` verifies that duplicate handler registration is idempotent and that a registered handler can be removed.

The live five-node test in `tests/test_connect.nim` registers handlers on both endpoint transports before the handshake. The test verifies:

- one initiator `Established` event whose `peerId` is the real destination;
- one recipient `Established` event whose `peerId` is the session pseudonym;
- no additional establishment event when `connect(destination)` reuses the session;
- one `Closed` event on each endpoint after the initiator disconnects;
- stable `sessionId` and `role` fields across each endpoint's establishment and closure events.

The BlockExchange adapter and the required replacement of raw Switch peer membership are described in [[Mix Transport Block Exchange Integration - Session Events]].

## Mix Transport Implementation Walk Through - Bounded Data Flow — Remaining Reliability Work

The implemented flow bounds memory and carries application bytes in both directions, but it does not yet guarantee recovery from every packet-loss pattern. The following mechanisms remain to be added:

- Data retransmission currently uses one fixed timeout and retries without a retry-count limit. The transport does not estimate RTT, apply exponential backoff or close a stream after a configured number of unsuccessful retries.

- Receiving duplicate Data causes the receiver to send its latest absolute ACK again, which recovers when the Data arrived but the preceding ACK was lost. If submitting an ACK itself returns an error, `runAcknowledgements` currently exits, so later changes to the receive window no longer produce ACKs on that stream.

- A sender stops allocating new sequences when `nextOutboundSequence` reaches the remote receive-window limit. If the receiver advanced its window but every ACK carrying the new `receiveBase` was lost, the sender has no persist probe: it does not periodically send a small control frame that prompts the receiver to repeat its current window information.

- Every accepted chunk, duplicate and `receiveBase` advancement currently wakes the ACK task immediately. A delayed-ACK policy could combine state changes that occur within a short interval and reduce Mix-packet and SURB consumption, but no delay timer or threshold policy is implemented.

- Teardown notifications are best effort and are not retransmitted or acknowledged. A lost `CloseStream`, `ResetStream`, `Disconnect` or `ResetSession` can therefore leave remote state alive until another liveness mechanism removes it.

These additions affect transport scheduling and lifecycle management. They do not require changing the application-facing `Connection` API, and the retransmission and delayed-ACK work can continue to use the existing sequence numbers, `receiveBase` and fixed acknowledgement bitmap.

## Mix Transport Implementation Walk Through - Concurrent Connect and Test Injection — Isolated Coordinator Tests

The test-only `Synchronizer` supplies a small existing-connection table and an `AsyncEvent` that holds the operation open:

```nim
type Synchronizer = ref object
  connectAttempts: ConnectAttemptCoordinator[string, Session]
  sessions: Table[string, Session]
  gate: AsyncEvent
  operationCancelled: AsyncEvent
```

Holding the operation at `gate.wait()` allows the test to start several callers before completing the attempt. The tests verify that one caller creates one connection, an existing connection is returned without another operation, concurrent callers receive the first caller's result, cancelling one of two callers leaves the worker alive, cancelling the only caller reaches the worker, shutdown gives all callers the shutdown reason and a failed attempt does not prevent a later retry.

The tests use `activeAttemptCount` to inspect only the coordinator's externally meaningful state. They do not reach into a private `ConnectAttempt` to inspect its worker future or waiter count.

## Mix Discovery through Provider Records — Earlier discovery alternatives

### Historical design exploration

The remaining sections record the alternatives considered before the codec and explicit-destination API were implemented. In particular, the suggestions to enroll providers in the relay pool, define a smaller key-only component, or extend the provider-record format are not the adopted baseline. The considerations about signed records, record size, and address freshness remain relevant.

### Information already present in a provider record

The current Storage DHT advertises a libp2p `SignedPeerRecord`. The signed payload contains the provider's `PeerId` and a sequence of ordinary libp2p `MultiAddress` values. The signed envelope contains the provider's libp2p public key and authenticates the complete peer-record payload.

The Mix node pool expects a `MixPubInfo` value:

```nim
type MixPubInfo* = object
  peerId*: PeerId
  multiAddr*: MultiAddress
  mixPubKey*: FieldElement
  libp2pPubKey*: SkPublicKey
```

Discovery can derive three fields without embedding a complete serialized `MixPubInfo`:

- `peerId` comes from `SignedPeerRecord.data.peerId`.
- `multiAddr` can be selected from the record's ordinary TCP or QUIC addresses, subject to the address formats supported by Mix.
- `libp2pPubKey` comes from `SignedPeerRecord.envelope.publicKey`, after verifying that the key uses secp256k1 and matches `peerId`.

Only `mixPubKey` is missing. The current Curve25519 Mix public key is 32 bytes.

After validating the signed record and extracting the Mix public key, discovery can construct `MixPubInfo` and call:

```nim
mixProto.nodePool.add(mixPubInfo)
```

The pool stores the Mix public key and reuses libp2p's peer-store address and key books. A subsequent `MixTransport.connect(providerPeerId)` can therefore resolve the provider as a Mix destination.

### Encoding the Mix key as a multiaddress component

An address such as:

```text
/ip4/192.0.2.10/tcp/8901/mix-transport/<encoded-data>
```

cannot be parsed by the current `nim-libp2p` implementation. `MultiAddress.init` accepts only protocols present in the compile-time multicodec and multiaddress protocol tables, and neither `mix-transport` nor `mix` is currently registered.

`nim-libp2p` supports compile-time multicodec and multiaddress extensions, so a custom length-delimited component could make this representation mechanically possible. Every DHT node that decodes and stores the provider record would need the same extension. A node without the extension would reject the unknown multiaddress while decoding the signed provider record, which makes a gradual deployment difficult.

Embedding the complete `MixPubInfo` would also duplicate the peer ID, transport address and libp2p public key already authenticated by the signed provider record. If a custom multiaddress is used as an interim representation, the component should contain only a versioned 32-byte Mix public key. Discovery must remove or ignore the metadata component before passing ordinary addresses to libp2p dialing or to Mix's transport-address encoder.

The multiaddress representation remains a semantic compromise. A multiaddress normally describes how to reach a service, whereas the Mix public key is cryptographic service metadata. Treating metadata as an address also allows the pseudo-address to leak into address selection and dialing code unless every consumer filters it correctly.

Record size also matters in the current discovery transport. Provider messages travel through discovery v5 over UDP. `handleGetProviders` currently puts every returned provider record into one `ProvidersMessage`; the source contains a `TODO` for splitting provider responses across multiple messages. A large text-encoded `MixPubInfo` in every address would amplify an existing packet-size risk. Carrying only the 32-byte key keeps the additional cost small, but provider-response sizing and splitting should still be corrected independently.

### Extended peer records provide a cleaner shape

The vendored libp2p implementation already defines `ExtendedPeerRecord`, which adds named service metadata to the peer ID and address fields:

```nim
type
  ServiceInfo* = object
    id*: string
    data*: seq[byte]

  ExtendedPeerRecord* = object
    peerId*: PeerId
    seqNo*: uint64
    addresses*: seq[AddressInfo]
    services*: seq[ServiceInfo]
```

`ServiceInfo.data` is limited to 33 bytes. A service entry whose identifier denotes Mix and whose data contains a version byte plus the 32-byte Mix public key fits that bound exactly. The provider's addresses and libp2p identity remain in their existing fields, and the entire record remains signed by the provider.

The current Storage DHT provider messages, provider cache and persistence layer are typed specifically as `SignedPeerRecord`. Using `SignedExtendedPeerRecord` therefore requires changing the DHT provider-record boundary; the existing code cannot start advertising extended records through configuration alone. The change should also define how nodes that do not understand the extended form handle and forward provider advertisements.

### Validation and updates

Whichever encoding is selected, a requester must validate the information before adding the provider to the Mix node pool:

1. Verify the signed provider-record envelope.
2. Verify that the envelope's public key produces the `PeerId` carried by the record.
3. Require a secp256k1 libp2p key because the current Mix implementation stores `SkPublicKey`.
4. Decode exactly one supported, versioned Mix public key and reject malformed or conflicting declarations.
5. Select a Mix-supported TCP or QUIC address from the ordinary provider addresses.
6. Apply the provider record's sequence number or another freshness rule so an older advertisement cannot overwrite a newer Mix key or address.

Provider records are replicated and can remain available after a provider rotates its Mix key or changes address. Dynamic pool insertion therefore also needs an update and expiry policy. The current `MixNodePool.add` overwrites the Mix public key, adds the address with infinite confidence, and does not remove older addresses. Those semantics are suitable for manually curated static configuration but need refinement before discovered records can rotate or expire cleanly.

### Recommended direction

Carrying Mix discovery information with the CID provider advertisement is a strong fit for the download flow: the provider lookup returns both a relevant provider and the information needed to establish a Mix session with that provider.

The preferred representation is signed service metadata containing only a version and the 32-byte Mix public key, while reusing the peer ID, address and libp2p public key already present in the signed record. `ExtendedPeerRecord.services` has the right conceptual shape and size, but the Storage DHT must first support extended provider records. A custom multiaddress component can serve as a prototype, but the custom component requires protocol registration throughout the DHT deployment and careful filtering from ordinary address consumers.


## Mix Transport Block Exchange Integration - Session Events — Original integration proposal

### Integration goal

Block exchange already has the two application-level transitions that MixTransport must drive:

```nim
proc handlePeerJoined*(
    self: BlockExcNetwork, peer: PeerId
) {.async: (raises: [CancelledError]).}

proc handlePeerDeparted*(
    self: BlockExcNetwork, peer: PeerId
) {.async: (raises: [CancelledError]).}
```

Both procedures are defined in `storage/blockexchange/network/network.nim`. `handlePeerJoined` creates the corresponding `NetworkPeer` and invokes `handlers.onPeerJoined`. `handlePeerDeparted` removes the `NetworkPeer` and invokes `handlers.onPeerDeparted`.

The block-exchange engine installs those higher-level callbacks in `storage/blockexchange/engine/engine.nim`:

```nim
network.handlers = BlockExcHandlers(
  onWantList: blockWantListHandler,
  onPresence: blockPresenceHandler,
  onWantBlocksRequest: wantBlocksRequestHandler,
  onPeerJoined: peerAddedHandler,
  onPeerDeparted: peerDepartedHandler,
)
```

The integration should preserve this existing chain. MixTransport only replaces the source of the peer lifecycle signal.

### Why raw Switch events cannot drive Mix-backed peer membership

`BlockExcNetwork.init` currently registers one callback for `PeerEventKind.Joined` and `PeerEventKind.Left`:

```nim
self.switch.addPeerEventHandler(peerEventHandler, PeerEventKind.Joined)
self.switch.addPeerEventHandler(peerEventHandler, PeerEventKind.Left)
```

Those events describe authenticated libp2p connectivity. When Mix is enabled, a Switch connection can exist because the local node and another Storage node are adjacent relays in a Mix path. The physical relay connection does not mean that the relay has established an anonymous block-exchange session with the local node.

Conversely, the recipient of an anonymous MixTransport session does not learn the initiator's authenticated libp2p identity. The recipient needs to add the session pseudonym to the block-exchange peer table even though no Switch peer event exists for that pseudonym.

For these reasons, a Mix-enabled `BlockExcNetwork` must use MixTransport `SessionEvent` values for application peer membership. The network must not process raw Switch joined and left events as block-exchange peer events in that mode.

### Preserve one shared application transition

The cleanest change is to separate application peer handling from the filter that applies only to physical Switch events:

```nim
proc handleApplicationPeerJoined(
    self: BlockExcNetwork, peer: PeerId
) {.async: (raises: [CancelledError]).} =
  discard self.getOrCreatePeer(peer)
  if not self.handlers.onPeerJoined.isNil:
    await self.handlers.onPeerJoined(peer)

proc handleApplicationPeerDeparted(
    self: BlockExcNetwork, peer: PeerId
) {.async: (raises: [CancelledError]).} =
  trace "Cleaning up departed peer", peer
  self.peers.del(peer)
  if not self.handlers.onPeerDeparted.isNil:
    await self.handlers.onPeerDeparted(peer)
```

The existing public procedures can retain their names and delegate to these helpers. The relay exclusion belongs in the Switch adapter, not in the shared application transition:

```nim
proc handlePeerJoined*(
    self: BlockExcNetwork, peer: PeerId
) {.async: (raises: [CancelledError]).} =
  await self.handleApplicationPeerJoined(peer)

proc handlePeerDeparted*(
    self: BlockExcNetwork, peer: PeerId
) {.async: (raises: [CancelledError]).} =
  await self.handleApplicationPeerDeparted(peer)
```

Moving `excludedPeers` checks to the Switch callback matters because a Mix session event has already identified an application peer. Applying the physical-relay exclusion to a Mix event could incorrectly reject an initiator-side destination that also participates in the relay pool.

### Retain callback values so they can be removed

The current Switch callback is a local variable inside `BlockExcNetwork.init`. A later transition to Mix mode cannot unregister that callback unless `BlockExcNetwork` retains the procedure value.

Add fields for both lifecycle adapters:

```nim
type BlockExcNetwork* = ref object of LPProtocol
  # Existing fields omitted.
  switchPeerEventHandler: libp2p.PeerEventHandler
  mixSessionEventHandler: SessionEventHandler
  useMixSessionEvents: bool
```

If the umbrella `pkg/libp2p` import does not provide an unambiguous qualified name in the final patch, import the connmanager event type under a module alias. The important requirement is to distinguish libp2p's two-argument `PeerEventHandler` from the one-argument type named `PeerEventHandler` locally in `network.nim`.

### Select the lifecycle source before the Switch starts

The Storage configuration already knows whether Mix is enabled when `BlockExcNetwork.new(switch)` is called in `storage/storage.nim`. Pass that information into the constructor:

```nim
network = BlockExcNetwork.new(
  switch,
  useMixSessionEvents = config.mixEnabled,
)
```

Extend the constructor accordingly:

```nim
proc new*(
    T: type BlockExcNetwork,
    switch: Switch,
    connProvider: ConnProvider = nil,
    maxInflight = DefaultMaxInflight,
    useMixSessionEvents = false,
): BlockExcNetwork =
  # Existing construction remains unchanged.
  self.useMixSessionEvents = useMixSessionEvents
  self.init()
  self
```

The constructor flag is preferable to registering Switch callbacks first and removing them later. Selecting the source before the Switch starts prevents an early physical relay connection from entering `BlockExcNetwork.peers` during Mix startup.

Inside `BlockExcNetwork.init`, retain the Switch callback but register it only for direct mode:

```nim
method init*(self: BlockExcNetwork) {.raises: [].} =
  let switchPeerEventHandler: libp2p.PeerEventHandler = proc(
      peerId: PeerId, event: PeerEvent
  ): Future[void] {.async: (raises: [CancelledError]).} =
    if peerId in self.excludedPeers:
      return
    case event.kind
    of PeerEventKind.Joined:
      await self.handleApplicationPeerJoined(peerId)
    of PeerEventKind.Left:
      await self.handleApplicationPeerDeparted(peerId)
    else:
      discard

  self.switchPeerEventHandler = switchPeerEventHandler
  if not self.useMixSessionEvents:
    self.switch.addPeerEventHandler(
      switchPeerEventHandler, PeerEventKind.Joined
    )
    self.switch.addPeerEventHandler(
      switchPeerEventHandler, PeerEventKind.Left
    )

  # Keep the existing LPProtocol handler assignment below this block.
```

Direct-mode behavior remains unchanged. Mix mode starts without treating relay connectivity as block-exchange peer membership.

### Attach MixTransport before starting it

Add a procedure in `storage/blockexchange/network/network.nim` that registers the Mix session callback:

```nim
proc attachMixTransport*(
    self: BlockExcNetwork, mixTransport: MixTransport
) {.raises: [].} =
  doAssert self.useMixSessionEvents,
    "BlockExcNetwork was not configured for Mix session events"
  doAssert self.mixTransport.isNone,
    "BlockExcNetwork already has a MixTransport"

  let sessionEventHandler: SessionEventHandler = proc(
      event: SessionEvent
  ): Future[void] {.async: (raises: [CancelledError]).} =
    case event.kind
    of SessionEventKind.Established:
      await self.handleApplicationPeerJoined(event.peerId)
    of SessionEventKind.Closed:
      await self.handleApplicationPeerDeparted(event.peerId)

  self.mixSessionEventHandler = sessionEventHandler
  self.mixTransport = some(mixTransport)
  mixTransport.addSessionEventHandler(sessionEventHandler)
```

Call `attachMixTransport` in `StorageServer.startMixTransport` before `MixTransport.start`:

```nim
proc startMixTransport*(
    s: StorageServer, mixProto: MixProtocol
) {.async: (raises: [CancelledError, StorageError]).} =
  if not s.config.mixEnabled or mixProto.isNil:
    return

  let mixTransport = newMixTransport(mixProto)
  s.storageNode.engine.network.attachMixTransport(mixTransport)
  (await mixTransport.start()).isOkOr:
    raise newException(
      StorageError, "Failed to start Mix transport: " & error
    )
```

The handler must be attached first because `addSessionEventHandler` does not replay sessions that were already established. Starting the transport afterward opens its Mix delivery endpoint only when the BlockExchange listener is ready.

The snippet uses the generic package constructor `newMixTransport(mixProto)`. The existing `storage/mix` facade and the call `newMixTransport(switch, mixProto)` are exploratory code from before the generic package API and should be replaced during integration.

If `MixTransport.start` fails, remove the event handler and clear the stored transport before propagating the startup error. A small `detachMixTransport` helper makes that rollback and normal shutdown symmetrical.

### How the two endpoints enter BlockExchange

On the session initiator, a successful call to:

```nim
let session = (await mixTransport.connect(peer.peerId)).valueOr:
  raise newException(
    StorageError, "Failed to connect over MixTransport: " & error
  )
```

publishes `SessionEventKind.Established` before `connect` returns. The event carries `event.peerId == peer.peerId`, so `handleApplicationPeerJoined` creates the same block-exchange table key that direct mode would use.

On the session recipient, the successfully submitted `ConnectAck` causes its local transport to publish `Established`. The event carries `event.peerId == event.sessionId`. `handleApplicationPeerJoined` creates a `NetworkPeer` under that pseudonym, matching the `peerId` exposed by every incoming virtual `TransportStream` in the session.

The existing mounted block-exchange protocol handler remains useful on both transports:

```nim
proc handler(
    conn: Connection, proto: string
): Future[void] {.async: (raises: [CancelledError]).} =
  let peerId = conn.peerId
  let blockexcPeer = self.getOrCreatePeer(peerId)
  await blockexcPeer.readLoop(conn)
```

MixTransport looks up the mounted codec before accepting `OpenStream` and passes the virtual connection to this handler. No Mix-specific read loop is needed.

### Dial application streams through MixTransport

`getOrCreatePeer` currently constructs a default `ConnProvider` that calls `switch.dial(peer, Codec)`. In Mix mode, the provider must call `MixTransport.dial` instead:

```nim
proc getOrCreatePeer(
    self: BlockExcNetwork, peer: PeerId
): NetworkPeer =
  # Existing peer lookup omitted.

  var getConn: ConnProvider
  if self.mixTransport.isSome:
    let mixTransport = self.mixTransport.get()
    getConn = proc(): Future[Connection] {.
        async: (raises: [CancelledError])
    .} =
      let stream = (await mixTransport.dial(peer, Codec)).valueOr:
        raise newException(
          LPStreamError,
          "Unable to open block-exchange stream through MixTransport: " & error,
        )
      return Connection(stream)
  else:
    getConn = proc(): Future[Connection] {.
        async: (raises: [CancelledError])
    .} =
      return await self.switch.dial(peer, Codec)

  if not self.getConn.isNil:
    getConn = self.getConn

  # Pass getConn to NetworkPeer.new as before.
```

Every invocation opens a new virtual stream inside the established Mix session. Several block-exchange streams can therefore share one session and one session identity.

### Establish the session in `dialPeer`

The Mix branch of `BlockExcNetwork.dialPeer` no longer needs to select a forwarding address. Exit equals destination uses the peer ID discovered for the remote Mix-aware Storage node:

```nim
if self.mixTransport.isSome:
  let mixTransport = self.mixTransport.get()
  trace "Connecting to peer via MixTransport", peer = peer.peerId
  (await mixTransport.connect(peer.peerId)).isOkOr:
    raise newException(
      StorageError, "Failed to connect over MixTransport: " & error
    )
else:
  await self.switch.connect(peer.peerId, peer.addresses.mapIt(it.address))
```

The successful Mix call publishes `Established` and creates the `NetworkPeer` through the registered event handler. The later first block-exchange send uses the Mix-aware `ConnProvider` to open a virtual stream lazily, preserving the current block-exchange behavior.

### Session closure and BlockExchange cleanup

Every established Mix session eventually publishes one `Closed` event after local transport resources have been detached. The adapter passes `event.peerId` to `handleApplicationPeerDeparted`. The existing engine callback then evicts peer-specific block-exchange state:

```nim
proc peerDepartedHandler(
    peer: PeerId
): Future[void] {.async: (raises: [CancelledError]).} =
  self.evictPeer(peer)
```

Closing one `TransportStream` does not publish `Closed` and must not remove the `NetworkPeer`. The peer remains available for another stream until the complete Mix session ends.

The current `BlockExcNetwork.dropPeer` always calls `switch.disconnect(peer)`. That operation is correct only in direct mode. The Mix branch must reset or disconnect the corresponding transport session instead. The current event API deliberately reports identity and lifecycle without exposing the internal session registry, so complete `dropPeer` integration requires one additional transport-facing operation, such as `resetPeer(peerId)`, or an explicit BlockExchange mapping from peer IDs to session handles. Do not pass a recipient pseudonym to `switch.disconnect`.

### Shutdown order

During Storage shutdown, keep the BlockExchange session handler registered while calling `mixTransport.stop()`. `stop` publishes `Closed` for every established session, which allows the block-exchange engine to remove its peer state through the normal departure path.

After `mixTransport.stop()` has completed, remove the callback and clear the stored reference:

```nim
proc detachMixTransport*(
    self: BlockExcNetwork
) {.raises: [].} =
  self.mixTransport.withValue(mixTransport):
    if not self.mixSessionEventHandler.isNil:
      mixTransport.removeSessionEventHandler(self.mixSessionEventHandler)
  self.mixSessionEventHandler = nil
  self.mixTransport = none(MixTransport)
```

The direct-mode Switch handlers should likewise be removed when `BlockExcNetwork` itself is permanently stopped. Retaining both callback values on the network object makes ownership and removal explicit.

### Integration tests to add with the Storage patch

The Storage integration should add focused tests around the existing `tests/storage/blockexchange/testnetwork.nim` fixture:

1. A Switch relay `Joined` event does not add a block-exchange peer when `useMixSessionEvents` is enabled.
2. An initiator-side Mix `Established` event adds the real destination peer ID.
3. A recipient-side Mix `Established` event adds the session pseudonym.
4. Opening and closing several virtual streams does not repeat the joined callback and does not produce a departure.
5. A Mix `Closed` event removes the peer and invokes the engine departure callback once.
6. Direct mode continues to use the existing Switch joined and left behavior.
7. Startup failure removes the registered Mix handler, and normal shutdown keeps the handler installed until transport-generated close events have completed.

The generic transport already verifies event identity, ordering, reuse suppression and disconnect delivery in its live five-node test. Storage tests should concentrate on the adapter and on the resulting `BlockExcNetwork.peers` and engine state.

## Recipient-originated streams — historical validation

The full local suite passed: 85 tests, compiled with usage style checks. Seven focused session-history tests cover removal, rejected attempts, in-window reordering, window advancement, large jumps, maximum IDs, and invalid parity. Each runs for both session roles. These checks do not replace loss/reordering stress experiments.

The real-network regression in `tests/test_connect.nim` establishes one session, reuses it through the recipient's anonymous peer identity, opens two even-numbered streams, exchanges length-prefixed bytes in both directions, and checks unsupported-protocol rejection. Existing tests continue to cover initiator-originated opening and delayed acknowledgements.

The transport increment was pushed as `edd2423`. A subsequent Storage integration update now pins that revision and removes the incoming-stream reuse workaround. BlockExchange uses recipient-side dialing for its normal retained sending connection; real-network checks cover presence delivery, connection reuse, and replacement within the same session. See [[Mix Transport Logos Storage Integration - Download Transport Selection]]. These Storage changes are a separate, uncommitted increment.

## Concurrent connect — historical regression description

The test named `data packets are not rejected if ACK arrives too fast` calls the normal five-node `establishSessionAndStream` helper with a two-second inter-copy delay. The helper runs real MixProtocol routing, SURB reply recovery, session establishment, stream establishment and application Data exchange.

The delay gives the first `StreamAck` copy enough time to reach the initiator and lets the initiator send Data while the recipient is still inside its redundancy loop. The test succeeds only because `handleOpenStream` configures and establishes the recipient stream before calling `sendStreamResponse`. If the old ordering returns, the early Data frame reaches a pending or unconfigured stream and the exchange fails.

The seam controls submission timing while leaving production framing, redundancy selection and state transitions intact.
