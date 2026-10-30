An application writes to a MixTransport stream. MixTransport divides the bytes into transport frames and asks Mix to carry each frame as a message. Mix knows how to route those messages anonymously; MixTransport knows how to turn them back into an ordered stream.

This walk-through follows the communication between session initiator **A** and session recipient **B**. It shows how A creates SURBs for B, sends a transport frame to B through Mix, and receives a transport frame sent back by B using one of those SURBs.

B is also the final Mix hop for forward delivery. “Forward” always means A to B and “reverse” always means B to A, even when B opens a new stream.

For the API changes themselves, see [[Mix Protocol API Changes for MixTransport]]. The protocol rules are defined in [[Mix Transport Design Specification]].

## Presentation

The title slide is embedded below; the linked drawing contains the complete deck. The slides summarize the implementation described in this walkthrough and [[Mix Protocol API Changes for MixTransport]].

> This presentation is an Obsidian Excalidraw drawing. To view it, open this vault in Obsidian with the Excalidraw plugin installed and enabled.

![[MixTransport and Mix Protocol Presentation.excalidraw#^frame=flowTitle2026]]

## 1. The boundary and its responsibilities

| Layer                                | Responsibility                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Application protocol                 | Opens streams and reads/writes application bytes                                                                                               |
| MixTransport                         | Sessions, stream IDs, Data sequencing, ACKs, flow control, retransmission, SURB inventory and credential lifetime                              |
| Mix Protocol                         | Path selection, Mix-message framing, Sphinx construction and processing, sender/relay delays, optional spam protection, first-hop transmission |
| libp2p connections between Mix nodes | Carry packets to the next hop using `/mix/1.0.0`                                                                                               |

There are three distinct protocol identifiers in play:

- The application's codec is carried in `OpenStream.codec` and selects the application handler at the remote endpoint.
- `/libp2p/mix-transport/1.0.0` selects MixTransport's forward-message callback.
- `/mix/1.0.0` is used on the underlying libp2p connections between Mix nodes.

A transport frame is opaque payload to Mix. Mix does not interpret `sessionId`, `streamId`, or transport ACKs.

## 2. Round-trip illustration

The diagram separates forward delivery from SURB-based reverse delivery. The middle arrows represent a path through relays, not a direct physical connection between A and B.

![[MixTransport Mix Protocol Boundary.svg]]

> The original diagram is an Obsidian Excalidraw drawing. To edit it, open this vault in Obsidian with the Excalidraw plugin installed and enabled.

![[MixTransport Mix Protocol Boundary.excalidraw]]

## 3. Attach the two receiving callbacks

Each endpoint creates its MixTransport instance using an existing `MixProtocol`. In Logos Storage, `StorageServer.enableMix` prepares two separate inputs: `mixNodeInfo`, containing this node's identity, address, and key material, and `relayPool`, containing the public Mix information of the configured relays.

Storage loads the relay records from inline JSON when `mixPoolJson` is configured, or otherwise from the file specified by `mixPool`. The following excerpt shows that loading step followed by construction of the protocol instance:

```nim
let
  relayPool = (
    if self.config.mixPoolJson.len > 0:
      loadRelayPubInfoTableFromJson(self.config.mixPoolJson)
    else:
      loadRelayPubInfoTableFromFile(self.config.mixPool)
  ).valueOr:
    raise newException(StorageError, "Failed to load Mix relay pool: " & error.msg)
  mixProto = MixProtocol.new(mixNodeInfo, switch)
```

After construction, Storage adds the loaded relay records to `mixProto.nodePool`. It then configures the legacy DHT proxy response reader, starts Mix, and mounts it on the Switch:

```nim
for info in relayPool.values:
  mixProto.nodePool.add(info)

mixProto.registerDestReadBehavior(DhtProxyCodec, readLp(MaxLookupResponseBytes))
await mixProto.start()
switch.mount(mixProto)
```

During node startup, this same `mixProto` instance is then passed to `startMixTransport`:

```nim
proc startMixTransport*(
    s: StorageServer, mixProto: MixProtocol
) {.async: (raises: [CancelledError, StorageError]).} =
  if not s.config.mixEnabled or mixProto.isNil:
    return

  let mixTransport = newMixTransport(mixProto)
  s.storageNode.engine.enableMixNetwork(mixTransport)
  s.storageNode.manifestProtocol.attachMixTransport(mixTransport)
  (await mixTransport.start()).isOkOr:
    await s.storageNode.engine.disableMixNetwork()
    s.storageNode.manifestProtocol.detachMixTransport()
    raise newException(StorageError, "Failed to start MixTransport: " & error)
  s.mixTransport = mixTransport
```

The injection happens at `newMixTransport(mixProto)`: MixTransport retains that existing Mix protocol instance in its `mix` field. It does not construct another Mix protocol or another Switch. BlockExchange and the manifest protocol receive the resulting MixTransport instance, so both use the same underlying Mix service.

Source: [StorageServer construction and startup](https://github.com/logos-storage/logos-storage-nim/blob/acbb81080cb7f422f8f4c1cb44de7185d659146d/storage/storage.nim#L85).

Calling `mixTransport.start()` registers the two ways messages can arrive.

The relevant calls are:

```nim
self.mix.registerMixDeliveryHandler(
  MixTransportCodec, deliveryHandler
)

self.mix.registerRawSurbReplyHandler(rawSurbReplyHandler)
```

The closures forward to `self.handleDelivery(delivery)` and `self.handleRawSurbReply(reply)`, respectively. The actual implementation checks registration results and rolls back the service registration if raw-reply registration fails.

These are different callbacks because the inputs differ:

- Forward delivery already contains a decoded Mix message and its service identifier.
- A returning SURB packet supplies an identifier and encrypted reply payload; the transport must find the credential before obtaining the frame.

Registration is per transport instance, not per session or stream. Session and stream dispatch happen later inside MixTransport.

Source: [start](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L1371).

### 3.1 Forward delivery: `handleDelivery`

`handleDelivery` is implemented by MixTransport. Its argument type `MixDelivery` is defined by Mix in `libp2p_mix/mix_protocol.nim` and exported through the `libp2p_mix` facade:

The transport handler has the following full signature:

```nim
proc handleDelivery(
    self: MixTransport, delivery: MixDelivery
): Future[void] {.async: (raises: [CancelledError]).}
```

`self` is the local MixTransport instance captured by the registered closure. Mix supplies the other argument, `delivery`:

```nim
type MixDelivery* = object
  service*: string
  payload*: seq[byte]
```

- `service` is the Mix service identifier that selected the callback: here, `/libp2p/mix-transport/1.0.0`.
- `payload` contains the encoded transport frame, after Mix has processed Sphinx and removed its message framing and padding. MixTransport must still decode and validate these bytes as a transport frame.

`Future[void]` lets Mix await completion of the handler without expecting a returned value. Any response is sent as a separate message, not returned through this future. The async effect annotation allows cancellation to propagate as `CancelledError`.

The closure connects this transport handler to `MixDeliveryHandler`, the callback type defined by Mix in `libp2p_mix/mix_protocol.nim`:

```nim
let deliveryHandler: MixDeliveryHandler = proc(
    delivery: MixDelivery
): Future[void] {.async: (raw: true, raises: [CancelledError]).} =
  self.handleDelivery(delivery)
```

### 3.2 Returning SURB packets: `handleRawSurbReply`

`handleRawSurbReply` is also implemented by MixTransport. Its input type `RawSurbReply` is defined by Mix in `libp2p_mix/sphinx.nim` and exported through `libp2p_mix`:

The corresponding reverse-path handler has this full signature:

```nim
proc handleRawSurbReply(
    self: MixTransport, reply: RawSurbReply
): Future[RawSurbReplyDisposition] {.async: (raises: [CancelledError]).}
```

Again, `self` is captured locally. Mix supplies `reply` after Sphinx processing recognizes a returning SURB packet:

```nim
type RawSurbReply* = object
  identifier*: SURBIdentifier
  encryptedPayload*: seq[byte]
```

- `identifier` selects the locally retained reply credential. It is not a session ID or stream ID.
- `encryptedPayload` is the returning payload that still requires credential-based recovery. It cannot yet be decoded as a transport frame.

`RawSurbReplyDisposition` is defined by Mix in `libp2p_mix/mix_protocol.nim`. The result tells Mix whether this handler claims the packet:

```nim
type RawSurbReplyDisposition* {.pure.} = enum
  Unhandled
  Handled
```

`Handled` means MixTransport has claimed the reply, including a recognized reply that it discards as invalid or retired. `Unhandled` means the reply identifier matches neither an active reply credential nor a temporarily remembered identifier of a retired credential (see Section 3.4). Mix can then try its legacy connection-associated credential store. This result is a local dispatch decision, not an acknowledgement sent to the remote endpoint.

The registered closure implements `RawSurbReplyHandler`, another callback type defined by Mix in `libp2p_mix/mix_protocol.nim`:

```nim
let rawSurbReplyHandler: RawSurbReplyHandler = proc(
    reply: RawSurbReply
): Future[RawSurbReplyDisposition] {.
    async: (raw: true, raises: [CancelledError])
.} =
  self.handleRawSurbReply(reply)
```

In both closures, `async: (raw: true, ...)` permits returning the handler's future directly. The extra `self` argument belongs to MixTransport; Mix's callback interface only supplies the delivery or reply.

Sources: [transport handlers](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L796), [Mix callback types](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L39).

### 3.3 Reply credentials: what A keeps and why

When A creates a SURB, Mix also produces the matching **reply credential**. B receives the SURB so it can construct a message back to A. A keeps the credential so it can recover that message when it arrives.

`ReplyCredential` is defined by Mix in `libp2p_mix/sphinx.nim` and exported through `libp2p_mix`. Its implementation is:

```nim
type ReplyCredential* = object
  identifier: SURBIdentifier
  key: serialization.Key
  secret: serialization.Secret
```

| Field | Purpose |
| --- | --- |
| `identifier` | Matches an incoming `RawSurbReply` to this credential. |
| `key` | The reply key also carried in the SURB. B uses it to encrypt the reply payload; A uses it during recovery. |
| `secret` | A sequence of per-hop shared secrets generated when constructing the SURB's return path. A needs them to reverse the payload transformations performed along that path. |

The credential fields are private to the Mix implementation. The exported `identifier(credential)` accessor allows MixTransport to index credentials without accessing the cryptographic material directly.

Although the SURB contains the reply key, it does not contain the return-path secrets. B can use the SURB without receiving A's full credential. A passes its retained credential and the arriving raw reply to `recoverReply`; Mix performs the cryptography and returns the original payload bytes.

MixTransport stores additional metadata beside the credential: its session ID and expiry time. The session association tells the transport which session the recovered frame must belong to; expiry bounds how long credentials are retained when replies never arrive. Neither is a field of `ReplyCredential` itself.

Sources: [ReplyCredential and recovery](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/sphinx.nim#L174), [transport credential storage](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/reply_credentials.nim).

### 3.4 Remembering retired reply identifiers

After A successfully recovers a reply, MixTransport removes the corresponding credential from its active store. It no longer needs that credential's cryptographic material, but it temporarily remembers the identifier. This record says: “this reply belongs to MixTransport, but its credential has already been retired.”

The removal and retention happen together in `ReplyCredentialStore.consume`:

```nim
let expiresAt = store.credentials.getOrDefault(identifier).expiresAt
store.credentials.del(identifier)
store.rememberRetiredIdentifier(identifier, expiresAt, now)
```

If a later packet reaches the raw-reply callback with that identifier, the transport can discard it immediately:

```nim
if self.replyCredentials.isRetiredIdentifier(reply.identifier):
  return RawSurbReplyDisposition.Handled
```

Without the retained identifier, the transport would no longer recognize the packet and would return `Unhandled`, causing Mix to try its legacy connection-associated credential store. Retention avoids that unnecessary fallback; it does not recover the payload again.

Session cleanup also retires its outstanding credentials and remembers their identifiers, so a late reply for a closed session can be recognized in the same way. A credential is also consumed when cryptographic recovery succeeds but decoding the recovered Mix message fails.

Only the identifier and its original expiry time are retained—not the key, path secrets, or recovered payload. Retiring a credential does not restart its lifetime. Retention lasts at most until its original expiry; the bounded identifier store may evict a record earlier under capacity pressure. Expired credentials are removed without starting a new retention period.

This bookkeeping belongs to MixTransport's `ReplyCredentialStore`. Mix Protocol only receives the resulting `Handled` or `Unhandled` decision. It is also separate from transport-frame deduplication: two redundant copies sent through different SURBs have different reply identifiers, even when they carry the same transport frame.

Source: [credential consumption, session removal, and bounded identifier retention](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/reply_credentials.nim).

### 3.5 Two credential stores, two communication models

Mix and MixTransport each maintain a credential store. They use the same reply-recovery API, but associate replies with different local objects.

**Mix's connection-associated store** serves the original `MixEntryConnection` request/reply interface:

1. An application writes a request through a reply-expecting `MixEntryConnection`.
2. Mix creates SURBs and registers their credentials in its own `SurbStore`, together with the connection's incoming queue.
3. When a reply arrives, Mix looks up its identifier and recovers the payload.
4. Mix places the recovered bytes in that queue, allowing the application to read the response through the connection.

“Connection-associated” refers to the local `MixEntryConnection` awaiting the response, not a physical libp2p connection to a relay. Credentials for redundant replies to the same request are grouped: the first valid reply releases the group. Connection cleanup and credential expiry also release retained credentials.

**MixTransport's session-associated store** serves persistent transport sessions. MixTransport explicitly calls `createSurb`, which returns a SURB and its credential without inserting the credential into Mix's connection-associated store. MixTransport registers it in its own `ReplyCredentialStore`, with a session ID and expiry time. The recovered bytes contain a transport frame, whose kind and optional stream ID determine further dispatch.

| Store | Local association | Destination of a recovered payload |
| --- | --- | --- |
| Mix `SurbStore` | A legacy connection's incoming queue and reply group | Application reads the response through `MixEntryConnection` |
| MixTransport `ReplyCredentialStore` | A transport session and credential expiry | MixTransport decodes and dispatches a transport frame |

Both kinds of reply first pass through Mix's Sphinx processing. The registered raw-reply callback determines which store should handle them:

```text
Returning SURB packet
  → Mix invokes MixTransport's raw-reply callback
      → Recognized: recover/process or discard; return Handled
      → Unknown: return Unhandled
          → Mix tries its connection-associated store
```

If no raw-reply callback is registered, Mix proceeds directly to its own store. If neither store recognizes the identifier, the packet is discarded.

The integration does not duplicate credentials between the stores. Each credential is registered by the communication model that created it. The overlap is in the packet-receiving path and cryptographic recovery operation, not in credential ownership.

Sources: [Mix credential registration](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L674), [raw-reply dispatch and connection fallback](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L421), [MixEntryConnection](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/entry_connection.nim).

## 4. A prepares SURBs before sending Connect

A initiates a session with B. Before sending `Connect`, A creates SURBs for B to use when sending messages back.

### 4.1 Where preparation happens

`createReplySurbs` is a private helper defined in **MixTransport's** `libp2p_mix_transport/transport.nim`. It calls **Mix Protocol's** public `createSurb` API once for each requested SURB.

For session establishment, the call sequence is:

```text
MixTransport.connectInternal
  → createConnectFrame
      → createReplySurbs
          → MixProtocol.createSurb (once per SURB)
  → encode the Connect frame
  → sendToDestination
```

The helper is also called by `sendOpenStream` for initiator-originated streams, `createAndSendSurbSupply` for replenishment, and `sendSurbStatusProbe` to provide return paths for a status response.

### 4.2 One creation result and the accumulated batch

MixTransport defines the helper's result type alongside the transport implementation:

```nim
type PreparedReplySurbs = object
  encoded: seq[seq[byte]]
  credentials: seq[ReplyCredential]
```

`prepared` is an instance of this type, accumulating all requested SURBs. Each call to Mix's `createSurb` returns one tuple containing `surb` and `credential`; after successful error unwrapping, that tuple is stored in the local variable `created`.

The complete helper shows how the two sequences are built:

```nim
proc createReplySurbs(
    self: MixTransport, destination: PeerId, sessionId: PeerId, count: int
): Result[PreparedReplySurbs, string] =
  let mixDestination = MixDestination.exitNode(destination)
  var prepared = PreparedReplySurbs(
    encoded: newSeqOfCap[seq[byte]](count),
    credentials: newSeqOfCap[ReplyCredential](count),
  )

  for _ in 0 ..< count:
    var created = self.mix.createSurb(mixDestination).valueOr:
      return err("could not create SURB: " & error)
    prepared.encoded.add(created.surb.serializeSurb())
    prepared.credentials.add(created.credential)

  self.replyCredentials.add(sessionId, prepared.credentials).isOkOr:
    return err("could not register reply credentials: " & error)

  ok(prepared)
```

The arguments identify the recipient (`destination`), the local transport session to associate with the credentials (`sessionId`), and how many SURBs to create (`count`). The destination passed to Mix is the recipient B; Mix constructs each SURB's return path to the local node A.

The result sequences are **aligned by index**:

| Entry | Contents | Purpose |
| --- | --- | --- |
| `prepared.encoded[i]` | Serialized bytes of the SURB from creation call `i` | Sent to B inside a transport frame |
| `prepared.credentials[i]` | Matching reply credential from that same call | Kept at A to recover a reply sent using that SURB |

For example, if B uses the SURB encoded in `prepared.encoded[2]`, A needs `prepared.credentials[2]` to recover the resulting reply. This index correspondence is local preparation bookkeeping. When a reply arrives, A looks up the credential by its `SURBIdentifier`, not by the sequence index.

`newSeqOfCap(count)` reserves space without adding entries. Each successful loop iteration appends one entry to each sequence, so a successful helper result contains exactly `count` entries in each.

Before returning, the helper registers all credentials in A's `ReplyCredentialStore`, associating them with `sessionId` and an expiry. The caller also receives the credential sequence so it can extract identifiers for supply tracking or retire credentials if preparation is abandoned. The `credentials` sequence is not serialized into the outgoing frame.

This work is synchronous: Mix selects return paths and constructs the SURB/credential pairs, and MixTransport stores the credentials. No message has been sent yet.

### 4.3 Put the SURBs into Connect

Inside `createConnectFrame`, the caller prepares the batch and assigns only its encoded SURBs to the frame:

```nim
let prepared = self.createReplySurbs(destination, session.sessionId, surbCount).valueOr:
  return err("could not prepare Connect reply SURBs: " & error)
frame.surbs = prepared.encoded
```

The current `Connect` carries five SURBs. Its first two are dedicated to `ConnectAck`; the remaining three form initial numbered session supply. The caller uses the corresponding credential identifiers when registering that numbered supply locally.

The session ID and supply sequence are transport associations; they are not fields in the serialized SURB. The reply identifier identifies a particular credential and is not the session ID.

After `createConnectFrame` returns, `connectInternal` encodes the frame and sends it through Mix. B receives the SURBs; A retains their credentials.

Sources: [PreparedReplySurbs](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L70), [createReplySurbs and supply callers](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L903), [createConnectFrame and connectInternal](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L1080), [sendOpenStream](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L1239).

## 5. Forward crossing: A sends an encoded transport frame

MixTransport encodes `Connect` and calls `sendToDestination`, a private helper in `libp2p_mix_transport/transport.nim`. The same helper is used for later forward frames.

### 5.1 Remembering the destination information for a session

Mix needs B's network address and Mix public key to construct the final hop of a forward path. A peer ID alone does not supply those details. MixTransport can obtain them from a Mix multiaddress supplied by its caller and keep them for subsequent sends in that session.

The `addressDestinations` field belongs to **MixTransport**:

```nim
addressDestinations: Table[PeerId, MixPubInfo]
```

Each entry associates a session with the information needed to send forward messages to its recipient. For example, `addressDestinations[sessionId]` holds B’s peer ID, network address, and public keys for that session.

The table’s key uses the `PeerId` type because MixTransport represents session identifiers with that type. Its value is a `MixPubInfo` object, defined by Mix as follows:

```nim
# Defined by Mix in libp2p_mix/mix_node.nim
type MixPubInfo* = object
  peerId*: PeerId
  multiAddr*: MultiAddress
  mixPubKey*: FieldElement
  libp2pPubKey*: SkPublicKey
```

Thus, an entry means: “for forward sends in session S, use this destination's peer identity, address, and public keys.” It is a per-session destination table, separate from Mix's relay pool and libp2p's peer store.

#### How an entry is created

MixTransport exposes two public `connect` overloads, defined in `libp2p_mix_transport/transport.nim`:

```nim
proc connect*(
    self: MixTransport, destination: PeerId, addrs: seq[MultiAddress]
): Future[Result[TransportSession, string]] {.async: (raises: [CancelledError]).}

proc connect*(
    self: MixTransport, destination: PeerId
): Future[Result[TransportSession, string]] {.async: (raises: [CancelledError]).}
```

In both overloads, `self` is the local transport and `destination` identifies the peer to connect to. The address-aware overload additionally accepts `addrs`: candidate multiaddresses supplied by the caller. Usable Mix addresses provide the destination information for a new session; an empty list uses the peer-ID-only resolution path. A nonempty list containing no usable Mix address returns an error.

Both overloads return a future containing either a `TransportSession` or an error string, and allow `CancelledError` to propagate. They coordinate concurrent connection attempts and reuse an existing session when available; `connectInternal` performs establishment when a new session is needed. Calling `connect` does not itself open an application stream.

The address-aware overload examines the supplied multiaddresses. It decodes usable Mix addresses with:

```nim
MixPubInfo.fromMixAddress(address, Opt.some(destination))
```

Here, `destination` is B's actual libp2p `PeerId`, supplied by the caller of `connect`. It identifies the peer A wants to reach. It is not a relay chosen along the path, and it is not the anonymous session ID that MixTransport generates later.

`fromMixAddress` is a decoding helper defined by **MixTransport** in `libp2p_mix_transport/address/parse.nim`. It constructs a `MixPubInfo`, whose type is defined by **Mix**. Its full signature is:

```nim
proc fromMixAddress*(
    T: type MixPubInfo, address: MultiAddress, destination: Opt[PeerId]
): Result[MixPubInfo, string]
```

- `T` is the type argument that permits the call syntax `MixPubInfo.fromMixAddress(...)`; it is not a pre-existing destination record.
- `address` is a multiaddress containing an endpoint and a `mix-transport` component carrying public-key information.
- `destination` is an optional expected peer identity. `Opt.some(destination)` asks the decoder to check that the address describes the peer requested by the caller.

The helper extracts the endpoint, decodes the libp2p public key from the Mix-address component, and derives its peer ID. If an expected destination was supplied, the derived peer ID must match it. It also decodes and validates the Mix public key. On success it returns a `MixPubInfo` containing that peer ID, endpoint, Mix public key, and libp2p public key; malformed input or an identity mismatch returns an error string.

This is local parsing and consistency checking. The helper does not contact B or establish that the endpoint is reachable.

Source: [fromMixAddress](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/address/parse.nim#L40).

When creating a new session, the connection code tries the decoded candidates through `connectInternal(destination, Opt.some(candidate))`. This private helper is defined in MixTransport's `libp2p_mix_transport/transport.nim`:

```nim
proc connectInternal(
    self: MixTransport,
    destination: PeerId,
    info: Opt[MixPubInfo] = Opt.none(MixPubInfo),
): Future[Result[TransportSession, string]] {.async: (raises: [CancelledError]).}
```

Here, `self` is the local transport, `destination` remains B's actual peer ID, and `info` optionally supplies B's decoded endpoint and public keys. When `info` is omitted, it defaults to `Opt.none(MixPubInfo)`, and forward sending relies on Mix's node pool to resolve B.

The returned future completes with an established `TransportSession` after the `Connect`/`ConnectAck` exchange, or an error string if establishment fails. Cancellation can propagate as `CancelledError`. This helper creates a session; stream creation is a separate operation.

Inside `connectInternal`, MixTransport generates a session ID, creates the initiator's session state, and records the selected candidate:

```nim
let sessionId = PeerId.random(self.mix.switch.rng).valueOr:
  return err("could not generate session identifier: " & $error)
let session = self.sessions.addInitiatorSession(destination, sessionId).valueOr:
  return err(error)

info.withValue(value):
  self.addressDestinations[sessionId] = value
```

Here, `info` is the optional `MixPubInfo` passed to `connectInternal`. Recording it before sending `Connect` makes it available both for that first frame and for later frames in the session.

A new session created through the peer-ID-only `connect(destination)` path has no explicit destination record. Its forward sends instead rely on Mix finding B's information in its node pool. Reusing an already-established session retains that session's existing destination arrangement.

#### Why the key is the session ID

The table keeps the selected destination information attached to the session that uses it. All streams in that session share the entry. A failed connection attempt removes its entry, and session teardown removes it through:

```nim
self.addressDestinations.del(session.sessionId)
```

The table therefore holds session-lifetime state, rather than acting as a general directory of discovered peers. Recipient-side sessions do not need such an entry for sending back to A: they use SURBs.

Sources: [address-aware connect](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L1163), [connectInternal](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L1107), [session cleanup](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L121).

### 5.2 Selecting the Mix send API

With that destination state in place, `sendToDestination` selects the appropriate Mix API. Its complete implementation is:

```nim
proc sendToDestination(
    self: MixTransport, destination: PeerId, sessionId: PeerId, payload: sink seq[byte]
): Future[Result[void, string]] {.async: (raw: true, raises: [CancelledError]).} =
  self.addressDestinations.withValue(sessionId, info):
    return self.mix.send(info[], MixTransportCodec, move(payload))
  self.mix.send(MixDestination.exitNode(destination), MixTransportCodec, move(payload))
```

The arguments have distinct roles:

| Argument | Meaning |
| --- | --- |
| `self` | The local MixTransport instance, holding the underlying `MixProtocol` and per-session destination information. |
| `destination` | B's actual libp2p peer identity. It is used when no explicit destination information is stored for the session. |
| `sessionId` | The transport session identifier, used here to look up explicit destination information in `addressDestinations`. It is not the destination's physical peer identity. |
| `payload` | One already-encoded transport frame, including its session ID and any operation-specific fields. The helper forwards these bytes without decoding or modifying the frame. |

`sink seq[byte]` allows the helper to take ownership of the byte sequence; `move(payload)` passes that ownership onward to Mix. The `sessionId` argument is used for the local lookup—it is not added to the payload here.

`Future[Result[void, string]]` represents an asynchronous send that either succeeds without returning a value or reports an error string. The `async: (raw: true, ...)` form lets the helper return the selected `MixProtocol.send` future directly. Cancellation can propagate as `CancelledError`. Successful completion means the local Mix sending path completed, not that B received or acknowledged the frame.

In the first branch, `withValue` exposes the stored destination record as `info`; `info[]` passes that `MixPubInfo` value to Mix. If the lookup finds no entry, execution reaches the peer-ID-based send below it. This is a choice based on available destination information, not a retry using the second route if the first send fails.

There are two destination-resolution paths:

- If the session has explicit destination information, Mix receives `MixPubInfo` directly.
- Otherwise Mix receives the peer ID through `MixDestination.exitNode` and resolves it from its node pool.

The explicit-information path does not require putting B in the relay pool or changing peer-store entries to make this send work. Mix still selects intermediate relays from its pool.

Inside Mix, `send` builds a Mix message consisting of the length-prefixed service identifier and the encoded transport frame. It does not prepend the legacy SURB envelope: any SURBs are already inside the frame chosen by MixTransport.

Mix then constructs a Sphinx packet for the selected route and calls `sendPacket`. That path applies the sampled sender delay, performs configured proof generation, and writes the packet to the first hop.

Sources: [sendToDestination](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L252), [Mix send](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L1081), [sendPacket](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L736).

## 6. Relays carry the packet; B delivers the frame to MixTransport

Intermediate Mix nodes process their Sphinx layer, apply their forwarding delay, and send to the next hop. They do not run MixTransport's stream logic.

At B, Mix recognizes final delivery, removes message padding, and decodes the Mix service identifier. Since B is the destination and a service handler is registered, it invokes:

```nim
await deliveryHandler(
  MixDelivery(
    service: deserialized.codec,
    payload: deserialized.message
  )
)
```

The registered callback enters B's `MixTransport.handleDelivery`. MixTransport decodes the frame, validates it, and dispatches by kind. For `Connect`, it establishes recipient-side session state, separates the dedicated response SURBs from numbered supply, and sends `ConnectAck`.

The service callback bypasses the legacy exit connection path. It does not create a `MixEntryConnection` or pass the frame to an application protocol handler directly.

Sources: [Mix service dispatch](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L383), [handleDelivery](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L796), [handleConnect](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L618).

## 7. Stream establishment and application bytes

Once the session is established, `dial` opens a stream using `OpenStream` and `StreamAck`. The application codec in `OpenStream` determines which application protocol receives the resulting `TransportStream`. The transport configures the stream's writing, inbound delivery, ACK, and retransmission paths.

An application write follows:

```text
TransportStream.write(application bytes)
  → installed StreamWriteHandler
  → MixTransport.writeStream
  → wait for outbound capacity
  → reserve a Data sequence and construct a Data frame
  → sendStreamFrame
```

`writeStream` splits a larger write into chunks no larger than `MaxDataPayloadBytes`. Each chunk gets its own transport sequence number. Forward `sendStreamFrame` calls the helper shown in Section 5.

On receipt, the other endpoint's transport validates the session and stream, records received data, and delivers available data in order to the stream's read buffer. Transport ACKs and retransmissions provide reliability above Mix's individual-message delivery.

The session role selects the sending path, not the stream opener. If B opens a new stream within this session, B still uses SURBs for B-to-A traffic; A still sends forward messages for A-to-B traffic.

Sources: [writeStream](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L321), [configureStream](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L442), [TransportStream.write](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/streams.nim#L408).

## 8. Reverse crossing: B sends using supplied SURBs

For ordinary reverse stream frames, B's `sendStreamFrame` waits until the session has sufficient SURBs, removes a redundancy batch, attaches the supply snapshot, and encodes the frame.

To send `ConnectAck`, B uses the two response SURBs supplied in `Connect`. Similarly, B uses the two response SURBs supplied in a forward `OpenStream` to send `StreamAck` or `StreamReject`. These dedicated SURBs are not taken from the session’s ordinary SURB queue.

### 8.1 The callback that sends one SURB-based message

MixTransport stores a function in its `surbSender` field. Calling that function sends one encoded transport frame using one supplied SURB. Both the field and its callback type, `SurbSender`, are defined in MixTransport's `libp2p_mix_transport/transport.nim`:

```nim
type SurbSender = proc(
  surb: sink SURB, payload: sink seq[byte]
): Future[Result[void, string]].Raising([CancelledError]) {.gcsafe, raises: [].}
```

`surb` is the single-use return path selected from the available SURBs. `payload` contains the already-encoded transport frame. The returned future reports local send success or an error string; cancellation can propagate when it is awaited. The `sink` parameters allow ownership of both arguments to pass into the sending operation.

### 8.2 Construction connects the callback to Mix Protocol

The `newMixTransport(mix)` constructor creates the callback using the injected `MixProtocol` instance:

```nim
let surbSender: SurbSender = proc(
    surb: sink SURB, payload: sink seq[byte]
): Future[Result[void, string]] {.async: (raw: true, raises: [CancelledError]).} =
  mix.sendWithSurb(move(surb), move(payload))
```

The constructor stores this closure in the new transport's `surbSender` field. The closure captures `mix`, so subsequent calls to `self.surbSender(...)` invoke `sendWithSurb` on that same Mix Protocol instance.

This callback is local to MixTransport. Unlike the receiving callbacks in Section 3, it is not registered with Mix for later incoming-message delivery: MixTransport calls it when it wants to send a reverse message.

### 8.3 Sending redundant copies

MixTransport's `sendWithSurbRedundancyBatch` calls the stored callback once for each SURB in the batch:

```nim
var sent = false
for surb in surbs.mitems:
  traceOutbound(surb, payload)
  if (await self.surbSender(move(surb), payload)).isOk:
    sent = true

if not sent:
  return err("could not send through any SURB in the redundancy batch")
ok()
```

For the current redundancy setting, the batch contains two distinct SURBs. Each invocation gets the same encoded frame but consumes a different SURB. The loop passes `payload` without `move` so it remains available for the next copy, and awaits the sends sequentially. The batch succeeds if at least one send returns success.

The resulting call path is:

```text
MixTransport.sendWithSurbRedundancyBatch
  → self.surbSender(one SURB, encoded frame)
      → MixProtocol.sendWithSurb(one SURB, encoded frame)
```

MixTransport chooses the redundancy and supplies the frame bytes. Mix Protocol's `sendWithSurb` handles just one SURB-based message per call.

Source: [SurbSender assignment in newMixTransport](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L879).

### 8.4 Mix constructs and sends the reply packet

Within Mix:

```nim
let message = buildMessage(move(payload), "").valueOr:
  return err("could not build SURB reply: " & error[0])

let sphinxPacket = useSURB(surb, message)
```

Mix obtains the first hop from the SURB and sends the constructed packet through the same `sendPacket` machinery, including the sender delay. The empty service identifier is deliberate: the return path is encoded in the SURB, and A will identify the recovery credential from the returning packet.

B does not need A's network address or A's reply credential. A SURB is consumed when the send is invoked, including on an error. A retransmission must use fresh available SURBs rather than reusing consumed ones.

Sources: [reverse sendStreamFrame](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L276), [redundancy batch](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L226), [sendWithSurb](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L1133).

## 9. A receives a raw reply and recovers the transport frame

When the return packet reaches A, Mix's Sphinx processing produces:

```nim
let rawReply = RawSurbReply(
  identifier: processedSP.id,
  encryptedPayload: processedSP.delta_prime
)
```

Mix first offers this to the registered raw-reply handler. A's transport:

1. Recognizes recently retired identifiers and absorbs their late packets.
2. Looks up the unexpired credential for the identifier.
3. Calls Mix's `recoverReply(credential, reply)`.
4. Obtains the original encoded transport-frame bytes.
5. Decodes the frame and checks that its `sessionId` matches the locally stored credential association.
6. Dispatches the reverse frame through `handleReplyFrame`.

Recovery performs the return-payload cryptography, padding removal, and Mix-message decoding. It requires an empty service identifier. MixTransport does not implement this cryptography itself.

The credential store consumes an entry after successful recovery. It also consumes it when cryptographic recovery succeeds but Mix-payload decoding fails; a Sphinx recovery failure does not itself consume the entry. Unknown identifiers produce no recovered transport reply, allowing the handler to return `Unhandled` and Mix to attempt its legacy connection store.

`handleReplyFrame` processes applicable supply information and then the operation—such as `ConnectAck`, `Data`, or `Ack`. Redundant copies have distinct SURB identifiers but the same logical transport frame; duplicate handling belongs to MixTransport.

Sources: [raw-reply dispatch in Mix](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L421), [MixTransport handler](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L828), [credential recovery and consumption](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/reply_credentials.nim).

## 10. Completion, backpressure, and failure

A successful `await mix.send(...)` or `await mix.sendWithSurb(...)` means the local sending path has completed its sender hold and first-hop write. It does not mean that the final recipient received the message, decoded the transport frame, or acknowledged its data.

There are therefore several distinct waits:

| Wait | What it waits for |
| --- | --- |
| Stream outbound capacity | Room permitted by the transport's send window |
| Recipient SURB availability | Return capacity supplied by the session initiator |
| Mix send future | Local sender delay, configured proof work, and first-hop transmission |
| Transport acknowledgement | Evidence returned by the remote transport for the relevant operation or data |

Sender-delay completion is not an end-to-end ACK. Likewise, a Mix send error is not permission to reuse a SURB. The transport maintains its own acknowledgement and retransmission state, and replenishes session return capacity through `SurbSupply` and supply snapshots.

The current sequential redundancy loop makes the two local sender waits sequential too. This is a property of this implementation revision, not a requirement that relay processing wait for the application's next write.

## 11. Lifetime and ownership

MixTransport owns its session store, stream tasks, received SURB queues, and reply credential store. Mix owns packet processing, relay connections, and the registered callback slots.

On normal transport shutdown, it stops connection attempts, makes best-effort session-reset sends, unregisters both receiving callbacks, shuts down session work, and clears its credential store. Unregistering prevents subsequent dispatch through those registrations; Mix takes a local callback copy when dispatching, so an invocation already in progress is not retroactively withdrawn.

A lost SURB need not receive a response before its credential can be released: the transport's credential expiry and session cleanup bound the retained state.

Sources: [MixTransport.stop](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/transport.nim#L1397), [reply credential store](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/reply_credentials.nim).

## 12. Presentation guide

The twelve-slide walkthrough follows one session **S** between initiator **A** and recipient **B**. Its order is construction, destination resolution, return-path preparation, forward delivery, reverse delivery, recovery, and completion.

| Slide | Presenter notes |
| --- | --- |
| The boundary | The line between applications is a logical stream. The relay path underneath carries independent messages. A and B denote session roles; either endpoint can open streams. |
| Connections and messages | Follow the legacy request from A's `MixEntryConnection` to B's `MixExitConnection`, then the buffered response through B's `MixReplyConnection` back to A's incoming queue. The diagram shows exit = destination; forwarding beyond the exit uses a regular libp2p connection instead. MixTransport uses message callbacks and owns its longer-lived sessions and streams. |
| API map | Rightward arrows are calls made by MixTransport into Mix. Leftward arrows are incoming callbacks. `MixDelivery` and `RawSurbReply` are Mix-defined types. Operations such as `createSurb` and `recoverReply` return results to their caller; they are not messages sent to another endpoint. |
| Construction | Follow two different inputs: local node information constructs Mix, while relay records populate `nodePool` afterward. Storage starts and mounts Mix, injects that instance into MixTransport, and starts the transport to register its receiving callbacks. |
| Destination state | The connection setup, `addressDestinations` table, and `sendToDestination` helper all belong to MixTransport at A. The helper calls across the Mix Protocol API boundary through `mix.send`. `addressDestinations[S]` holds B's physical destination information for sends in S. The generated session ID is not B's peer ID. Without an explicit record, the peer-ID-only send resolves B through the pool. This is a choice of lookup path, not a fallback retry after a failed send. |
| Paired objects | Each row comes from one `createSurb` call. `encoded[i]` and `credentials[i]` correspond during preparation. At arrival, the reply identifier—not the array index—selects the credential. The example shows three rows of a batch; Connect uses five. |
| Connect | Distinguish the five array positions from the numbered supply sequences. Entries 0 and 1 are dedicated to two copies of `ConnectAck`. Entries 2, 3 and 4 become supply sequences 0, 1 and 2 in B's ordinary queue. A retains all five credentials. |
| Forward crossing | Follow `Connect(S)` from A's transport, through Mix and the relay path, to B's registered service callback. The three codec labels select different things: hop transport, Mix service, and application stream handler. `OpenStream.codec` is not part of Connect; it is shown here to distinguish its later role. |
| Reverse crossing | B uses the dedicated response SURBs for `ConnectAck`. The two copies carry the same encoded frame, but use distinct SURBs and therefore distinct reply identifiers. The lower diagram shows copy relationships, not concurrent execution; the current implementation awaits the two local sends sequentially. |
| Reply ownership | Read the three branches as mutually exclusive outcomes of the identifier lookup. Active credentials permit recovery; remembered retired identifiers permit immediate discard; unknown identifiers allow legacy fallback. A known but invalid reply is still `Handled`. |
| Completion | The timeline is illustrative, not a measured latency chart. Completion of the local Mix future does not establish remote receipt. Outbound capacity, ordinary reverse SURB availability, local sending, and remote ACK processing are different waits. |
| Identity recap | Follow a later reverse Data copy: its reply identifier selects a credential associated with S; the recovered frame supplies S and stream 1; Data sequence 7 identifies the stream chunk. At B, `sendWithSurb` sends the encoded frame using a SURB. At A, Mix invokes the registered callback with a `RawSurbReply`: the reply identifier and still-encrypted payload. MixTransport selects the credential and calls `recoverReply` before decoding the frame. Handshake responses, stream opening and ACKs are omitted; only one of the two redundant Data copies is drawn. The other copy uses a different SURB and reply identifier but carries the same session ID, stream ID and Data sequence. |

### Legacy connection objects

The diagram shows the reply-expecting legacy interface, with B both the exit and the destination. The connection objects are local wrappers, not a single end-to-end libp2p connection:

- At A, `MixEntryConnection.write` invokes Mix's legacy send path. Mix creates the response SURBs and registers their reply credentials together with this connection's `incoming: AsyncQueue[seq[byte]]`.
- At B, `ExitLayer.runHandler` constructs `MixExitConnection(message)`. The application handler reads the request from its message buffer using `readOnce`; its writes accumulate in a separate response buffer. After the handler returns, `ExitLayer` takes that response with `getResponse()`.
- Still at B, `ExitLayer.reply` creates `MixReplyConnection` with the supplied SURBs and writes the response through it. This is a sending wrapper, not a reply read queue. The response travels back through Mix.
- At A, Mix recovers the first valid response using its connection-associated credential store, releases the redundant credential group, and puts the response bytes into that entry connection's incoming queue. The queue consumer moves them into `cached` and completes `replyReceivedFut`; `readOnce` reads from that cache. A reply-expecting entry connection accepts one request write.

When the destination is beyond the exit, the exit dials a regular libp2p connection, writes the request, and collects its response using the codec's registered destination-read callback. It does not create a `MixExitConnection` for that branch. The SURB-based response and A's incoming queue work as above.

MixTransport instead receives complete messages through its registered callbacks. It owns the reply credentials and maps incoming transport frames to sessions and streams; those frames do not pass through a legacy `MixEntryConnection` queue.

### Example labels and omitted operations

`S`, `q0`, `q1`, and `q2` are symbolic labels. `S` represents a transport session ID. The `q` labels represent the distinct SURB reply identifiers associated with the matching credentials; they are not numbered supply sequences.

The Connect response in “Reverse delivery: use the supplied return path” spends the dedicated SURBs labelled `q0` and `q1`. The identity recap instead uses `q2`, representing an ordinary-supply SURB that has not yet been spent. The final slide is an identity map, not an exhaustive packet trace: it assumes stream establishment and any required supply replenishment have already happened. Only one copy of the later Data frame is drawn.

A recipient-originated stream does not reverse the session roles. B still sends its frames using SURBs; A still sends forward messages addressed to B.

### Recovery details behind the reply-ownership diagram

After successful recovery, MixTransport retires the credential and temporarily remembers its identifier, bounded by the original expiry and retention capacity. It also consumes a credential when cryptographic recovery succeeds but Mix-message decoding fails; a Sphinx recovery failure alone does not consume it. The diagram groups these paths under the active-credential branch. The detailed handling is described in Sections 3.4 and 9.

The two stores do not contain duplicate credentials. MixTransport's store associates credentials with sessions; Mix's legacy store associates them with a `MixEntryConnection` incoming queue.

The code references use Mix `0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0` and MixTransport `653bcd6d8c2a74b72b7207723938c643416670a0`, both from the local `feat/mix-transport` branches.
