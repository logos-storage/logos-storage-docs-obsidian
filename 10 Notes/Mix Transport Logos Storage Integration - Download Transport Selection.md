---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Logos Storage Integration Plan]]"
  - "[[Mix Transport Logos Storage Integration Example]]"
  - "[[Block Exchange Peer Stores]]"
---
# Direct and Mix downloads

This walkthrough follows a download from the REST transport choice to manifest retrieval, provider selection, BlockExchange connections, and the stream returned to the caller. The connection-management sections explain the protocol instances that carry that work. File paths are relative to the Storage repository unless stated otherwise. Excerpts retain function signatures and identify omitted code; they are reading aids rather than standalone examples.

## Choosing how a download contacts providers

`mixEnabled` enables the node's Mix services. A download independently selects the connection type used for its manifest and blocks. The choice is represented by `DownloadTransport`, defined in `storage/downloadtransport.nim`:

```nim
type DownloadTransport* {.pure.} = enum
  Direct
  Mix
```

Direct is the default, including on a node with Mix enabled. The network download endpoints accept `?transport=direct` or `?transport=mix`:

- `POST /api/storage/v1/data/{cid}/network` starts a background download.
- `GET /api/storage/v1/data/{cid}/network/stream` streams the dataset.
- `GET /api/storage/v1/data/{cid}/network/manifest` fetches only the manifest.

The REST endpoints call the parser in `storage/downloadtransport.nim`:
```nim
func parseDownloadTransport*(value: string): Result[DownloadTransport, string] =
  case value
  of "direct":
    ok(DownloadTransport.Direct)
  of "mix":
    ok(DownloadTransport.Mix)
  else:
    err("transport must be 'direct' or 'mix'")
```

An unrecognized value produces HTTP 400. A Mix request fails if Mix has not been attached; the request does not fall back to direct dialing. Existing internal callers that omit the parameter select Direct. The C-library download API does not expose this parameter. Discovery's DHT proxy selection is configured independently.

## From the API to a download

### Parse once and use the same choice for manifest and blocks

The background-download route in `storage/rest/api.nim` first reads the query parameter, then fetches the manifest, and finally starts the block download. The route callback is registered through `router.api`, rather than being a named procedure. This excerpt includes that callback's declaration and the operations relevant to transport selection; CID validation, logging, CORS setup, and final response construction are omitted:

```nim
router.api(MethodPost, "/api/storage/v1/data/{cid}/network") do(
    cid: Cid, resp: HttpResponseRef
) -> RestApiResponse:
  # CORS setup omitted; headers is established there.
  let transport = parseDownloadTransport(
    request.query.getString("transport", "direct")
  ).valueOr:
    return RestApiResponse.error(Http400, error, headers = headers)

  # CID validation omitted.
  without manifest =? (await node.fetchManifest(cid.get(), transport)), err:
    return RestApiResponse.error(Http404, err.msg, headers = headers)

  let md = ManifestDescriptor(manifest: manifest, manifestCid: cid.get())
  without downloadId =? (
    await node.startBackgroundDownload(
      md, selectionPolicy = spRandomWindow, transport = transport
    )
  ), err:
    return RestApiResponse.error(Http409, err.msg, headers = headers)
  # Success response construction follows.
```

The `transport` variable is used in both calls. A successful Mix manifest fetch does not leave the block-download step to infer a transport from node configuration.

The node's manifest entry point delegates to `ManifestProtocol`:

```nim
proc fetchManifest*(
    self: StorageNodeRef,
    cid: Cid,
    transport: DownloadTransport = DownloadTransport.Direct,
): Future[?!Manifest] {.async: (raises: [CancelledError]).}
```

The provider-address section below follows the delegated manifest request through discovery and dialing. For now, the important output is the manifest: its descriptor tells the block-download engine which tree and blocks to fetch.

### Reuse only a background download with the same transport

The second call enters `startBackgroundDownload` in `storage/node.nim`:

```nim
proc startBackgroundDownload*(
    self: StorageNodeRef,
    md: ManifestDescriptor,
    selectionPolicy: SelectionPolicy = spSequential,
    transport: DownloadTransport = DownloadTransport.Direct,
): Future[?!uint64] {.async: (raises: [CancelledError]).} =
  let
    treeCid = md.manifest.treeCid
    existing = self.engine.downloadManager.getBackgroundDownload(treeCid, transport)

  if existing.isSome:
    return success(existing.get().id)

  let
    download = ?self.engine.startTreeDownloadOpaque(
      md, selectionPolicy = selectionPolicy, isBackground = true, transport = transport
    )
    downloadId = download.downloadId

  proc waitForCompleteTask(): Future[void] {.async: (raises: []).} =
    try:
      discard await download.waitForComplete()
    except CancelledError:
      trace "Background download cancelled", treeCid = treeCid, downloadId
    finally:
      self.engine.releaseDownload(download)

  self.trackedFutures.track(waitForCompleteTask())
  return success(downloadId)
```

Before creating a worker, the node asks `DownloadManager.getBackgroundDownload` whether an appropriate download is already running. The lookup examines both the tree CID and transport:

```nim
proc getBackgroundDownload*(
    self: DownloadManager,
    treeCid: Cid,
    transport: DownloadTransport = DownloadTransport.Direct,
): Option[ActiveDownload] =
  self.downloads.withValue(treeCid, innerTable):
    for _, download in innerTable[]:
      if download.isBackground and download.ctx.transport == transport:
        return some(download)
  return none(ActiveDownload)
```

Thus, another request for the same tree over Mix can reuse an existing Mix background download, but cannot reuse a Direct download of that tree. Both downloads still belong to one download manager and receive IDs from the same manager.

When a new download is necessary, `startTreeDownloadOpaque` creates it and returns a handle. The nested `waitForCompleteTask` owns the background wait and releases that handle when the wait ends, including cancellation. The REST caller receives the download ID without waiting for all blocks.

### Retain the transport choice in the download context

The engine's `toDownloadDesc` constructs a `DownloadDesc` containing the selected transport. `DownloadContext.new` then copies that field into the state retained for the download. The relevant constructor excerpt from `engine/downloadcontext.nim` is:

```nim
proc new*(
    T: type DownloadContext, desc: DownloadDesc, missingBlocks: seq[uint64] = @[]
): DownloadContext =
  # Manifest validation and block/window-size calculations omitted.
  result = DownloadContext(
    transport: desc.transport,
    md: desc.md,
    totalBlocks: totalBlocks,
    scheduler: Scheduler.new(),
    swarm: Swarm.new(),
  )
  # Availability-tracker initialization follows.
```

The worker later reads `download.ctx.transport` whenever it selects the protocol instance and scheduling state. The following sections explain those objects before returning to provider discovery and stream reads.

## Keeping peer connections separate

### Two instances of the same libp2p protocol type

`BlockExcNetwork` implements the BlockExchange libp2p protocol and inherits from `LPProtocol`. Its declaration is in `storage/blockexchange/network/network.nim`. The following excerpt shows the fields relevant here; the declaration also contains lifecycle and concurrency state:

```nim
BlockExcNetwork* = ref object of LPProtocol
  peers*: Table[PeerId, NetworkPeer]
  switch*: Switch
  handlers*: BlockExcHandlers
  mixTransport*: MixTransport
  mixNetwork*: BlockExcNetwork
  transport: DownloadTransport
```

Storage constructs two instances of this type. The outer instance handles Direct peers and also provides the single mounted protocol entry point. Its `mixNetwork` field refers to the second instance, which handles Mix peers. Both instances use the same BlockExchange codec, message encoding, and message-processing implementation. Their peer tables and engine callbacks are separate.

That separation matters when the same provider participates in both a Direct and a Mix download. The provider has the same real peer ID in both cases, but `NetworkPeer` retains a sending connection. Sharing a peer table would allow one download to obtain a connection created for the other transport.

```text
network.peers[providerId]             → Direct NetworkPeer and sending connection
network.mixNetwork.peers[providerId]  → Mix NetworkPeer and sending connection
```

### Where the second instance comes from

The constructor has the following signature:

```nim
proc new*(
    T: type BlockExcNetwork,
    switch: Switch,
    connProvider: ConnProvider = nil,
    maxInflight = DefaultMaxInflight,
    transport = DownloadTransport.Direct,
): BlockExcNetwork
```

During construction, after creating the `LPProtocol` object and initializing its state, the constructor executes this branch:

```nim
self.transport = transport
if transport == DownloadTransport.Direct:
  self.mixNetwork =
    BlockExcNetwork.new(
      switch, maxInflight = maxInflight, transport = DownloadTransport.Mix
    )
```

The normal call selects `DownloadTransport.Direct`, so the outer instance constructs a second instance with `DownloadTransport.Mix`. The Mix instance does not construct another instance.

### Attaching MixTransport and registering session events

The protocol instance's `transport` field also determines how each protocol instance learns that a peer has become available or departed. During `BlockExcNetwork.init`, the outer instance subscribes to ordinary Switch peer events. The Mix instance skips those subscriptions: its application peers are identified by MixTransport sessions, not by the physical connections used to relay Mix packets.

The Mix instance receives its transport reference during Storage startup. `StorageServer.start` calls `startMixTransport` after creating the Mix protocol. The implementation in `storage/storage.nim` is:

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

Storage creates one `MixTransport` object and supplies that same object to BlockExchange and Manifest. The BlockExchange attachment has two responsibilities: make the transport available for outgoing dialing and subscribe to its session events. The Manifest attachment is a separate protocol-specific operation; the code below describes the BlockExchange operation.

The initial call targets the outer `BlockExcNetwork` instance stored at `s.storageNode.engine.network`. That call delegates to the Mix instance, as shown in `storage/blockexchange/network/network.nim`:

```nim
proc attachMixTransport*(self: BlockExcNetwork, mixTransport: MixTransport) =
  if self.transport == DownloadTransport.Direct:
    self.mixNetwork.attachMixTransport(mixTransport)
    return
  doAssert self.mixTransport.isNil, "MixTransport is already attached"

  proc sessionEventHandler(
      event: SessionEvent
  ): Future[void] {.async: (raises: [CancelledError]).} =
    case event.kind
    of SessionEventKind.Established:
      await self.registerPeer(event.peerId)
    of SessionEventKind.Closed:
      await self.unregisterPeer(event.peerId)

  self.mixTransport = mixTransport
  self.mixSessionEventHandler = sessionEventHandler
  mixTransport.addSessionEventHandler(sessionEventHandler)
```

After delegation, `self` refers to the Mix protocol instance. The assignment to `self.mixTransport` gives that instance's outgoing connection provider the transport it will later use for `dial`. The nested `sessionEventHandler` captures the same instance, so its calls to `registerPeer` and `unregisterPeer` operate on the Mix peer table.

Attachment registers the callback; it does not itself establish a session or add a remote peer. Later, when MixTransport publishes a session event:

- `Established` calls `registerPeer`, which creates or retrieves the corresponding `NetworkPeer` and invokes the engine's peer-joined callback.
- `Closed` calls `unregisterPeer`, which removes the protocol instance's peer and retained session entries and invokes the engine's peer-departed callback.

The callback above handles **MixTransport session events only**. Each Mix-enabled Storage node registers this callback on its own MixTransport instance. The callback runs both when that node establishes a session as the initiator and when that node accepts a session as the recipient. These are two roles within Mix communication, not a distinction between Direct and Mix communication.

For the same Mix session between nodes A and B, where A initiated the session:

- On A, the MixTransport `Established` event carries B's real peer ID. A's `sessionEventHandler` registers B in A's Mix BlockExchange peer table.
- On B, the MixTransport `Established` event carries the anonymous session ID representing A. B's `sessionEventHandler` registers that identity in B's Mix BlockExchange peer table.

Ordinary Direct peer membership follows a different callback: the outer protocol instance's `peerEventHandler`, registered with the Switch. That callback handles Switch `Joined` and `Left` events. It does not receive the MixTransport session events described here.

Storage attaches the callbacks before starting MixTransport, so they are registered when the transport begins operating. If transport startup fails, the cleanup path detaches both protocols. BlockExchange retains the callback in `mixSessionEventHandler` so `detachMixTransport` can remove that exact subscription.

A Switch connection to a Mix relay therefore does not, by itself, add a peer to the Mix BlockExchange table. That table's lifecycle notifications come from established application sessions. The outer protocol instance continues to handle ordinary Switch peer events, subject to its relay exclusions.

### One mounted protocol entry point

In `storage/storage.nim`, Storage constructs `network = BlockExcNetwork.new(switch)` and later calls `switch.mount(network)`. Storage does not mount `network.mixNetwork` separately. There is one registration of the BlockExchange codec.

An ordinary incoming connection reaches the mounted handler through libp2p protocol selection. A Mix opening reaches the same handler differently: MixTransport looks up the requested BlockExchange codec in the Switch's protocol registry and invokes the registered handler with a `TransportStream`. Because `TransportStream` inherits from `Connection`, the handler accepts either connection type through its normal parameter.

The Switch registration is therefore also the application-protocol registry used by MixTransport. Mix application bytes do not need to pass through an additional ordinary connection before reaching BlockExchange.

### Selecting the peer table for an incoming connection

The method that installs the protocol handler is:

```nim
method init*(self: BlockExcNetwork) {.raises: [].}
```

Inside `init`, the following nested procedure is assigned to `self.handler`:

```nim
proc handler(
    conn: Connection, proto: string
): Future[void] {.async: (raises: [CancelledError]).} =
  let peerId = conn.peerId
  if conn of TransportStream and not self.mixNetwork.isNil:
    let peer = self.mixNetwork.getOrCreatePeer(peerId)
    await peer.readLoop(conn)
    return

  let blockexcPeer = self.getOrCreatePeer(peerId)
  await blockexcPeer.readLoop(conn)
```

For the mounted outer instance, `self.mixNetwork` refers to the Mix protocol instance. The runtime type check `conn of TransportStream` selects that instance's peer table. Ordinary connections use the outer instance's peer table.

Nothing copies or converts the connection. The handler selects a `NetworkPeer` and starts that peer's read loop on the original connection. On a Mix session recipient, `conn.peerId` is the anonymous session identity; on the session initiator, it is the real destination identity.

### Why decoded messages continue along the selected path

Peer creation is performed by:

```nim
proc getOrCreatePeer(self: BlockExcNetwork, peer: PeerId): NetworkPeer
```

For a new peer, this procedure creates callbacks bound to the selected protocol instance. For example, the decoded-message callback is:

```nim
let rpcHandler = proc(p: NetworkPeer, msg: Message) {.async: (raises: []).} =
  await self.rpcHandler(p, msg)
```

Here `self` is whichever instance received the `getOrCreatePeer` call. A peer created through `self.mixNetwork.getOrCreatePeer` consequently sends decoded messages to the Mix instance's message handler.

The engine separately installs callbacks on `network.handlers` and `network.mixNetwork.handlers`. The Mix callbacks pass `DownloadTransport.Mix` into the engine's handling operations. Thus, connection selection determines the peer object, the peer object determines the protocol instance receiving decoded messages, and that instance's callbacks identify the transport to the engine. The message itself does not need an extra Direct/Mix field.

### Selecting the protocol instance for outgoing work

For outgoing work, the download already contains its transport choice. The engine selects the instance using:

```nim
func networkFor*(
    self: BlockExcNetwork, transport: DownloadTransport
): BlockExcNetwork =
  if transport == DownloadTransport.Mix: self.mixNetwork else: self
```

The selected peer's connection provider calls either `Switch.dial` or `MixTransport.dial`. The next section follows that sending-connection path for a session recipient.

### Selecting engine peer state

The separation also extends to the BlockExchange engine, which keeps information used to schedule requests. A peer context contains the peer's performance statistics and a flag indicating whether a want-list operation is busy. An in-flight request tracker records unfinished requests for each peer so the engine can determine how many requests are already outstanding. The engine keeps separate Direct and Mix versions of both stores. Consequently, a slow Mix transfer to a provider does not alter the performance statistics or outstanding-request count used for a Direct transfer to that same provider.

The data structures make those responsibilities explicit. `peers/peercontext.nim` defines:

```nim
type PeerContext* = ref object of RootObj
  id*: PeerId
  stats*: PeerPerfStats
  wantListBusy*: bool
```

The request tracker in `engine/peertracker.nim` stores futures for outstanding work:

```nim
type PeerInFlightTracker* = ref object
  peerInFlight*: Table[PeerId, seq[Future[void]]]
```

In `engine/engine.nim`, the engine selects the appropriate stores through these functions:

```nim
func peersFor*(self: BlockExcEngine, transport: DownloadTransport): PeerContextStore =
  if transport == DownloadTransport.Mix: self.mixPeers else: self.peers

func trackerFor(
    self: BlockExcEngine, transport: DownloadTransport
): PeerInFlightTracker =
  if transport == DownloadTransport.Mix:
    self.mixPeerTracker
  else:
    self.downloadManager.peerTracker
```

The Direct tracker lives in `downloadManager.peerTracker`; the Mix tracker lives in `mixPeerTracker`. Both implement the same tracking operations.

### Removing the departed peer's transport-specific state

MixTransport shuts down a session before publishing its `Closed` session event. In `libp2p_mix_transport/transport.nim`, the teardown operation has the following order:

```nim
proc removeAndShutdownSession(
    self: MixTransport, session: TransportSession
) {.async: (raises: [CancelledError]).} =
  self.addressDestinations.del(session.sessionId)
  discard self.sessions.remove(session.sessionId)
  discard self.replyCredentials.removeSession(session.sessionId)
  await session.shutdown()
  await self.publishSessionEvent(session, SessionEventKind.Closed)
```

`session.shutdown` closes the session's streams and waits for their transport-owned tasks and protocol handlers to finish. Closing those connections also causes BlockExchange's read loops to exit. The cleanup in `NetworkPeer.readLoop` completes pending block-request futures with a `ConnectionClosed` error, allowing their callers to handle the failed requests. A download can continue by requesting its missing blocks from other peers.

The Mix session-event callback then notifies the engine that the Mix peer has departed. The engine removes that peer's Mix context and request-tracker entries so subsequent scheduling no longer uses the departed peer's old state. Application tasks may still be handling the reported request failures; the tracker cleanup does not wait for that higher-level processing. The same provider's Direct context, request-tracker entries, and connection are unaffected.

The engine constructor installs `mixPeerDeparted` as the Mix protocol instance's `onPeerDeparted` callback:

```nim
proc mixPeerDeparted(peer: PeerId) {.async: (raises: [CancelledError]).} =
  self.evictPeer(peer, DownloadTransport.Mix)
```

The callback passes the transport choice explicitly to `evictPeer`. That procedure uses the selection functions above:

```nim
proc evictPeer(self: BlockExcEngine, peer: PeerId, transport: DownloadTransport) =
  trace "Evicting disconnected/departed peer", peer
  self.peersFor(transport).remove(peer)
  self.trackerFor(transport).clearPeer(peer)
```

The tracker's cleanup operation is simply:

```nim
proc clearPeer*(self: PeerInFlightTracker, peerId: PeerId) =
  self.peerInFlight.del(peerId)
```

None of these operations selects the Direct store when the callback supplies `DownloadTransport.Mix`.

### Connecting the download context to its swarm

A swarm is the set of peers selected for one download. The download already records whether it uses Direct or Mix, and the engine uses that choice to select the appropriate protocol instance, peer-context store, and request tracker. A Mix download therefore interprets every peer in its swarm as a Mix peer; a Direct download interprets every peer as a Direct peer.

The relevant fields of `DownloadContext`, declared in `engine/downloadcontext.nim`, are:

```nim
DownloadContext* = ref object
  transport*: DownloadTransport
  # Other download state omitted.
  swarm*: Swarm
```

At the start of `downloadWorker` in `engine/engine.nim`, the same context value selects all three objects used to communicate and schedule work. This excerpt shows the procedure's signature and initial selection; the scheduling loop follows in the implementation:

```nim
proc downloadWorker(
    self: BlockExcEngine, download: ActiveDownload
) {.async: (raises: []).} =
  let
    treeCid = download.treeCid
    retryInterval = self.downloadManager.retryInterval
    peers = self.peersFor(download.ctx.transport)
    network = self.network.networkFor(download.ctx.transport)
    peerTracker = self.trackerFor(download.ctx.transport)
  # Logging and the scheduling loop follow.
```

The swarm itself, declared in `engine/swarm.nim`, therefore needs no separate transport component in its peer-table keys:

```nim
Swarm* = ref object
  config*: SwarmConfig
  peers: Table[PeerId, SwarmPeer]
  removedPeers: HashSet[PeerId]
```

For example, two downloads may both include provider P: the Direct download uses P's Direct connection and context, while the Mix download uses P's Mix connection and context. Each swarm can store P using its `PeerId` alone, because the owning download supplies the transport choice. There is no need to store a `(PeerId, transport)` pair for every swarm member.

There is one shared limit to distinguish from this separate state: both incoming paths use the outer, mounted `LPProtocol` instance's incoming-stream reservations. Creating the second instance does not create a second independently mounted protocol quota.

## Sending replies from the anonymous recipient

BlockExchange uses a retained outgoing connection for presence messages. This is now the same policy for Direct and Mix peers. An incoming stream runs the protocol's read loop; it is not automatically adopted as the peer's outgoing connection.

### Installing the peer's connection provider

The default Direct/Mix dialing choice is made inside `getOrCreatePeer` in `storage/blockexchange/network/network.nim`:

```nim
proc getOrCreatePeer(self: BlockExcNetwork, peer: PeerId): NetworkPeer
```

If the peer already exists in this protocol instance's table, the procedure returns that peer. For a new peer, the procedure creates the following `getConn` callback. `ConnProvider` is the callback type through which `NetworkPeer` asks for a connection; the callback captures the owning protocol instance as `self` and the remote identity as `peer`.

```nim
var getConn: ConnProvider = proc(): Future[Connection] {.
    async: (raises: [CancelledError])
.} =
  case self.transport
  of DownloadTransport.Mix:
    if self.mixTransport.isNil:
      return nil
    trace "Opening block exchange stream via MixTransport", peer
    let stream = (await self.mixTransport.dial(peer, Codec)).valueOr:
      trace "Unable to open MixTransport block exchange stream", peer, error
      return nil
    return stream

  of DownloadTransport.Direct:
    try:
      trace "Getting new connection stream", peer
      return await self.switch.dial(peer, Codec)
    except CancelledError as error:
      raise error
    except CatchableError as exc:
      trace "Unable to connect to blockexc peer", exc = exc.msg
```

The `transport` field selects the dialing branch. In the Mix branch, `mixTransport` determines whether the service is available; if the reference is nil or dialing fails, the callback returns nil without trying Direct. The Direct branch uses `Switch.dial`. Thus the instance's transport choice and the availability of its Mix service are separate pieces of state.

Both successful branches return a `Connection`. A `TransportStream` satisfies that type through inheritance, so `NetworkPeer` can use the same read, write, and connection-reuse logic for either transport.

The enclosing `getOrCreatePeer` passes this callback as the connection-provider argument to `NetworkPeer.new`, alongside the message callbacks described earlier. The constructor also supports an explicitly supplied `ConnProvider`, which replaces this default callback; normal Storage startup supplies none.

### Reusing or replacing the sending connection

When the recipient sends presence, `NetworkPeer.send` asks `connect` for the sending connection:

```nim
proc connect*(
    self: NetworkPeer
): Future[Connection] {.async: (raises: [CancelledError]).} =
  if self.connected:
    trace "Already connected", peer = self.id, connId = self.sendConn.oid
    return self.sendConn

  self.sendConn = await self.getConn()
  self.trackedFutures.track(self.readLoop(self.sendConn))
  return self.sendConn
```

The Mix protocol instance installs `getConn` in `BlockExcNetwork.getOrCreatePeer`. That callback calls `mixTransport.dial(peer, Codec)`. For a session recipient, `peer` is the anonymous session ID. MixTransport finds the existing session and opens a new stream within it; the recipient does not discover the initiator's real address or establish a replacement session.

The requester must have the BlockExchange protocol mounted, because this new stream invokes its protocol handler. The resulting stream is retained as `sendConn`, so subsequent presence messages reuse it rather than paying another opening handshake each time. If that stream closes while the session remains healthy, the next send can open a replacement without waiting for a new incoming stream.

Mix session events govern peer membership, while the retained sending connection belongs to `NetworkPeer`. Opening a replacement stream does not create a replacement session.

Block responses continue to use the stream carrying their request. Each BlockExchange message or block response is submitted as one connection write; MixTransport serializes writes before fragmenting them.

The transport walkthrough, **Mix Transport Implementation Walk Through - Recipient-Originated Streams**, explains the direction-specific opening handshake and shared duplicate-opening history.

## Using provider addresses

Manifest discovery and block-provider discovery both return `PeerRecord` values. A record can contain ordinary addresses and Mix advertisements. For a Mix request, `mixAddresses` decodes each advertisement and checks its embedded public key against the record's peer ID:

```nim
func mixAddresses*(
    peer: PeerId, addresses: openArray[MultiAddress]
): seq[MultiAddress] =
  for address in addresses:
    if MixPubInfo.fromMixAddress(address, Opt.some(peer)).isOk:
      result.add(address)
```

The Mix connection path rejects a provider if no validated Mix address remains. Otherwise, BlockExchange calls the address-aware `MixTransport.connect`, and manifest fetching calls the address-aware `MixTransport.dial`. The explicit destination supplies the final Mix hop; it does not have to be added to the relay pool. Subsequent streams can reuse the established session through the peer-ID overload.

The Direct path removes Mix advertisements before passing addresses to the Switch. A provider with no ordinary address is not dialed by that path. An advertisement is contact information, not a guarantee of reachability or support for the requested application protocol; connection and stream establishment still report those failures.

### Fetching the manifest through the selected connection

`ManifestProtocol.fetchManifest` checks for locally available content and otherwise calls discovery to obtain providers. For each attempted provider, it calls `fetchManifestFromPeer` with the download's transport choice. The complete per-provider operation in `storage/manifest/protocol.nim` shows where transport-specific dialing ends and ordinary protocol I/O begins:

```nim
proc fetchManifestFromPeer(
    self: ManifestProtocol, peer: PeerRecord, cid: Cid, transport: DownloadTransport
): Future[?!bt.Block] {.async: (raises: [CancelledError]).} =
  var conn: Connection
  try:
    if transport == DownloadTransport.Mix:
      if self.mixTransport.isNil:
        return failure("Mix transport is not enabled")
      let addresses = mixAddresses(peer.peerId, peer.addresses.mapIt(it.address))
      if addresses.len == 0:
        return failure("Provider has no usable Mix address")
      conn = (
        await self.mixTransport.dial(peer.peerId, addresses, ManifestProtocolCodec)
      ).valueOr:
        return failure(
          "Error opening MixTransport manifest stream to " & $peer.peerId & ": " & error
        )
    else:
      let addresses = directAddresses(peer.addresses.mapIt(it.address))
      if addresses.len == 0:
        return failure("Provider has no direct address")
      conn = await self.switch.dial(peer.peerId, addresses, ManifestProtocolCodec)

    let cidBytes = cid.data.buffer
    var reqBuf = newSeqUninit[byte](2 + cidBytes.len)
    let cidLenLE = cidBytes.len.uint16.toLE
    copyMem(addr reqBuf[0], unsafeAddr cidLenLE, 2)
    if cidBytes.len > 0:
      copyMem(addr reqBuf[2], unsafeAddr cidBytes[0], cidBytes.len)
    await conn.write(reqBuf)

    without (status, data) =? await readManifestResponse(conn), err:
      return failure(err)

    if status == ManifestFetchStatus.NotFound:
      return failure(
        newException(BlockNotFoundError, "Manifest not found on peer " & $peer.peerId)
      )

    without blk =? bt.Block.new(cid, data, verify = true), err:
      return failure("Manifest CID verification failed: " & err.msg)

    return success blk
  except CancelledError as exc:
    raise exc
  except CatchableError as exc:
    return failure("Error fetching manifest from peer " & $peer.peerId & ": " & exc.msg)
  finally:
    if not conn.isNil:
      await conn.close()
```

Only the connection-establishment branch differs. Both paths then encode the same manifest request, read the same response format, and verify the returned bytes against the requested CID. The `finally` block closes the manifest stream, not the whole Mix session. That session can subsequently carry BlockExchange streams to the same provider.

A Mix dialing failure returns from the Mix branch. Execution does not continue into the Direct branch. Retrying another provider therefore retains the selected transport.

### Establishing a BlockExchange provider session

Block-provider discovery uses `BlockExcNetwork.dialPeer` rather than the Manifest helper. The procedure is declared in `storage/blockexchange/network/network.nim`:

```nim
proc dialPeer*(self: BlockExcNetwork, peer: PeerRecord) {.async.}
```

After checking availability, self-dialing, and any reusable Direct peer, its Mix branch performs:

```nim
if self.transport == DownloadTransport.Mix:
  let mixTransport = self.mixTransport
  trace "Connecting to peer via MixTransport", peer = peer.peerId
  let addresses = mixAddresses(peer.peerId, peer.addresses.mapIt(it.address))
  if addresses.len == 0:
    raise newException(StorageError, "Provider has no usable Mix address")
  let session = (await mixTransport.connect(peer.peerId, addresses)).valueOr:
    raise newException(StorageError, "Failed to connect over MixTransport: " & error)
  self.mixSessions[peer.peerId] = session
```

This step obtains a session. A later BlockExchange send obtains an application stream through the connection provider described earlier. Keeping these steps separate lets discovery supply and validate the provider's addresses while subsequent sends reuse the established session.

## Discovery and swarm admission

Discovery requests are keyed by `(CID, transport)`. Requests for the same CID over different transports can therefore both establish their intended connection type. This key controls provider dialing, not the DHT lookup mechanism itself.

The queued request type and insertion operation in `engine/discovery.nim` are:

```nim
type DiscoveryKey = tuple[cid: Cid, transport: DownloadTransport]

proc queueFindBlocksReq*(
    b: DiscoveryEngine,
    cids: seq[Cid],
    transport: DownloadTransport = DownloadTransport.Direct,
) =
  for cid in cids:
    let key = (cid, transport)
    if key notin b.discoveryQueue:
      try:
        b.discoveryQueue.putNoWait(key)
      except CatchableError as exc:
        warn "Exception queueing discovery request", exc = exc.msg
```

The background consumer has this signature:

```nim
proc discoveryTaskLoop(b: DiscoveryEngine) {.async: (raises: []).}
```

For each queued key, the loop calls `b.discovery.find(key.cid)`. Once provider records arrive, the loop chooses `b.network.networkFor(key.transport)` for their `dialPeer` calls and waits for those attempts to finish. The underlying discovery call does not receive `key.transport`: direct versus private DHT queries remain governed by discovery's own configuration.

After dialing the returned providers, the discovery engine calls `onProviders`. The engine constructor registers the following discovery callback. Its parameters identify the discovered CID, the requested transport, and the returned provider records:
```nim
discovery.onProviders = proc(
    cid: Cid, transport: DownloadTransport, providers: seq[PeerRecord]
) {.gcsafe, raises: [].} =
  for downloads in self.downloadManager.downloads.values:
    for download in downloads.values:
      if download.manifestCid == cid and download.ctx.transport == transport:
        download.ctx.providerPeers.clear()
        for provider in providers:
          if provider.peerId in self.peersFor(transport):
            download.ctx.providerPeers.incl(provider.peerId)
```

The callback updates only downloads with the matching manifest CID and transport. A returned record becomes a candidate only if its peer is present in the selected engine peer store. The worker's `candidatePeers` operation uses this recorded set.

The worker obtains its initial candidates through this procedure in `engine/engine.nim`:

```nim
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

The first loop admits only connected peers recorded as providers for this download. The second loop is conditional on Direct mode; it appends other Direct peers as fallback candidates.

A Mix download probes only these content-specific providers. A Direct download retains the existing fallback of probing other direct peers when considering candidates, after known providers. This preserves existing direct transfers between connected nodes while preventing unrelated Mix sessions from becoming a Mix download's initial swarm.

Selecting a candidate is not the same as admitting that peer into the swarm. Before sending a presence request, the caller uses `ActiveDownload.addPeerIfAbsent` in `engine/activedownload.nim`:

```nim
proc addPeerIfAbsent*(
    download: ActiveDownload, peerId: PeerId, availability: BlockAvailability
): bool =
  let existingPeer = download.ctx.swarm.getPeer(peerId)
  if existingPeer.isSome:
    # peer already tracked, skip if bakComplete
    return existingPeer.get().availability.kind != bakComplete

  return download.ctx.swarm.addPeer(peerId, availability)
```

For a new peer, the returned Boolean is the swarm's admission result. If the swarm is full or refuses a previously removed peer, the caller does not send a presence request as though admission succeeded. For a peer already present, the helper allows further work unless availability is already complete.

### Applying presence to the matching downloads

A presence response describes which blocks a peer can supply. The protocol-instance callbacks introduced earlier pass that response and the receiving transport to the engine's handler in `engine/engine.nim`:

```nim
proc blockPresenceHandler*(
    self: BlockExcEngine,
    peer: PeerId,
    blocks: seq[BlockPresence],
    transport: DownloadTransport = DownloadTransport.Direct,
) {.async: (raises: []).}
```

The handler first obtains the peer context from `self.peersFor(transport)`. For each positive presence entry, it finds the addressed download using the response's download ID and tree CID. Updating availability is guarded by both existence and transport:

```nim
if downloadOpt.isSome and downloadOpt.get().ctx.transport == transport:
  # Convert the presence entry to BlockAvailability.
  # Then updatePeerAvailability applies that value to the download's swarm.
```

The same handler can share the resulting availability with other downloads of that tree, but only when `otherDownload.ctx.transport == transport`. Therefore, a directly received response cannot add availability to a Mix download's swarm, even when both downloads concern the same tree and provider.

## Streaming reads and shared local content

The streaming REST endpoint passes the transport choice through `StorageNodeRef.retrieve` to `streamEntireDataset`. The latter creates a download and returns a `StoreStream` that reads blocks as they become available. Each missing-block read must wait on that particular download, because multiple downloads of the same tree can be running with different transport choices.

The beginning of `streamEntireDataset` in `storage/node.nim` creates the download and a store view tied to its ID:

```nim
proc streamEntireDataset(
    self: StorageNodeRef,
    md: ManifestDescriptor,
    fetchLocal: bool = false,
    transport: DownloadTransport = DownloadTransport.Direct,
): Future[?!LPStream] {.async: (raises: [CancelledError]).} =
  # Logging omitted.
  let
    treeCid = md.manifest.treeCid
    download = ?self.engine.startTreeDownloadOpaque(
      md, fetchLocal = fetchLocal, transport = transport
    )
    downloadStore = NetworkStore.new(
      self.engine, self.networkStore.localStore, downloadId = some(download.downloadId)
    )
    stream = LPStream(StoreStream.new(downloadStore, md.manifest, pad = false))
  # Completion and cancellation task setup follows.
```

The `NetworkStore` constructor in `storage/stores/networkstore.nim` retains the ID alongside the shared local store and engine references:

```nim
proc new*(
    T: type NetworkStore,
    engine: BlockExcEngine,
    localStore: BlockStore,
    downloadId: Option[uint64] = none(uint64),
): NetworkStore =
  NetworkStore(localStore: localStore, engine: engine, downloadId: downloadId)
```

When `StoreStream` asks for a block by tree address, the view executes:

```nim

method getBlock*(
    self: NetworkStore, address: BlockAddress
): Future[?!Block] {.async: (raises: [CancelledError]).} =
  let downloadOpt =
    if self.downloadId.isSome:
      self.engine.downloadManager.getDownload(self.downloadId.get(), address.treeCid)
    else:
      self.engine.downloadManager.getDownload(address.treeCid)
  if downloadOpt.isSome:
    let handle = downloadOpt.get().getWantHandle(address)
    without blk =? (await self.localStore.getBlock(address)), err:
      if not (err of BlockNotFoundError):
        handle.cancelSoon()
        return failure err
      return await handle
    discard downloadOpt.get().completeWantHandle(address, some(blk))
    return success blk

  return await self.localStore.getBlock(address)
```

The first branch selects the download by both ID and tree CID. The unscoped branch selects by tree CID alone. If a matching download exists, `getWantHandle` obtains the future through which that download supplies the requested block.

The local store is checked before waiting. A missing block causes a wait on the selected handle; another local-store error cancels that handle and returns the error. If no matching download remains, the operation only checks local content—it does not select a different download to replace the scoped one.

The scoped view therefore follows its own download's scheduler and cancellation state. Callers that omit `downloadId` use the tree-CID lookup shown in the other branch.

Both transports still share the local content-addressed store. A verified block already available locally can satisfy either download without another network request. The selected transport governs network connections; it does not partition cached content by the route through which the content arrived.
