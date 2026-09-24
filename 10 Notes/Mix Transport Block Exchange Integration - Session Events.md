---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through - Session Lifecycle Events]]"
  - "[[Mix Transport Logos Storage Integration - Download Transport Selection]]"
---
# Mix Transport Block Exchange Integration - Session Events

## Two sources of application-peer lifecycle

Storage holds independent Direct and Mix `BlockExcNetwork` protocol instances in `BlockExcNetworks`. Direct exists during construction. Mix exists only after startup supplies a non-nil MixTransport. One mounted `dispatchProtocol` routes incoming ordinary connections to Direct and TransportStream connections to Mix. The full startup and dispatch walkthrough is [[Mix Transport Logos Storage Integration - Download Transport Selection]].

Direct subscribes to the Switch's Joined and Left peer events. Mix subscribes to MixTransport's Established and Closed session events. A physical connection to a Mix relay is therefore not, by itself, a Mix BlockExchange peer. These are distinct event APIs, not one callback interpreting both connection types.

## Register the Mix callback at construction

The Mix instance's constructor stores its MixTransport, initializes the protocol and invokes `subscribeMixSessions`. The following procedures in `storage/blockexchange/network/network.nim` retain the callback identity so it can be removed later:

```nim
proc subscribeMixSessions(self: BlockExcNetwork) =
  ## Use MixTransport sessions, rather than physical Switch connections, as
  ## the peer lifecycle observed by BlockExchange.
  proc sessionEventHandler(
      event: SessionEvent
  ): Future[void] {.async: (raises: [CancelledError]).} =
    case event.kind
    of SessionEventKind.Established:
      await self.registerPeer(event.peerId)
    of SessionEventKind.Closed:
      await self.unregisterPeer(event.peerId)

  self.mixSessionEventHandler = sessionEventHandler
  self.mixTransport.addSessionEventHandler(sessionEventHandler)

proc unsubscribeMixSessions(self: BlockExcNetwork) =
  if not self.mixTransport.isNil and not self.mixSessionEventHandler.isNil:
    self.mixTransport.removeSessionEventHandler(self.mixSessionEventHandler)
  self.mixSessionEventHandler = nil
  self.mixSessions.clear()
```

The callback runs at both session endpoints. At the initiator, event.peerId is the real destination identity. At the recipient, it is the anonymous session pseudonym. Both are keys in that endpoint's Mix protocol peer table; neither is a report about a physical relay connection.

`registerPeer` obtains or creates a NetworkPeer and calls handlers.onPeerJoined. `unregisterPeer` removes the retained session handle and NetworkPeer, then calls handlers.onPeerDeparted. The engine installs those callbacks with DownloadTransport.Mix captured, so they update Mix peer contexts and tracker state. Direct callbacks capture Direct and update their separate stores.

## Attach before accepting sessions

Storage's startMixTransport constructs the transport, calls engine.enableMixNetwork, attaches the manifest consumer, and only then awaits transport.start. The engine's ownership operations are:

```nim
proc enableMixNetwork*(self: BlockExcEngine, mixTransport: MixTransport) =
  doAssert not mixTransport.isNil
  doAssert self.networks.mix.isNil, "Mix BlockExchange is already enabled"
  let network = BlockExcNetwork.new(
    self.networks.direct.switch,
    maxInflight = self.networks.direct.sendConcurrencyLimit,
    mixTransport = mixTransport,
  )
  self.configureNetwork(network, DownloadTransport.Mix)
  self.networks.mix = network

proc disableMixNetwork*(self: BlockExcEngine) {.async: (raises: []).} =
  ## Remove BlockExchange's Mix instance after MixTransport has stopped, or
  ## when startup fails. This does not stop the shared transport service.
  let network = self.networks.mix
  self.networks.mix = nil
  if not network.isNil:
    await network.stop()
  self.mixPeers = PeerContextStore.new()
  self.mixPeerTracker = PeerInFlightTracker.new()
```

enableMixNetwork creates the Mix instance and installs its engine callbacks before exposing it through the holder. Its constructor has already subscribed to session events. A startup failure calls disableMixNetwork and detaches the manifest consumer before propagating the startup error.

## Session membership and application streams

Session establishment makes the peer available to BlockExchange. Individual stream openings do not create additional session events. A NetworkPeer's connection provider uses MixTransport.dial to open or replace its retained sending stream within the established session. This works at the recipient too: the anonymous peer ID resolves an existing session rather than a new forward destination.

Incoming connections are dispatched to the matching protocol instance and enter its NetworkPeer read loop. Presence and block messages use the same application codec in both modes. [[Mix Transport Logos Storage Integration - Download Transport Selection]] includes the connection-provider and read-loop code in context.

## Close the transport before removing its subscriber

During ordinary node shutdown, Storage awaits MixTransport.stop while the Mix protocol instance and callback still exist. Session shutdown closes streams and awaits their handlers and transport tasks, then publishes Closed. BlockExchange's read-loop cleanup completes pending block requests with connection errors; the Closed callback removes peer membership and the engine's associated bookkeeping.

In Storage's finally block, disableMixNetwork removes the holder's Mix instance, cancels its tracked message-handling futures and unsubscribes the callback. The manifest consumer is detached separately. Direct remains a distinct instance. disableMixNetwork is an integration cleanup operation, not an operation that stops the shared MixTransport itself.

When dropping a provider locally, BlockExchange can reset a session whose handle it retained through provider dialing. For a recipient session introduced only by an event, it removes the BlockExchange peer and logs that it cannot reset that session through its retained-handle path. That limitation is separate from normal transport-driven Closed events.
