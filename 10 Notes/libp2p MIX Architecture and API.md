The copy of this document can be found in [https://github.com/logos-storage/libp2p-storage-mix-transport/blob/master/docs/mix.md](https://github.com/logos-storage/libp2p-storage-mix-transport/blob/master/docs/mix.md). The content available in the Obsidian vault should be considered the most recent version.

> This document belong to the series of [[Mix Implementation]] notes.

This document describes the MIX implementation. It focuses on how the code is
structured, what API surface is intended for callers, and what constraints matter
when using MIX as a transport-like wrapper for other libp2p protocols.

## Overview

MIX adds an anonymous message routing layer on top of libp2p streams. A sender
wraps an application protocol message in a fixed-size Sphinx packet, sends it to
a randomly selected mix path, and lets each hop peel one routing layer before
forwarding the packet. The final mix hop acts as an exit node and forwards the
inner message to the real destination protocol. Replies are optional and are
returned through Single Use Reply Blocks (SURBs), so the destination can respond
without learning the sender.

The libp2p protocol ID is:

```nim
const MixProtocolID* = "/mix/1.0.0"
```

At a high level:

```text
sender protocol
    |
    | writes to MixEntryConnection
    v
entry MixProtocol
    |
    | Sphinx packet over /mix/1.0.0
    v
mix hop 1 -> mix hop 2 -> ... -> exit mix hop
                                      |
                                      | original codec
                                      v
                                destination protocol
                                      |
                                      | optional response via SURBs
                                      v
sender MixEntryConnection
```

## Main Modules

The public import is `libp2p/protocols/mix`. It re-exports the main types and
helpers from the implementation modules:

- `mix_protocol.nim`: main `MixProtocol` implementation, path selection,
  Sphinx packet handling, SURB creation, forwarding, and reply processing.
- `mix_node.nim`: private/public mix node identity records.
- `pool.nim`: `MixNodePool`, backed by the libp2p `PeerStore`.
- `entry_connection.nim`: `MixEntryConnection`, a `Connection` facade used by
  local protocols to write through MIX and optionally read replies.
- `exit_layer.nim`: destination forwarding and reply dispatch from the exit
  node.
- `reply_connection.nim`: `MixReplyConnection`, a write-only connection facade
  used by the exit layer to send replies over SURBs.
- `serialization.nim`, `sphinx.nim`, `fragmentation.nim`, `mix_message.nim`:
  fixed packet formats, Sphinx processing, padding, and application message
  encoding.
- `multiaddr.nim`: compact encoding for next-hop and destination addresses.
- `delay_strategy.nim`: pluggable per-hop delay strategy.
- `spam_protection.nim`: optional per-hop proof interface.
- `tag_manager.nim`: replay detection state for Sphinx tags.

## Core Types

### `MixProtocol`

`MixProtocol` is an `LPProtocol` mounted on a libp2p `Switch`. Each running mix
node owns one instance.

Important fields and collaborators:

- `mixNodeInfo`: this node's libp2p identity and Curve25519 MIX keypair.
- `switch`: the underlying libp2p switch used for dialing peers and destinations.
- `nodePool`: public information for candidate mix nodes.
- `tagManager`: replay detection for processed Sphinx packets.
- `exitLayer`: forwards exit messages to destination protocols and sends replies.
- `connCreds`: temporary SURB credentials for expected replies.
- `destReadBehavior`: per-codec callbacks that tell the exit node how to read a
  destination response.
- `spamProtection`: optional proof generator/verifier.
- `delayStrategy`: pluggable encoded/actual delay policy.

Create and mount it with:

```nim
let proto = MixProtocol.new(nodeInfo, switch)
await proto.start()
proto.nodePool.add(otherMixNodes)
switch.mount(proto)
```

`MixProtocol.new` defaults to `NoSamplingDelayStrategy` and no spam protection.

### `MixNodeInfo` and `MixPubInfo`

`MixNodeInfo` contains private node data and is used by the local mix node:

```nim
type MixNodeInfo* = object
  peerId*: PeerId
  multiAddr*: MultiAddress
  mixPubKey*: FieldElement
  mixPrivKey*: FieldElement
  libp2pPubKey*: SkPublicKey
  libp2pPrivKey*: SkPrivateKey
```

`MixPubInfo` is the shareable subset stored in `MixNodePool`:

```nim
type MixPubInfo* = object
  peerId*: PeerId
  multiAddr*: MultiAddress
  mixPubKey*: FieldElement
  libp2pPubKey*: SkPublicKey
```

Convenience helpers:

- `MixNodeInfo.generateRandom(port)`
- `MixNodeInfo.generateRandomMany(count, basePort = 4242)`
- `initMixNodeInfo(...)`
- `toMixPubInfo(info)`
- `includeAllExcept(allNodes, exceptNode)`

In local examples, switches are started first so wildcard listen addresses are
resolved, then `initMixNodeInfo` rebuilds each node record with a dialable
address from `switch.peerInfo.addrs`.

### `MixNodePool`

`MixNodePool` manages public mix node information through the switch peer store.
It writes to the peer store's mix public key book, address book, and key book.

Public operations:

```nim
let pool = MixNodePool.new(switch.peerStore)
pool.add(info)
pool.add(infos)
discard pool.remove(peerId)
let infoOpt = pool.get(peerId)
let ids = pool.peerIds()
let n = pool.len
```

Supported addresses are IPv4 TCP and IPv4 QUIC-v1, including supported
circuit-relay addresses over those base transports. IPv6, DNS, WebSocket, and
related address forms are not supported by the compact address encoder in this
implementation.

The implementation requires Secp256k1 libp2p peer IDs when serializing hop
addresses.

### `MixDestination`

`MixDestination` identifies the final target of a mixed message.

Normal usage forwards from the exit node to a destination address:

```nim
let destination = MixDestination.init(destPeerId, destAddr)
```

This is equivalent to `MixDestination.forwardToAddr(destPeerId, destAddr)`.

There is also compile-time experimental support for `exit == destination` behind
`-d:libp2p_mix_experimental_exit_is_dest`. Without that define, the destination
must be a separate forwarded address.

### `MixParameters`

`MixParameters` controls entry connection behavior:

```nim
type MixParameters* = object
  expectReply*: Opt[bool]
  numSurbs*: Opt[uint8]
```

If `expectReply` is true, `toConnection` creates an incoming queue and the
sender embeds SURBs in the outgoing payload. If `numSurbs` is omitted while a
reply is expected, `MixEntryConnection` uses a default of 4 SURBs. If no reply is
expected, the number of SURBs is forced to 0.

### `DestReadBehavior`

When a request expects a reply, the exit node needs to know how to read a
response from the destination protocol connection. Register that per application
codec on every mix node that may be selected as an exit:

```nim
proto.registerDestReadBehavior(PingCodec, readExactly(32))
```

The public helpers are:

```nim
readExactly(nBytes: int): DestReadBehavior
readLp(maxSize: int): DestReadBehavior
```

Use `readExactly` for fixed-size response protocols. Use `readLp` when the
destination protocol returns length-prefixed messages using libp2p's varint LP
framing. For `readLp`, the exit layer restores the length prefix before sending
the reply through MIX, allowing the original caller to call `readLp()` on the
returned `MixEntryConnection`.

## Sending Through MIX

### What "writes to `MixEntryConnection`" means

In libp2p Nim, application protocols usually talk to a generic
`Connection`. For example, the Ping client does not know whether the connection
is a direct TCP stream, QUIC stream, relay stream, or MIX-backed connection:

```nim
proc ping*(p: Ping, conn: Connection): Future[Duration] =
  await conn.write(randomBytes)
  await conn.readExactly(addr resultBuf[0], 32)
```

`MixEntryConnection` is a custom `Connection` implementation. It has the same
`write` and `readOnce`/`readExactly` behavior that application protocols expect,
but its `write` method does not write directly to the destination. Instead, it
calls into `MixProtocol.anonymizeLocalProtocolSend`, which wraps that write in a
Sphinx packet and sends it through the mixnet.

So "writes to `MixEntryConnection`" normally happens indirectly:

1. Application code calls an existing protocol helper, such as
   `pingProto.ping(conn)`.
2. That helper calls `conn.write(...)`.
3. Because `conn` is actually a `MixEntryConnection`, the write becomes a MIX
   send.
4. If the helper later calls `conn.readExactly(...)`, `MixEntryConnection` waits
   for a SURB reply and serves the reply bytes from its local incoming queue.

This is why `mix_ping_tcp.nim` can reuse the normal Ping client logic:

```nim
let pingProto = Ping.new()
destNode.mount(pingProto)

let conn = mixProtos[senderIndex]
  .toConnection(
    MixDestination.init(destNode.peerInfo.peerId, destNode.peerInfo.addrs[0]),
    PingCodec,
    MixParameters(expectReply: Opt.some(true), numSurbs: Opt.some(byte(1))),
  )
  .expect("could not build connection")

let response = await pingProto.ping(conn)
```

There are two different uses of the same `Ping` instance here:

- Mounted on `destNode`, `Ping` acts as the destination server handler. It reads
  32 bytes and writes the same 32 bytes back.
- Called as `pingProto.ping(conn)`, `Ping` acts as client-side helper code. It
  only needs a `Connection`, so it can use the MIX-backed connection returned by
  `toConnection`.

### Preferred API: `toConnection`

The ergonomic API is `toConnection`, which returns a libp2p `Connection`
implementation. Use this when you want an existing libp2p protocol helper to run
over MIX:

```nim
let conn = mixProto
  .toConnection(
    MixDestination.init(destNode.peerInfo.peerId, destNode.peerInfo.addrs[0]),
    PingCodec,
    MixParameters(expectReply: Opt.some(true), numSurbs: Opt.some(byte(1))),
  )
  .expect("could not build connection")

let response = await pingProto.ping(conn)
await conn.close()
```

`MixEntryConnection.write` sends each write as one independent MIX message by
calling `MixProtocol.anonymizeLocalProtocolSend`. `readOnce` waits for one reply
if the connection was created with `expectReply = true`.

If `expectReply = true` and no destination read behavior has been registered on
the sender's local `MixProtocol`, `toConnection` returns an error. The actual
response read happens on the selected exit node, so practical deployments should
register the same behavior on all candidate exit nodes. If no reply is expected,
missing read behavior only logs a warning.

### Lower-level API: `anonymizeLocalProtocolSend`

`MixProtocol.anonymizeLocalProtocolSend` is also exported from
`mix_protocol.nim` itself. It sends one byte message through MIX without first
constructing a `Connection` facade:

```nim
let incoming = newAsyncQueue[seq[byte]]()
let sendRes = await mixProto.anonymizeLocalProtocolSend(
  incoming,
  msg,
  codec,
  destination,
  numSurbs,
)
```

This is useful if you are building a custom adapter and want direct control over
the incoming reply queue. It is less convenient for normal libp2p protocols
because those protocols usually expect to read and write through a `Connection`.

In this implementation, the practical outbound interaction models are:

- Use `toConnection` and pass the returned connection to an existing protocol
  client helper. This is the normal path.
- Use `toConnection` directly and call `conn.write`, `conn.readExactly`,
  `conn.readLp`, etc. yourself.
- Call `anonymizeLocalProtocolSend` from `mix_protocol.nim` for a lower-level
  one-message send.

Inbound mixnet traffic is not handled by application code directly. Mix nodes
receive `/mix/1.0.0` streams through the mounted `MixProtocol`; the exit layer
then dials the destination using the original application codec.

## Internal Message Flow

### Entry

`anonymizeLocalProtocolSend` performs the sender-side work:

1. Check that the node pool has at least `PathLength` available public mix nodes.
2. Randomly select a path from `nodePool`, excluding the final destination if it
   is also present in the pool.
3. Use the last selected mix node as the exit node.
4. Encode each hop as compact bytes containing IPv4 address, transport, port,
   optional relay peer ID, and peer ID.
5. Generate per-hop delay values using `delayStrategy.generateForEntry`.
6. Optionally create SURBs for replies and prepend them to the application
   message.
7. Encode the application message as `MixMessage(message, codec)`.
8. Pad it into one fixed-size `MessageChunk`.
9. Wrap it into a Sphinx packet using the selected public keys, delays, hops,
   and final destination.
10. Optionally append a spam protection proof.
11. Send the packet to the first hop over `/mix/1.0.0`.

### Intermediate Hop

Each mix node handles inbound `/mix/1.0.0` streams in
`handleMixNodeConnection`. For every length-prefixed packet read from the stream,
it spawns `handleMixMessages`.

For intermediate packets:

1. Extract the optional spam proof.
2. Deserialize the Sphinx packet.
3. Check replay tags with the node's MIX private key and `TagManager`.
4. Verify spam protection after the replay check.
5. Process the Sphinx packet to reveal the next hop and transformed packet.
6. Compute the actual delay using `delayStrategy.generateForIntermediate`.
7. Generate a fresh per-hop spam proof for the outgoing packet if enabled.
8. Sleep for the computed delay.
9. Forward to the next hop over `/mix/1.0.0`.

Connections to next hops are cached by peer ID in `connPool`. If a cached stream
is closed or reset, the implementation dials a fresh stream and retries the
write.

### Exit

When Sphinx processing returns `Exit`, the node:

1. Deserializes and unpads the `MessageChunk`.
2. Deserializes the `MixMessage` to recover `codec` and `message`.
3. Extracts any embedded SURBs.
4. Passes the request to `ExitLayer.onMessage`.

For normal forwarded destinations, `ExitLayer` dials the destination peer using
the recovered codec, writes the raw inner message, and optionally reads a
response using the registered `DestReadBehavior`.

If SURBs were provided, the exit layer sends the response back through every SURB
using a `MixReplyConnection`.

### Reply

Replies do not contain an application codec; they are associated with a SURB
identifier generated by the original sender.

The original sender stores each generated SURB identifier in `connCreds` with
the SURB key, secret, identifier group, and incoming queue. When a `Reply` packet
arrives:

1. The sender looks up the SURB identifier.
2. It processes the reply using the stored SURB key and secret.
3. It deletes all credentials in the same identifier group.
4. It deserializes, unpads, and decodes the reply message.
5. It places the reply bytes on the entry connection's incoming queue.

Because the credentials are single-use, one response consumes the associated SURB
group.

## Packet and Payload Limits

Important constants from `serialization.nim` and `fragmentation.nim`:

```nim
PacketSize = 4608
MessageSize = PacketSize - HeaderSize - k
DataSize = MessageSize - PaddingLengthSize - SeqNoSize
PathLength = 3
```

Current code builds a single padded `MessageChunk` for each `write`; it does not
automatically split large application messages in `anonymizeLocalProtocolSend`.
`MixEntryConnection.write` rejects messages larger than `DataSize`, and
`buildMessage` rejects serialized `MixMessage` values larger than `DataSize`.

Because MIX adds codec and SURB overhead inside the fixed payload, callers should
use:

```nim
let maxPayload = getMaxMessageSizeForCodec(codec, numberOfSurbs)
```

This returns the maximum application message size available for the given codec
and number of embedded SURBs.

## Delay Strategies

Delay behavior is pluggable through `DelayStrategy`.

Built-in strategies:

- `NoSamplingDelayStrategy`: default. The entry node encodes a random delay in
  the range 0-2 ms, and intermediate nodes use that value directly.
- `ExponentialDelayStrategy`: the entry node encodes a mean delay, and
  intermediate nodes sample from an exponential distribution with that mean.
  The default mean is `DefaultMeanDelayMs = 100`.

Example:

```nim
let rng = newRng()
let delay = ExponentialDelayStrategy.new(meanDelayMs = 100, rng = rng)
let proto = MixProtocol.new(nodeInfo, switch, rng = rng, delayStrategy = Opt.some(delay))
```

When spam protection is enabled, proof generation runs in parallel with the
intermediate delay. If proof generation takes longer than the configured delay,
the effective delay becomes the proof generation time.

## Spam Protection

Spam protection is optional and is represented by an abstract `SpamProtection`
object:

```nim
type SpamProtection* = ref object of RootObj
  proofSize*: int

method generateProof(self: SpamProtection, bindingData: seq[byte]): Result[seq[byte], string]
method verifyProof(self: SpamProtection, encodedProofData: seq[byte], bindingData: seq[byte]): Result[bool, string]
```

If provided to `MixProtocol.new`, the wire packet becomes:

```text
[Sphinx packet: 4608 bytes][proof: proofSize bytes]
```

Each hop extracts and verifies the incoming proof, processes the Sphinx packet,
then generates a fresh proof for the next hop. If no spam protection instance is
provided, packets are just the fixed-size Sphinx packet.

## Address Constraints

Hop and destination addresses are encoded into a fixed `AddrSize` field. The
implementation currently supports:

- `/ip4/.../tcp/...`
- `/ip4/.../udp/.../quic-v1`
- circuit-relay variants over those base transports

Current limitations:

- No IPv6 support.
- No DNS or DNS4 support.
- No WebSocket, WebSocket Secure, or SNI support.
- Peer IDs must serialize to the expected Secp256k1 multihash length.

Invalid or unsupported mix node addresses are removed from consideration during
path construction.

## Minimal Setup Pattern

The local TCP and QUIC examples follow this shape:

```nim
let mixNodeInfos = MixNodeInfo.generateRandomMany(NumMixNodes)

for nodeInfo in mixNodeInfos:
  let switch = createSwitch(nodeInfo.multiAddr, Opt.some(nodeInfo.libp2pPrivKey))
  await switch.start()
  switches.add(switch)

let resolvedInfos = collect:
  for i, nodeInfo in mixNodeInfos:
    initMixNodeInfo(
      nodeInfo.peerId,
      switches[i].peerInfo.addrs[0],
      nodeInfo.mixPubKey,
      nodeInfo.mixPrivKey,
      nodeInfo.libp2pPubKey,
      nodeInfo.libp2pPrivKey,
    )

for i, nodeInfo in resolvedInfos:
  let proto = MixProtocol.new(nodeInfo, switches[i])
  await proto.start()
  proto.nodePool.add(resolvedInfos.includeAllExcept(nodeInfo))
  proto.registerDestReadBehavior(PingCodec, readExactly(32))
  switches[i].mount(proto)
```

For QUIC, build switches with `TransportType.QUIC` and use
`/ip4/0.0.0.0/udp/0/quic-v1` listen addresses.

## Operational Notes

- Every mix participant must mount `MixProtocol` on its switch.
- The sender's node pool must contain enough usable mix nodes for `PathLength`.
- Destination protocols do not need to know about MIX when using normal
  exit-forwarding mode; the exit node dials them by their original codec.
- Replies require a registered `DestReadBehavior` for the application codec.
  Register it on all candidate exit nodes; the sender also checks for a local
  registration before creating a reply-capable connection.
- MIX messages are independent and stateless at the routing layer, apart from
  replay protection tags, cached outbound streams, and temporary SURB credentials.
- `MixProtocol.stop` marks the protocol stopped and stops the tag manager, but
  it does not perform broad connection-pool or credential cleanup.
- Benchmark-only metadata framing is compiled in with `-d:enable_mix_benchmarks`.
