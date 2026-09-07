---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through - Session Lifecycle Events]]"
  - "[[Mix Transport Logos Storage Integration Example]]"
  - "[[Libp2p Connection Lifecycle in Logos Storage]]"
  - "[[Block Exchange Peer Stores]]"
  - "[[New Logos Storage Block Exchange Protocol]]"
---

# Mix Transport Block Exchange Integration - Session Events

The concrete reference implementation, including Storage startup, BlockExchange dialing, manifest fetching, shutdown and the remaining recipient-side reset limitation, is documented in [[Mix Transport Logos Storage Integration Example]]. This note explains the lifecycle design that led to that implementation.

## Integration goal

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

## Why raw Switch events cannot drive Mix-backed peer membership

`BlockExcNetwork.init` currently registers one callback for `PeerEventKind.Joined` and `PeerEventKind.Left`:

```nim
self.switch.addPeerEventHandler(peerEventHandler, PeerEventKind.Joined)
self.switch.addPeerEventHandler(peerEventHandler, PeerEventKind.Left)
```

Those events describe authenticated libp2p connectivity. When Mix is enabled, a Switch connection can exist because the local node and another Storage node are adjacent relays in a Mix path. The physical relay connection does not mean that the relay has established an anonymous block-exchange session with the local node.

Conversely, the recipient of an anonymous MixTransport session does not learn the initiator's authenticated libp2p identity. The recipient needs to add the session pseudonym to the block-exchange peer table even though no Switch peer event exists for that pseudonym.

For these reasons, a Mix-enabled `BlockExcNetwork` must use MixTransport `SessionEvent` values for application peer membership. The network must not process raw Switch joined and left events as block-exchange peer events in that mode.

## Preserve one shared application transition

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

## Retain callback values so they can be removed

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

## Select the lifecycle source before the Switch starts

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

## Attach MixTransport before starting it

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

## How the two endpoints enter BlockExchange

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

## Dial application streams through MixTransport

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

## Establish the session in `dialPeer`

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

## Session closure and BlockExchange cleanup

Every established Mix session eventually publishes one `Closed` event after local transport resources have been detached. The adapter passes `event.peerId` to `handleApplicationPeerDeparted`. The existing engine callback then evicts peer-specific block-exchange state:

```nim
proc peerDepartedHandler(
    peer: PeerId
): Future[void] {.async: (raises: [CancelledError]).} =
  self.evictPeer(peer)
```

Closing one `TransportStream` does not publish `Closed` and must not remove the `NetworkPeer`. The peer remains available for another stream until the complete Mix session ends.

The current `BlockExcNetwork.dropPeer` always calls `switch.disconnect(peer)`. That operation is correct only in direct mode. The Mix branch must reset or disconnect the corresponding transport session instead. The current event API deliberately reports identity and lifecycle without exposing the internal session registry, so complete `dropPeer` integration requires one additional transport-facing operation, such as `resetPeer(peerId)`, or an explicit BlockExchange mapping from peer IDs to session handles. Do not pass a recipient pseudonym to `switch.disconnect`.

## Shutdown order

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

## Integration tests to add with the Storage patch

The Storage integration should add focused tests around the existing `tests/storage/blockexchange/testnetwork.nim` fixture:

1. A Switch relay `Joined` event does not add a block-exchange peer when `useMixSessionEvents` is enabled.
2. An initiator-side Mix `Established` event adds the real destination peer ID.
3. A recipient-side Mix `Established` event adds the session pseudonym.
4. Opening and closing several virtual streams does not repeat the joined callback and does not produce a departure.
5. A Mix `Closed` event removes the peer and invokes the engine departure callback once.
6. Direct mode continues to use the existing Switch joined and left behavior.
7. Startup failure removes the registered Mix handler, and normal shutdown keeps the handler installed until transport-generated close events have completed.

The generic transport already verifies event identity, ordering, reuse suppression and disconnect delivery in its live five-node test. Storage tests should concentrate on the adapter and on the resulting `BlockExcNetwork.peers` and engine state.
