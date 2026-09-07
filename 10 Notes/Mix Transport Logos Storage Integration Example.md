---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Block Exchange Integration - Session Events]]"
  - "[[Mix Transport Implementation Walk Through - Session Lifecycle Events]]"
  - "[[Libp2p Connection Lifecycle in Logos Storage]]"
---

# Mix Transport Logos Storage Integration Example

## Purpose

The `feat/mix-transport` branch in `logos-storage-nim` contains a reference integration of the generic `libp2p_mix_transport` package. The integration uses the existing Storage MixProtocol setup and applies MixTransport to BlockExchange streams and manifest fetching. The existing DHT proxy path is left unchanged in this increment.

The integration preserves the protocol-facing `Connection` API. BlockExchange and the manifest protocol continue to read from and write to libp2p `Connection` values; only the operation that opens a connection changes when Mix is enabled.

## Package boundary

The generic transport is included as `vendor/nim-libp2p-mix-transport`. `storage/mix.nim` is a narrow Storage facade that imports and re-exports the package:

```nim
import pkg/libp2p_mix_transport

export libp2p_mix_transport
```

The earlier files under `storage/mix/` implemented an incomplete forwarding-mode experiment. The reference integration removes those files because the generic package now owns session establishment, virtual streams, SURB replenishment, reliability and teardown.

The Storage branch also updates `vendor/nim-libp2p-mix` to the revision required by MixTransport. That Mix revision exports the public SURB APIs consumed by the transport package.

## Constructing BlockExchange before Mix starts

`StorageServer.new` knows whether Mix is enabled before the libp2p Switch starts. The constructor passes this choice to `BlockExcNetwork.new`:

```nim
network = BlockExcNetwork.new(
  switch,
  useMixSessionEvents = config.mixEnabled,
)
```

In direct mode, `BlockExcNetwork.init` registers the existing Switch `Joined` and `Left` callbacks. In Mix mode, `BlockExcNetwork.init` does not register those callbacks. A physical Switch connection may only represent adjacency between Mix relays and therefore must not create a BlockExchange application peer.

## Starting and attaching MixTransport

`StorageServer.start` constructs and starts MixProtocol as before. After MixProtocol has been mounted on the Switch, `StorageServer.startMixTransport` constructs one MixTransport instance and attaches both Storage consumers before starting it:

```nim
proc startMixTransport*(
    s: StorageServer, mixProto: MixProtocol
) {.async: (raises: [CancelledError, StorageError]).} =
  if not s.config.mixEnabled or mixProto.isNil:
    return

  let mixTransport = newMixTransport(mixProto)
  s.storageNode.engine.network.attachMixTransport(mixTransport)
  s.storageNode.manifestProtocol.attachMixTransport(mixTransport)
  (await mixTransport.start()).isOkOr:
    s.storageNode.engine.network.detachMixTransport()
    s.storageNode.manifestProtocol.detachMixTransport()
    raise newException(StorageError, "Failed to start MixTransport: " & error)
  s.mixTransport = mixTransport
```

Attaching consumers before `mixTransport.start()` ensures that BlockExchange observes the first established session. If transport startup fails, both attachments are removed before the startup error is propagated.

## BlockExchange peer lifecycle

`BlockExcNetwork.attachMixTransport` registers one `SessionEventHandler`. An `Established` event calls `registerPeer`, while a `Closed` event calls `unregisterPeer`:

```nim
proc sessionEventHandler(
    event: SessionEvent
): Future[void] {.async: (raises: [CancelledError]).} =
  case event.kind
  of SessionEventKind.Established:
    await self.registerPeer(event.peerId)
  of SessionEventKind.Closed:
    await self.unregisterPeer(event.peerId)
```

On the session initiator, `event.peerId` is the real destination peer ID. On the session recipient, `event.peerId` is the anonymous session ID exposed by MixTransport as the remote peer identity. Both cases therefore use the same `BlockExcNetwork.peers` table and the same existing `onPeerJoined` and `onPeerDeparted` callbacks.

The relay exclusion list remains part of the direct Switch-event adapter. The Mix session handler does not apply that list because a MixTransport event already identifies an application session rather than a physical relay connection.

## Establishing a BlockExchange session

Discovery continues to return a `PeerRecord`. `BlockExcNetwork.dialPeer` uses the discovered peer ID to establish or reuse a MixTransport session:

```nim
if not self.mixTransport.isNil:
  let session = (await self.mixTransport.connect(peer.peerId)).valueOr:
    raise newException(
      StorageError,
      "Failed to connect over MixTransport: " & error,
    )
  self.mixSessions[peer.peerId] = session
else:
  await self.switch.connect(
    peer.peerId,
    peer.addresses.mapIt(it.address),
  )
```

Exit-equals-destination mode does not use a forwarding address from the `PeerRecord`. MixProtocol resolves the destination peer through its Mix node pool.

The initiator-side session handle is retained by BlockExchange so that `dropPeer` can call `MixTransport.resetSession` instead of incorrectly calling `switch.disconnect` for a Mix peer.

## Opening BlockExchange streams

Each `NetworkPeer` receives a `ConnProvider`. The provider opens a virtual BlockExchange stream when MixTransport is attached:

```nim
if not self.mixTransport.isNil:
  let stream = (
    await self.mixTransport.dial(peer, Codec)
  ).valueOr:
    trace "Unable to open MixTransport block exchange stream", peer, error
    return nil
  return stream
```

`TransportStream` inherits from libp2p `Connection`, so the returned value satisfies the existing `ConnProvider` type. `NetworkPeer.send`, `NetworkPeer.readLoop`, `writeWantBlocksRequest` and the other BlockExchange framing operations require no Mix-specific variants.

On the recipient, MixTransport validates that `Codec` is mounted on the Switch, creates the virtual stream and invokes the existing `BlockExcNetwork` protocol handler. The handler obtains `conn.peerId`, finds or creates the corresponding `NetworkPeer`, and runs the existing BlockExchange read loop.

## Manifest fetching

`ManifestProtocol` retains an optional nullable MixTransport reference. `fetchManifestFromPeer` chooses the dialer before writing the existing manifest request:

```nim
if not self.mixTransport.isNil:
  conn = (
    await self.mixTransport.dial(
      peer.peerId,
      ManifestProtocolCodec,
    )
  ).valueOr:
    return failure(
      "Error opening MixTransport manifest stream to " &
        $peer.peerId & ": " & error,
    )
else:
  conn = await self.switch.dial(
    peer.peerId,
    peer.addresses.mapIt(it.address),
    ManifestProtocolCodec,
  )
```

After this selection, the existing request encoding, response decoding, CID verification and connection cleanup are shared by both modes. The mounted inbound manifest handler is also unchanged because MixTransport passes it a virtual `Connection`.

## Shutdown order

`StorageServer` owns the MixTransport instance. During shutdown, Storage stops MixTransport while the BlockExchange session handler is still registered. MixTransport publishes `Closed` for each established session, allowing BlockExchange to remove peer state through its normal departure callbacks. Storage detaches BlockExchange and the manifest protocol only after transport shutdown has completed, then stops the underlying Switch and Storage node.

## Current recipient-side reset limitation

The integration can reset an initiator-side session because `dialPeer` retains the `TransportSession` returned by `connect`. A recipient-side BlockExchange peer is keyed by its anonymous session ID, but the current public MixTransport API does not provide the corresponding `TransportSession` handle or a `resetSession(sessionId)` operation.

When BlockExchange locally drops such a recipient-side peer, the reference implementation removes the BlockExchange state and logs that the underlying MixTransport session could not be reset. Completing this path requires a small generic transport API that resets a registered session by its public session ID. Passing the anonymous ID to `switch.disconnect` would be incorrect because the ID does not identify a physical libp2p connection.

## Verification

The Storage binary builds with `make -j24 NIMFLAGS="-d:disableMarchNative"`. The complete unit suite passes with `make test -j24 NIMFLAGS="-d:disableMarchNative"`.

`tests/storage/blockexchange/testnetwork.nim` also verifies that a physical Switch connection does not create a BlockExchange peer when `useMixSessionEvents` is enabled. End-to-end Storage tests for initiator and recipient session events, BlockExchange transfer and manifest fetching over a multi-node Mix path remain valuable follow-up coverage.
