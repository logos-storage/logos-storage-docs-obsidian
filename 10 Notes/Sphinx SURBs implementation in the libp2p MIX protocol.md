The copy of this document can be found in [https://github.com/logos-storage/libp2p-storage-mix-transport/blob/master/docs/surb.md](https://github.com/logos-storage/libp2p-storage-mix-transport/blob/master/docs/surb.md). The content available in the Obsidian vault should be considered the most recent version.

> This document belong to the series of [[Mix Implementation]] notes.

This document is a deeper treatment of Single-Use Reply Blocks (SURBs) in the
vendored libp2p MIX implementation at
`nimbledeps/pkgs2/libp2p-*/libp2p/protocols/mix`.

It maps the implementation to the MIX spec, with special attention to the newer
SURB section in [pull request 307](https://github.com/logos-co/logos-lips/pull/307):

- Published MIX LIP: https://lip.logos.co/anoncomms/raw/mix.html
- SURB section in the SPEC: https://lip.logos.co/anoncomms/raw/mix.html#87-single-use-reply-blocks

The published LIP still contains older wording saying reply support is not
implemented yet. The pull request snapshot adds Section 8.7, which describes
SURB creation, use, reply processing, and reply recovery. This document compares
that newer SURB section with the current Nim implementation.

## High-Level Model

A SURB lets the destination side send a reply without learning the sender's
identity or return path. The sender precomputes a return-path Sphinx header,
embeds it in the forward message, and keeps the corresponding decryption
material locally. The exit node later uses the embedded SURB to package the
destination response as a MIX reply.

The current implementation uses SURBs for request/response flows such as Ping:

```text
sender
  builds forward Sphinx packet
  embeds N SURBs in the encrypted forward payload
  stores SURB id -> reply credentials + incoming queue
    |
    v
mix path to exit
    |
    v
exit node
  extracts SURBs
  forwards request to destination protocol
  reads destination response
  sends the same response through each supplied SURB
    |
    v
return mix path(s)
    |
    v
sender
  accepts first valid SURB reply
  deletes credentials for all SURBs from that request
  writes one recovered response into MixEntryConnection's incoming queue
```

The important operational point is that `numSurbs > 1` does not mean the
application receives multiple responses. In this implementation it means the
same response is sent over multiple independent return paths, and the first valid
reply wins.

## Relevant Types and Constants

The wire structures live mostly in `serialization.nim`.

```nim
const
  k* = 16
  r* = 5
  t* = 6
  AlphaSize* = 32
  BetaSize* = ((r * (t + 1)) + 1) * k
  GammaSize* = 16
  HeaderSize* = AlphaSize + BetaSize + GammaSize
  DelaySize* = 2
  AddrSize* = (t * k) - DelaySize
  PacketSize* = 4608
  MessageSize* = PacketSize - HeaderSize - k
  PayloadSize* = MessageSize + k
  SurbSize* = HeaderSize + AddrSize + k
  SurbLenSize* = 1
  SurbIdLen* = k
```

With the current parameters:

- `HeaderSize = 624`
- `DelaySize = 2`
- `AddrSize = 94`
- `SurbSize = 734`
- `MessageSize = 3968`
- `PayloadSize = 3984`

`t * k` is the combined per-hop routing block space for address plus delay:
`6 * 16 = 96` bytes. The implementation reserves `DelaySize = 2` bytes for the
encoded per-hop delay, leaving `AddrSize = 94` bytes for the serialized hop
address.

That matches the pull request 307 Section 8.7.1 structure:

```text
SURB = hop_0 || header || reply_key
     = 94    || 624    || 16
     = 734 bytes
```

The implementation type is:

```nim
type Hop* = object
  MultiAddress: seq[byte]

type
  Secret* = seq[seq[byte]]
  Key* = seq[byte]
  SURBIdentifier* = array[SurbIdLen, byte]

  SURB* = object
    hop*: Hop
    header*: Header
    key*: Key
    secret*: Opt[Secret]
```

`Hop` is the fixed-size routing address container used both for normal next-hop
routing and for `hop_0` in a SURB. Its serialized form is always `AddrSize`
bytes:

```nim
proc serialize*(hop: Hop): seq[byte] =
  if hop.MultiAddress.len == 0:
    return newSeq[byte](AddrSize)

  doAssert len(hop.MultiAddress) == AddrSize
  return hop.MultiAddress
```

An empty `Hop()` serializes as 94 zero bytes. The implementation uses that in
SURB construction for the final return-path routing block: zero address plus
zero delay means "this is not a normal forward destination"; the nonzero SURB
identifier placed after that block marks it as a reply.

Field mapping:

- `hop`: the spec term `hop_0`, the first hop on the return path.
- `header`: the spec tuple `(alpha_0, beta_0, gamma_0)`, the precomputed
  Sphinx header.
- `key`: the spec term `k_tilde`, the reply key.
- `secret`: local-only per-hop shared secrets `s_0 ... s_{L-1}`. This should
  not be distributed with the SURB.

The serialized SURB embedded into the forward message deliberately omits
`secret`:

```nim
let surbBytes =
  surbs.mapIt(it.hop.serialize() & it.header.serialize() & it.key).concat()
```

## Where the Reply Queue Fits

The reply queue is not part of the Sphinx/SURB spec. It is an implementation
adapter that lets a `MixEntryConnection` look like a normal libp2p `Connection`
to client-side protocol code.

`MixEntryConnection` has:

```nim
type MixEntryConnection* = ref object of Connection
  incoming: AsyncQueue[seq[byte]]
  incomingFut: Future[void]
  replyReceivedFut: Future[void]
  cached: seq[byte]
```

When `expectReply = true`, construction creates the queue and starts one
background future:

```nim
instance.incoming = newAsyncQueue[seq[byte]]()
instance.replyReceivedFut = newFuture[void]()

let checkForIncoming = proc(): Future[void] {.async.} =
  instance.cached = await instance.incoming.get()
  instance.replyReceivedFut.complete()

instance.incomingFut = checkForIncoming()
```

When client code later reads from the connection, `readOnce` waits for
`replyReceivedFut` and then serves bytes from `cached`:

```nim
if s.cached.len == 0:
  await s.replyReceivedFut

let toRead = min(nbytes, s.cached.len)
copyMem(pbytes, addr s.cached[0], toRead)
s.cached = s.cached[toRead ..^ 1]
```

The queue is populated by the sender-side `Reply` branch in
`handleMixMessages`, after the returned SURB packet has been recovered:

```nim
await connCred.incoming.put(deserialized.message)
```

So the reply queue is the bridge between:

- MIX/SURB packet processing, which eventually recovers `seq[byte]`; and
- libp2p protocol code, which expects to read those bytes from a `Connection`.

Current limitation: this is shaped for a single request/response. One
`replyReceivedFut` is completed once, and the first successful reply fills
`cached`. It is not a general multi-response stream abstraction.

## Sender-Side SURB Creation

SURB creation begins during a normal MIX send. `MixEntryConnection.write` calls:

```nim
let sendRes = await srcMix.anonymizeLocalProtocolSend(
  instance.incoming, msg, codec, dest, numSurbs
)
```

Inside `anonymizeLocalProtocolSend`, after the forward path has selected an exit
node, the message is augmented with SURBs:

```nim
let msgWithSurbs = mixProto.prepareMsgWithSurbs(
  incoming, msg, numSurbs, destination.peerId, exitPeerId
)
```

`prepareMsgWithSurbs` calls `buildSurbs`, then serializes them before the
application message:

```nim
proc prepareMsgWithSurbs(
  mixProto: MixProtocol,
  incoming: AsyncQueue[seq[byte]],
  msg: seq[byte],
  numSurbs: uint8 = 0,
  destPeerId: PeerId,
  exitPeerId: PeerId,
): Result[seq[byte], string] =
  let surbs =
    mixProto.buildSurbs(incoming, numSurbs, destPeerId, exitPeerId).valueOr:
      return err(error)

  serializeMessageWithSURBs(msg, surbs)
```

### `buildSurbs`: Outer Loop and Local State

`buildSurbs` is the outer loop. It creates `numSurbs` independent SURBs for this
one outgoing request. It is also where `buildSurb` is called:

```nim
proc buildSurbs(
  mixProto: MixProtocol,
  incoming: AsyncQueue[seq[byte]],
  numSurbs: uint8,
  destPeerId: PeerId,
  exitPeerId: PeerId,
): Result[seq[SURB], string] =
  var response: seq[SURB]
  var igroup = SURBIdentifierGroup(members: initHashSet[SURBIdentifier]())

  for _ in 0.uint8 ..< numSurbs:
    var id: SURBIdentifier
    hmacDrbgGenerate(mixProto.rng[], id)

    let surb = ?mixProto.buildSurb(id, destPeerId, exitPeerId)

    igroup.members.incl(id)
    mixProto.connCreds[id] = ConnCreds(
      igroup: igroup,
      surbSecret: surb.secret.get(),
      surbKey: surb.key,
      incoming: incoming,
    )

    response.add(surb)

  return ok(response)
```

In that loop:

- `id` is the random SURB identifier later embedded in the return-path header.
- `buildSurb(id, destPeerId, exitPeerId)` builds one complete return-path SURB.
- `connCreds[id]` stores the local-only recovery material for that SURB.
- `igroup` groups all SURB identifiers created for this request, so the first
  valid reply can consume the whole group.
- `response` is the list of distributable SURBs that will be serialized into the
  forward request payload.

The serialized layout is:

```text
num_surbs: 1 byte
SURB[0]: hop || header || key
SURB[1]: hop || header || key
...
application_message
```

This means even messages with no replies still carry a one-byte SURB count:

```text
0x00 || application_message
```

### Identifier and Reply Key

For each SURB, `buildSurbs` samples a distinct identifier before calling
`buildSurb`:

```nim
var id: SURBIdentifier
hmacDrbgGenerate(mixProto.rng[], id)
let surb = ?mixProto.buildSurb(id, destPeerId, exitPeerId)
```

That `id` is embedded into the terminal routing block of the SURB return path.
When a reply returns, the original sender extracts this identifier and uses it
to look up the stored recovery credentials in `connCreds`.

`createSURB`, which is called from inside `buildSurb`, samples the reply key:

```nim
var key = newSeqUninit[byte](k)
rng[].generate(key)
```

This maps to pull request 307 Section 8.7.2 Step 2: sample a unique SURB
identifier `id` and a reply key `k_tilde`.

There is no explicit collision check against existing `connCreds`; uniqueness is
probabilistic from the 16-byte random identifier.

### `buildSurb`: Return Path Selection

`buildSurb` constructs one return path per SURB and returns the distributable
SURB object:

```nim
method buildSurb*(
  mixProto: MixProtocol,
  id: SURBIdentifier,
  destPeerId: PeerId,
  exitPeerId: PeerId
): Result[SURB, string]
```

Inside `buildSurb`, the implementation accumulates three aligned arrays:

```nim
var
  publicKeys: seq[FieldElement] = @[]
  hops: seq[Hop] = @[]
  delay: seq[seq[byte]] = @[]
```

Those arrays are then passed to `createSURB(publicKeys, delay, hops, id)`, which
constructs the Sphinx return-path header and reply key.

It excludes the forward-path exit and destination from the random part of the
return path:

```nim
var pubNodeInfoKeys =
  mixProto.nodePool.peerIds().filterIt(it != exitPeerId and it != destPeerId)
```

Then it selects `PathLength` hops. The loop index `i` is the return-path hop
index. With the current `PathLength = 3`, `i = 0` and `i = 1` are random
intermediate return hops, while `i = 2` is the final hop. For all but the last
hop, it picks random public mix nodes from the filtered pool. This branch does
not run for the final hop:

```nim
if i < PathLength - 1:
  let randomIndexPosition = cryptoRandomInt(mixProto.rng, availableIndices.len).valueOr:
    return err("failed to generate random num: " & error)
  let selectedIndex = availableIndices[randomIndexPosition]
  let randPeerId = pubNodeInfoKeys[selectedIndex]
  availableIndices.del(randomIndexPosition)

  let mixPubInfo = mixProto.nodePool.get(randPeerId)
  (
    mixPubInfo.peerId,
    mixPubInfo.multiAddr,
    mixPubInfo.mixPubKey,
    mixProto.delayStrategy.generateForEntry(),
  )
```

There are two index layers here. `pubNodeInfoKeys` stores the candidate peer IDs.
`availableIndices` stores the indices in `pubNodeInfoKeys` that have not yet
been selected for this return path. `cryptoRandomInt` chooses a random position
inside `availableIndices`; the value at that position is then used as the index
into `pubNodeInfoKeys`.

For example:

```text
pubNodeInfoKeys   = [peerA, peerB, peerC, peerD]
availableIndices = [0,     1,     2,     3]

randomIndexPosition = 2
selectedIndex       = availableIndices[2] = 2
randPeerId          = pubNodeInfoKeys[2] = peerC
```

After selecting `peerC`, the code removes that entry from `availableIndices`:

```nim
availableIndices.del(randomIndexPosition)
```

That prevents the same mix node from being selected twice in one SURB return
path. The tuple returned for a selected hop contains the libp2p peer ID,
dialable multiaddress, MIX public key used for Sphinx header construction, and
the encoded delay value for that hop.

The last hop is the original sender's own mix node:

```nim
else:
  (
    mixProto.mixNodeInfo.peerId,
    mixProto.mixNodeInfo.multiAddr,
    mixProto.mixNodeInfo.mixPubKey,
    0.uint16,
  )
```

This `else` branch is reached only when `i == PathLength - 1`. With
`PathLength = 3`, that means `i == 2`. So the last return-path hop is not random:
it is forcibly set to `mixProto.mixNodeInfo`, the local mix node that originally
created the SURB. In this example:

```text
i = 0  random mix node
i = 1  random mix node
i = 2  original sender's own mix node
```

The phrase "original sender" here means the node that created the SURB and sent
the original forward request. It is also the final recipient of the SURB reply,
because only that node has the stored `surbKey` and `surbSecret` needed to
recover the reply payload.

This maps to pull request 307 Section 8.7.2 Step 1: the initiating node selects
a return path with itself as the final hop and computes ephemeral secrets for
that path.

### Header Construction

The cryptographic construction is in `sphinx.nim`. The inputs collected during
return-path selection are:

- `publicKeys`: the MIX public keys for the selected return-path hops, in path
  order. These are not libp2p identity keys. They are Curve25519/Sphinx keys
  used to derive one shared secret per hop.
- `hops`: the serialized routing addresses for the same return-path hops.
- `delay`: the encoded delay value for each hop.
- `id`: the SURB identifier that the sender will later use to find the stored
  reply recovery keys.

`buildSurb` fills `publicKeys`, `hops`, and `delay` together while iterating
over the selected return-path nodes. The relevant section is:

```nim
for i in 0 ..< PathLength:
  let (peerId, multiAddr, mixPubKey, delayMillisec) =
    if i < PathLength - 1:
      let randomIndexPosition = cryptoRandomInt(mixProto.rng, availableIndices.len).valueOr:
        return err("failed to generate random num: " & error)
      let selectedIndex = availableIndices[randomIndexPosition]
      let randPeerId = pubNodeInfoKeys[selectedIndex]
      availableIndices.del(randomIndexPosition)
      let mixPubInfo = mixProto.nodePool.get(randPeerId).valueOr:
        return err("could not get mix pub info for peer: " & $randPeerId)
      (
        mixPubInfo.peerId,
        mixPubInfo.multiAddr,
        mixPubInfo.mixPubKey,
        mixProto.delayStrategy.generateForEntry(),
      )
    else:
      (
        mixProto.mixNodeInfo.peerId,
        mixProto.mixNodeInfo.multiAddr,
        mixProto.mixNodeInfo.mixPubKey,
        0.uint16,
      )

  publicKeys.add(mixPubKey)

  let multiAddrBytes = multiAddrToBytes(peerId, multiAddr).valueOr:
    return err("failed to convert multiaddress to bytes: " & error)

  hops.add(Hop.init(multiAddrBytes))
  delay.add(@(delayMillisec.uint16.toBytesBE()))
```

Each line feeds a different part of Sphinx construction:

- `publicKeys.add(mixPubKey)` stores the hop's MIX public key. Later,
  `computeAlpha(publicKeys)` uses these public keys to derive one shared secret
  per return-path hop.
- `multiAddrToBytes(peerId, multiAddr)` converts the hop's libp2p identity and
  dialable address into the fixed 94-byte `Hop` address format. Later,
  `computeBetaGamma` encrypts these hop addresses into the routing header.
- `delay.add(@(delayMillisec.uint16.toBytesBE()))` stores the hop delay as two
  big-endian bytes, matching `DelaySize = 2`. Later, each return-path hop
  decrypts its own delay value from Beta and applies it before forwarding.

The ordering matters. `publicKeys[i]`, `hops[i]`, and `delay[i]` must describe
the same return-path hop at index `i`; otherwise the encrypted routing header
would pair the wrong key, address, or delay with a hop.

At the end of `buildSurb`, those aligned arrays are handed to `createSURB`:

```nim
return createSURB(publicKeys, delay, hops, id)
```

`createSURB` computes the return-path `alpha_0`, per-hop secrets, `beta_0`, and
`gamma_0`, samples the reply key, and returns the final SURB object. The relevant
part is:

```nim
proc createSURB*(
  publicKeys: openArray[FieldElement],
  delay: openArray[seq[byte]],
  hops: openArray[Hop],
  id: SURBIdentifier,
  rng: ref HmacDrbgContext = newRng(),
): Result[SURB, string] =
  if id == default(SURBIdentifier):
    return err("id should be initialized")

  let (alpha_0, s) = computeAlpha(publicKeys).valueOr:
    return err("Error in alpha generation: " & error)

  let (beta_0, gamma_0) = computeBetaGamma(s, hops, delay, Hop(), id).valueOr:
    return err("Error in beta and gamma generation: " & error)

  var key = newSeqUninit[byte](k)
  rng[].generate(key)

  return ok(
    SURB(
      hop: hops[0],
      header: Header.init(alpha_0, beta_0, gamma_0),
      secret: Opt.some(s),
      key: key,
    )
  )
```

This is where the distributable SURB fields are assembled:

- `hop: hops[0]` is `hop_0`, the first return-path hop the exit should send to.
- `header: Header.init(alpha_0, beta_0, gamma_0)` is the precomputed Sphinx
  header for the return path.
- `key` is the reply key `k_tilde`, distributed with the SURB so the exit can
  encrypt the reply payload.
- `secret: Opt.some(s)` is local recovery material. It is stored in
  `connCreds` by `buildSurbs`, but is not serialized into the SURB sent to the
  exit.

#### Alpha and Per-Hop Secrets

`computeAlpha(publicKeys)` creates the initial Sphinx ephemeral public value and
the shared secret for each return-path hop:

```nim
var
  s: seq[seq[byte]] = newSeq[seq[byte]](publicKeys.len)
  alpha_0: seq[byte]
  alpha: FieldElement
  secret: FieldElement
  blinders: seq[FieldElement] = @[]

let x = generateRandomFieldElement()
blinders.add(x)

for i in 0 ..< publicKeys.len:
  if i == 0:
    alpha = multiplyBasePointWithScalars([blinders[i]])
    alpha_0 = fieldElementToBytes(alpha)
  else:
    alpha = multiplyPointWithScalars(alpha, [blinders[i]])

  secret = multiplyPointWithScalars(publicKeys[i], blinders)

  let blinder = bytesToFieldElement(
    sha256_hash(fieldElementToBytes(alpha) & fieldElementToBytes(secret))
  )

  blinders.add(blinder)
  s[i] = fieldElementToBytes(secret)
```

Conceptually:

- The sender samples an ephemeral scalar `x`.
- `blinders` is the blinding chain. It starts with `x`; after each hop, the code
  derives a new blinder from that hop's current `alpha` and shared secret.
- `alpha_0 = x * G` is the initial public value placed in the SURB header.
  `multiplyBasePointWithScalars([x])` computes this by multiplying the
  Curve25519 base point `G` by the scalar `x`. In the helper implementation,
  this is done by calling `public(x)`, because a Curve25519 public key is the
  base point multiplied by the private scalar.
- For every return-path hop, the sender derives a shared secret from that hop's
  MIX public key and the current blinding chain.
- The next `alpha` value is produced by multiplying the previous `alpha` by the
  next blinder. This lets every hop see a fresh-looking `alpha` while still
  allowing the sender to precompute all per-hop secrets.
- Each hop will later derive the same secret from its private key and the `alpha`
  value it receives while processing the Sphinx packet.
- The secrets `s[0] ... s[L-1]` are kept locally in `surb.secret` so the sender
  can recover the reply when the return packet reaches it.

#### Beta and Gamma

The SURB section of the spec indexes the return path in the direction the reply
will travel:

```text
i = 0           first return-path hop, the node the exit sends to
i = sLen - 1    terminal return-path hop, the original sender
```

This matches pull request 307 Section 8.7.2, where `hop_0` is the first hop on
the return path and the initiating node is the final hop.

The implementation uses the same index convention in its arrays:

```text
hops[0], publicKeys[0], delay[0], s[0]                 -> hop_0
hops[1], publicKeys[1], delay[1], s[1]                 -> hop_1
hops[sLen - 1], publicKeys[sLen - 1], delay[sLen - 1] -> hop_{L-1}
```

So `sLen - 1` does not mean `hop_0`; it means `hop_{L-1}`. In the SURB return
path constructed above, `hop_{L-1}` is the original sender's own mix node,
because `buildSurb` explicitly put `mixProto.mixNodeInfo` in the final hop slot.

Equivalently, for `PathLength = 3`:

```text
s[0] -> hop_0, first return hop
s[1] -> hop_1, second return hop
s[2] -> hop_2, terminal return hop/original sender
```

The countdown loop below changes construction order only. It does not change
which hop each `s[i]` belongs to.

There is only one `computeBetaGamma` routine. This is its full signature:

```nim
proc computeBetaGamma(
  s: seq[seq[byte]],
  hops: openArray[Hop],
  delay: openArray[seq[byte]],
  destHop: Hop,
  id: SURBIdentifier,
): Result[tuple[beta: seq[byte], gamma: seq[byte]], string] =
```

The forward path and the SURB return path both call this same function. The
difference is only in the argument values passed to `hops`, `destHop`, and `id`.

The implementation then iterates over the path indices from high to low:

```nim
proc computeBetaGamma(
  s: seq[seq[byte]],
  hops: openArray[Hop],
  delay: openArray[seq[byte]],
  destHop: Hop,
  id: SURBIdentifier,
): Result[tuple[beta: seq[byte], gamma: seq[byte]], string] =
  let sLen = s.len
  var
    beta: seq[byte]
    gamma: seq[byte]

  let filler = computeFillerStrings(s).valueOr:
    return err("Error in filler generation: " & error)

  for i in countdown(sLen - 1, 0):
    let
      beta_aes_key = deriveKeyMaterial("aes_key", s[i]).kdf()
      mac_key = deriveKeyMaterial("mac_key", s[i]).kdf()
      beta_iv = deriveKeyMaterial("iv", s[i]).kdf()

    if i == sLen - 1:
      let destBytes = destHop.serialize()
      let destPadding = destBytes & delay[i] & @id & newSeq[byte](PaddingLength)
      let aes = aes_ctr(beta_aes_key, beta_iv, destPadding)
      beta = aes & filler
    else:
      let betaPrefix =
        beta[0 .. (((r * (t + 1)) - t) * k) - 1]

      let routingInfo = RoutingInfo.init(
        hops[i + 1],
        delay[i],
        gamma,
        betaPrefix,
      )

      let serializedRoutingInfo = routingInfo.serialize()
      beta = aes_ctr(beta_aes_key, beta_iv, serializedRoutingInfo)

    gamma = hmac(mac_key, beta).toSeq()

  return ok((beta: beta, gamma: gamma))
```

The same `computeBetaGamma` routine is used for both normal forward packets and
SURB return-path headers. The difference is entirely in the arguments.

For a normal forward message, `wrapInSphinxPacket` calls:

```nim
let (beta_0, gamma_0) = computeBetaGamma(
  s,
  hop,
  delay,
  destHop,
  default(SURBIdentifier),
)
```

For a SURB, `createSURB` calls:

```nim
let (beta_0, gamma_0) = computeBetaGamma(
  s,
  hops,
  delay,
  Hop(),
  id,
)
```

The argument differences are:

| Argument  | Forward message                                                                                               | SURB return path                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `hops`    | Forward mix path: first mix hop, intermediate hops, final exit hop.                                           | Return mix path: first return hop, intermediate return hops, original sender as final hop.                                               |
| `destHop` | Real destination address, encoded as a `Hop`. The forward-path exit uses it to dial the destination protocol. | Empty `Hop()`, which serializes as zero address bytes. This marks that the terminal return hop is not forwarding to another destination. |
| `id`      | `default(SURBIdentifier)`, all zero bytes.                                                                    | Random nonzero SURB identifier generated by `buildSurbs`. The original sender uses it to find `connCreds`.                               |

For `PathLength = 3`, the final routing block produced by the same
`if i == sLen - 1` branch therefore differs like this:

```text
Forward message final block:
  destHop = destination address
  delay   = 0
  id      = 0^16
  meaning = normal exit; forward plaintext to destination

SURB return final block:
  destHop = zero Hop()
  delay   = 0
  id      = random SURB id
  meaning = reply arrived at original sender; recover using connCreds[id]
```

So there is no separate "forward Beta" and "SURB Beta" algorithm. There is one
Beta/Gamma algorithm with two terminal-block encodings.

`beta` and `gamma` are mutable byte sequences. During the countdown loop, they
always hold the header state for the hop that was just constructed. For a
3-hop path, after the first iteration they hold `beta_2/gamma_2`; after the
second iteration they hold `beta_1/gamma_1`; after the final iteration they hold
`beta_0/gamma_0`, which is what goes into the SURB header.

#### Filler

`filler` is precomputed before the Beta/Gamma countdown loop:

```nim
proc computeFillerStrings(s: seq[seq[byte]]): Result[seq[byte], string] =
  var filler: seq[byte] = @[]

  for i in 1 ..< s.len:
    let
      aes_key = deriveKeyMaterial("aes_key", s[i - 1]).kdf()
      iv = deriveKeyMaterial("iv", s[i - 1]).kdf()

    let
      fillerLength = (t + 1) * k
      zeroPadding = newSeq[byte](fillerLength)

    filler = aes_ctr_start_index(
      aes_key,
      iv,
      filler & zeroPadding,
      (((t + 1) * (r - i)) + t + 2) * k,
    )

  return ok(filler)
```

The hard part is why this exists. Each hop decrypts and shifts the routing
header state as the packet moves forward. Without filler, the end of Beta would
gradually become distinguishable padding, and a hop could infer information
about its position in the path or the remaining path length. Filler precomputes
the bytes that must be appended at the tail so that, after each hop's Sphinx
transformation, the Beta field still has the right fixed-size shape and does not
reveal where the packet is in the path.

The call to `aes_ctr_start_index` is what makes the filler line up with the tail
of the conceptual full Beta stream:

```nim
filler = aes_ctr_start_index(
  aes_key,
  iv,
  filler & zeroPadding,
  (((t + 1) * (r - i)) + t + 2) * k,
)
```

`filler & zeroPadding` extends the previous filler by one routing block:

```text
(t + 1) * k = (6 + 1) * 16 = 112 bytes
```

`aes_ctr_start_index` encrypts that data as if it started at byte offset
`startIndex` in a larger AES-CTR stream. This matters because filler bytes live
at the tail of Beta, not at byte offset 0. AES-CTR keystream bytes depend on
position, so filler must be encrypted with the keystream positions where those
bytes will sit inside the full Beta field.

For the current constants, the filler loop runs twice for `PathLength = 3`:

```text
i = 1:
  startIndex = (((7) * (5 - 1)) + 8) * 16
             = 576
  input length = 112 bytes

i = 2:
  startIndex = (((7) * (5 - 2)) + 8) * 16
             = 464
  input length = 224 bytes
```

So the final filler is 224 bytes. Conceptually, it is pre-encrypted tail data
that will remain well-formed after earlier hops append zero padding and decrypt
their Beta layers.

In this implementation, filler is only appended when constructing the terminal
routing block:

```nim
if i == sLen - 1:
  ...
  beta = aes & filler
```

That may look surprising, but remember the countdown loop builds nested header
state. The terminal block is built first and becomes the innermost state carried
forward into `beta_{L-2}`, `beta_{L-3}`, and eventually `beta_0`. Appending
filler there prepares the tail bytes that will be needed after later hops peel
their layers.

The loop in `computeFillerStrings` starts at `i = 1` because no filler is needed
before the first hop has processed anything. The expression `s[i - 1]` therefore
starts with `s[0]`, which is the secret for `hop_0`, the first return hop. It
does not start with the original sender. The filler code uses each earlier
travel-order hop's `aes_key`/`iv` to predict how zero padding at the tail will
transform as those earlier layers are processed.

That is the end of the filler-specific part. The next paragraphs return to the
general Beta/Gamma construction flow.

This countdown is construction order, not path-travel order. It is needed
because each earlier hop's routing block contains encrypted information for the
next hop. For a 3-hop return path:

```text
hop 0 -> hop 1 -> hop 2/original sender
```

the header has to be prepared in this dependency order:

```text
1. build beta_2/gamma_2 for the original sender
2. build beta_1/gamma_1, embedding gamma_2 and part of beta_2
3. build beta_0/gamma_0, embedding gamma_1 and part of beta_1
```

The exit receives only `beta_0/gamma_0` in the SURB header. Hop 0 decrypts its
routing block and learns how to forward to hop 1, including the `beta_1/gamma_1`
state that hop 1 will verify next. Hop 1 does the same for hop 2. That is the
reason the construction loop counts down from the original sender back to the
first return hop.

#### Digression: Why Build `beta_2` Before `beta_0`?

For both normal forward messages and SURB return messages, the path is indexed
in travel order:

```text
hop_0 -> hop_1 -> hop_2
```

For a normal forward message:

```text
sender -> hop_0 -> hop_1 -> hop_2/exit -> destination
```

For a SURB reply:

```text
exit -> hop_0 -> hop_1 -> hop_2/original sender
```

In both cases, the packet is processed in travel order:

```text
hop_0 processes beta_0/gamma_0
hop_1 processes beta_1/gamma_1
hop_2 processes beta_2/gamma_2
```

But the header must be constructed in the opposite order because each earlier
hop's routing block embeds the next hop's header state:

```text
beta_0 contains next-hop info for hop_1 plus beta_1/gamma_1
beta_1 contains next-hop info for hop_2 plus beta_2/gamma_2
beta_2 contains the final instruction
```

So `beta_0` cannot be built until `beta_1/gamma_1` exists, and `beta_1` cannot
be built until `beta_2/gamma_2` exists. The construction dependency is:

```text
1. build beta_2/gamma_2
2. use those to build beta_1/gamma_1
3. use those to build beta_0/gamma_0
```

The packet/SURB then carries `beta_0/gamma_0` as the starting header state. At
runtime, each hop decrypts its own layer and reveals the next header state:

```text
construction: beta_2 -> beta_1 -> beta_0
processing:   beta_0 -> beta_1 -> beta_2
```

For SURBs, the final instruction in `beta_2` is special: it contains zero
address/delay plus the SURB identifier. For normal forward messages, the final
instruction contains the destination address.

Returning to the SURB header construction code, each iteration of
`computeBetaGamma` derives the keys needed to encrypt and authenticate one hop's
routing block.

For each hop secret `s[i]`, the code derives:

- `beta_aes_key`: encrypts the routing block for that hop.
- `beta_iv`: IV for that routing-block encryption.
- `mac_key`: authenticates the resulting `beta`.

For hops where `i < sLen - 1`, meaning every return-path hop before the original
sender, the routing block contains the next hop's address, this hop's delay, the
next hop's `gamma`, and the next encrypted `beta` prefix:

```nim
let betaPrefix =
  beta[0 .. (((r * (t + 1)) - t) * k) - 1]

let routingInfo = RoutingInfo.init(
  hops[i + 1],
  delay[i],
  gamma,
  betaPrefix,
)

let serializedRoutingInfo = routingInfo.serialize()
beta = aes_ctr(beta_aes_key, beta_iv, serializedRoutingInfo)
```

That is the onion-routing part of the header: when hop `i` processes the packet,
it can decrypt only its own routing block and learn only the next hop, delay,
next MAC, and next encrypted header state.

The `betaPrefix` slice is the part of the already-built next-hop `beta` that
fits into a `RoutingInfo` block. The formula is:

```text
(((r * (t + 1)) - t) * k)
```

With the current constants:

```text
r = 5
t = 6
k = 16

((5 * (6 + 1)) - 6) * 16
= ((5 * 7) - 6) * 16
= (35 - 6) * 16
= 29 * 16
= 464 bytes
```

That matches the `RoutingInfo.serialize()` layout:

```text
Addr  = 94 bytes
Delay = 2 bytes
Gamma = 16 bytes
Beta  = 464 bytes
Total = 576 bytes
```

`RoutingInfo.serialize()` must produce exactly 576 bytes because the Sphinx
header format has a fixed-size Beta field. Each non-terminal hop encrypts one
serialized `RoutingInfo` block to produce the next `beta` value. Since address,
delay, and gamma consume 112 bytes, only 464 bytes are available for carrying
forward the next encrypted Beta state. The slice:

```nim
beta[0 .. 463]
```

keeps exactly that prefix.

There is an important distinction here:

```text
BetaSize = ((r * (t + 1)) + 1) * k = 576 bytes
betaPrefix size = ((r * (t + 1)) - t) * k = 464 bytes
```

So `(((r * (t + 1)) - t) * k)` is not the full Beta size in this
implementation. The full `beta` value is 576 bytes. The 464-byte slice is the
amount of the already-built next-hop Beta that can be embedded inside the
previous hop's `RoutingInfo`, because `RoutingInfo` must also include 112 bytes
of fresh routing data:

```text
next hop address   94 bytes
delay               2 bytes
next gamma         16 bytes
---------------------------
fresh routing     112 bytes

576-byte RoutingInfo - 112 fresh bytes = 464 bytes for betaPrefix
```

During packet processing, the receiving hop appends `(t + 1) * k = 112` zero
bytes before decrypting Beta:

```nim
let zeroPadding = newSeq[byte]((t + 1) * k)
let B = aes_ctr(beta_aes_key, beta_iv, beta & zeroPadding)
```

That is how the hop recovers a full routing block containing 112 bytes of fresh
routing data plus a restored 576-byte next-hop Beta state. The construction side
stores only a 464-byte prefix because the processing side later supplies the
extra 112 zero bytes before decryption.

For `i == sLen - 1`, meaning the terminal return-path hop and original sender,
the routing block is special:

The call passes `Hop()` as `destHop` and a non-default `id`. In
`computeBetaGamma`, the final routing block is built as:

```nim
let destBytes = destHop.serialize()
let destPadding = destBytes & delay[i] & @id & newSeq[byte](PaddingLength)
let aes = aes_ctr(beta_aes_key, beta_iv, destPadding)
beta = aes & filler
```

For a SURB, `destHop.serialize()` is all zeros and the final delay is zero.
That produces the pull request 307 Section 8.7.2 Step 3 shape:

```text
zero address/delay || SURB id || zero padding
```

This is how the original sender, when it becomes the final return-path hop, can
distinguish a SURB reply from a normal forward exit message.

After each final or non-final `beta` calculation, `gamma` is computed over that
`beta`:

```nim
gamma = hmac(mac_key, beta).toSeq()
```

The first values produced by the backwards loop, `beta_0` and `gamma_0`, are the
values placed in the distributed SURB header. Later return-path hops derive and
verify the next `gamma` values as they process the packet.

#### Hop-by-Hop Beta Example

For a concrete 3-hop SURB return path, the countdown loop behaves like this:

```text
return travel path: hop_0 -> hop_1 -> hop_2/original sender
construction loop: i = 2, then i = 1, then i = 0
```

At `i = 2`, the code builds the terminal block for the original sender:

```text
destPadding =
  zero Hop() address  94 bytes
  zero delay           2 bytes
  SURB id             16 bytes
  zero padding       240 bytes  # PaddingLength

AES-CTR(key_2, iv_2, destPadding) = 352 bytes
filler                            = 224 bytes
beta_2                            = 576 bytes
gamma_2 = HMAC(mac_key_2, beta_2)
```

Here `PaddingLength` is:

```text
(((t + 1) * (r - PathLength)) + 1) * k
= (((6 + 1) * (5 - 3)) + 1) * 16
= 240 bytes
```

At this point, the mutable `beta`/`gamma` variables hold `beta_2/gamma_2`.

At `i = 1`, the code builds routing instructions for `hop_1`. When `hop_1`
later processes the packet, it needs to learn how to forward to `hop_2` and what
header state `hop_2` should verify. So `RoutingInfo.init` is effectively:

```nim
let routingInfo = RoutingInfo.init(
  hops[2],          # address of hop_2/original sender
  delay[1],         # delay hop_1 should apply before forwarding
  gamma_2,          # MAC that hop_2 should verify
  beta_2[0 .. 463],
)
```

`RoutingInfo.init` is just a structured container:

```nim
RoutingInfo(
  Addr: hops[2],
  Delay: delay[1],
  Gamma: gamma_2,
  Beta: beta_2[0 .. 463],
)
```

Then serialization lays those fields out in a fixed 576-byte block:

```text
hops[2]          94 bytes
delay[1]          2 bytes
gamma_2          16 bytes
beta_2 prefix   464 bytes
-------------------------
serialized      576 bytes
```

That block is encrypted to become `beta_1`, and then `gamma_1` is computed:

```text
beta_1 = AES-CTR(key_1, iv_1, serialized RoutingInfo for hop_1)
gamma_1 = HMAC(mac_key_1, beta_1)
```

At `i = 0`, the same pattern repeats for `hop_0`:

```nim
let routingInfo = RoutingInfo.init(
  hops[1],          # address of hop_1
  delay[0],         # delay hop_0 should apply before forwarding
  gamma_1,          # MAC that hop_1 should verify
  beta_1[0 .. 463],
)
```

After encryption:

```text
beta_0 = AES-CTR(key_0, iv_0, serialized RoutingInfo for hop_0)
gamma_0 = HMAC(mac_key_0, beta_0)
```

The SURB distributed to the exit contains `hop_0` plus `alpha_0/beta_0/gamma_0`.
It does not contain `beta_1` or `beta_2` as separate fields. Those later header
states are nested inside `beta_0` through the encrypted `RoutingInfo` blocks.

#### Hop-by-Hop Processing Example

The processing side reverses the construction dependency. A return packet starts
at `hop_0` with:

```text
Header(alpha_0, beta_0, gamma_0)
Payload(delta_0)
```

At every non-terminal hop, `processSphinxPacket` verifies the current Gamma,
decrypts Beta with 112 bytes of appended zero padding, transforms Delta, and
creates the header for the next hop:

```nim
if hmac(mac_key, beta).toSeq() != gamma:
  return InvalidMAC

let delta_prime = aes_ctr(delta_aes_key, delta_iv, payload)

let zeroPadding = newSeq[byte]((t + 1) * k)
let B = aes_ctr(beta_aes_key, beta_iv, beta & zeroPadding)

let routingInfo = RoutingInfo.deserialize(B)
let (address, delay, gamma_prime, beta_prime) =
  routingInfo.getRoutingInfo()

let alpha_prime = multiplyPointWithScalars(alphaFE, [blinder])

let sphinxPkt = SphinxPacket.init(
  Header.init(fieldElementToBytes(alpha_prime), beta_prime, gamma_prime),
  delta_prime,
)
```

For the same 3-hop return path, `hop_0` receives `beta_0/gamma_0`:

```text
input at hop_0:
  beta_0   576 bytes
  gamma_0   16 bytes

processing:
  B_0 = AES-CTR(key_0, iv_0, beta_0 || 112 zero bytes)
```

`B_0` decrypts to the routing block that was built for `hop_0`:

```text
B_0 =
  hops[1]          94 bytes  # next hop address
  delay[0]          2 bytes  # delay for hop_0
  gamma_1          16 bytes  # MAC for hop_1 to verify
  beta_1          576 bytes  # restored next-hop Beta
```

`RoutingInfo.deserialize(B_0)` returns:

```text
address      = hops[1]
delay        = delay[0]
gamma_prime  = gamma_1
beta_prime   = beta_1
```

Then `hop_0` forwards:

```text
Header(alpha_1, beta_1, gamma_1)
Payload(delta_1)
```

`hop_1` repeats the same process:

```text
B_1 = AES-CTR(key_1, iv_1, beta_1 || 112 zero bytes)

B_1 =
  hops[2]          94 bytes
  delay[1]          2 bytes
  gamma_2          16 bytes
  beta_2          576 bytes
```

Then `hop_1` forwards:

```text
Header(alpha_2, beta_2, gamma_2)
Payload(delta_2)
```

At `hop_2`, the original sender, the decrypted routing block is not parsed as a
normal `RoutingInfo`. Instead, the zero address/delay plus nonzero SURB
identifier tells the code this is a reply packet:

```text
B_2 =
  zero address/delay  96 bytes
  SURB id             16 bytes
  zero padding       ...
```

The sender extracts the SURB identifier and hands `delta_prime` to reply
recovery. That final payload is not application plaintext yet; it still needs
`processReply(surbKey, surbSecret, delta_prime)`.

### Local Credential Storage

`buildSurbs` stores local recovery state in `mixProto.connCreds`:

```nim
mixProto.connCreds[id] = ConnCreds(
  igroup: igroup,
  surbSecret: surb.secret.get(),
  surbKey: surb.key,
  incoming: incoming,
)
```

`ConnCreds` contains:

```nim
type
  SURBIdentifierGroup = ref object
    members: HashSet[SURBIdentifier]

  ConnCreds = object
    igroup: SURBIdentifierGroup
    incoming: AsyncQueue[seq[byte]]
    surbSecret: serialization.Secret
    surbKey: serialization.Key
```

Mapping to pull request 307 Section 8.7.2 Step 4:

- `surbKey` is `k_tilde`.
- `surbSecret` is `s_0 ... s_{L-1}`.
- `connCreds[id]` is the local table indexed by SURB identifier.
- `incoming` is implementation-specific glue for waking the `Connection` reader.

The `SURBIdentifierGroup` is not described in the pull request spec. It is an
implementation policy for multiple SURBs attached to one request. All SURB IDs
created for that request share the same group object.

## Distribution to the Exit

Once SURBs are serialized into the forward payload, the whole message is encoded
as a normal `MixMessage`, padded, and wrapped in the forward Sphinx packet:

```nim
let message = buildMessage(msgWithSurbs, codec, mixProto.mixNodeInfo.peerId)
let sphinxPacket = wrapInSphinxPacket(message, publicKeys, delay, hop, destHop)
```

The exit node eventually decrypts the forward packet and extracts SURBs:

```nim
let deserialized = MixMessage.deserialize(unpaddedMsg)
let (surbs, message) = extractSURBs(deserialized.message)

await mixProto.exitLayer.onMessage(
  deserialized.codec, message, processedSP.destination, surbs
)
```

`extractSURBs` reconstructs only the distributed part:

```nim
surbs[i].hop = ?Hop.deserialize(hopBytes)
surbs[i].header = ?Header.deserialize(headerBytes)
surbs[i].key = ?readBytes(offset, Opt.some(k))
```

The exit receives no `secret` field. That is correct: only the original sender
should know the per-hop return-path secrets needed for final reply recovery.

## Exit-Side Use of SURBs

The exit layer first forwards the request to the real destination protocol:

```nim
let destConn = await self.switch.dial(destPeerId, @[destAddr], codec)
await destConn.write(message)
```

If SURBs were attached, it reads a destination response using the registered
`DestReadBehavior`:

```nim
let rawResponse = await behavior.callback(destConn)
```

Then it calls:

```nim
await self.reply(surbs, response)
```

The current implementation sends the same response over every supplied SURB:

```nim
let respFuts = surbs.mapIt(self.onReplyDialer(it, msg))
await allFutures(respFuts)
```

This is an important behavioral choice. Pull request 307 Section 8.7.3 describes
how to use a SURB; it does not require using every SURB for the same response.
The Nim implementation currently treats multiple SURBs as redundant return paths
for one response.

Each individual SURB is used in `mix_protocol.reply`:

```nim
let (peerId, multiAddr) = surb.hop.get().bytesToMultiAddr()
let message = buildMessage(msg, "", peerId)
let sphinxPacket = useSURB(surb, message)
await mixProto.sendPacket(peerId, multiAddr, sphinxPacket, SendPacketLogConfig(logType: Reply))
```

`buildMessage(msg, "", peerId)` pads the reply as a normal `MessageChunk`
wrapped in a `MixMessage` with an empty codec. The empty codec is acceptable
because the reply is matched by SURB identifier rather than by application
protocol negotiation.

`useSURB` encrypts the reply payload once with the SURB reply key:

```nim
let delta_aes_key = deriveKeyMaterial("delta_aes_key", surb.key).kdf()
let delta_iv = deriveKeyMaterial("delta_iv", surb.key).kdf()
let serializedMsg = msg.serialize()
let delta = aes_ctr(delta_aes_key, delta_iv, serializedMsg)

SphinxPacket.init(surb.header, delta)
```

This maps to pull request 307 Section 8.7.3:

- prepare/pad the reply message;
- encrypt the payload with `k_tilde`;
- assemble a Sphinx packet with the SURB header;
- transmit it to `hop_0` over `/mix/1.0.0`.

## Return Path Processing

Return packets use the same `/mix/1.0.0` handler as forward packets.
Intermediate return-path nodes do not know they are forwarding a reply. They
perform ordinary Sphinx processing:

```nim
let processedSP = processSphinxPacket(...)

case processedSP.status
of Intermediate:
  await mixProto.writeLp(nextPeerId, @[nextAddr], @[MixProtocolID], outgoingPacket)
```

Every intermediate hop decrypts one payload layer and forwards the transformed
packet. This is why pull request 307 Section 8.7.3 says the reply is initially encrypted
with `k_tilde`, and each return-path hop adds the corresponding Sphinx payload
transformation. The sender must later remove `L + 1` layers: one for `k_tilde`
and one for each return-path secret.

## Sender-Side Reply Detection

The original sender is the final hop of the return path. In
`processSphinxPacket`, after decrypting the final routing block `B`, the code
distinguishes normal forward exit from SURB reply:

```nim
if B.isZeros((t + 1) * k, ((t + 1) * k) + PaddingLength - 1):
  let hop = Hop.deserialize(B[0 .. AddrSize - 1])

  if B.isZeros(AddrSize, ((t + 1) * k) - 1):
    # normal forward exit
  elif B.isZeros(0, (t * k) - 1):
    return ok(
      ProcessedSphinxPacket(
        status: Reply,
        id: B.extractSurbId(),
        delta_prime: delta_prime,
      )
    )
```

The SURB identifier is extracted at `t * k`, matching pull request 307 Section 8.7.4:

```nim
template extractSurbId(data: seq[byte]): SURBIdentifier =
  const startIndex = t * k
  const endIndex = startIndex + SurbIdLen - 1
  var id: SURBIdentifier
  copyMem(addr id[0], addr data[startIndex], SurbIdLen)
  id
```

## Reply Recovery

The `Reply` branch in `handleMixMessages` performs implementation-level reply
recovery.

First it looks up the SURB identifier:

```nim
if not mixProto.connCreds.hasKey(processedSP.id):
  mix_messages_error.inc(labelValues = ["Sender/Reply", "NO_CONN_FOUND"])
  return

connCred = mixProto.connCreds[processedSP.id]
```

This maps to pull request 307 Section 8.7.5 Step 1: retrieve `k_tilde` and
`s_0 ... s_{L-1}` by `id`; if not found, discard.

Then it removes all payload encryption layers:

```nim
let reply = processReply(
  connCred.surbKey, connCred.surbSecret, processedSP.delta_prime
)
```

`processReply` starts with `k_tilde`, then iterates over each stored return-path
secret:

```nim
var delta = delta_prime[0 ..^ 1]
var key_prime = key

for i in 0 .. s.len:
  if i != 0:
    key_prime = s[i - 1]

  let delta_aes_key = deriveKeyMaterial("delta_aes_key", key_prime).kdf()
  let delta_iv = deriveKeyMaterial("delta_iv", key_prime).kdf()

  delta = aes_ctr(delta_aes_key, delta_iv, delta)

let deserializeMsg = Message.deserialize(delta)
```

This maps directly to pull request 307 Section 8.7.5 Step 2: decrypt with `k_tilde`, then
with `s_0 ... s_{L-1}`, then check/strip the leading `k` zero bytes through
`Message.deserialize`.

After that, the implementation deletes all credentials in the identifier group:

```nim
for id in connCred.igroup.members:
  mixProto.connCreds.del(id)
```

This is the "first valid reply wins" policy. If a request had `numSurbs > 1`,
all those SURB IDs are in the same group. The first reply that can be recovered
causes all sibling SURB credentials to be removed.

Late replies for the same request are dropped because their identifiers no
longer exist:

```nim
if not mixProto.connCreds.hasKey(processedSP.id):
  mix_messages_error.inc(labelValues = ["Sender/Reply", "NO_CONN_FOUND"])
  return
```

Finally, the recovered reply is decoded and pushed to the queue used by
`MixEntryConnection.readOnce`:

```nim
let msgChunk = MessageChunk.deserialize(reply)
let unpaddedMsg = msgChunk.removePadding()
let deserialized = MixMessage.deserialize(unpaddedMsg)

await connCred.incoming.put(deserialized.message)
```

Only this first successfully recovered reply becomes visible to the application.

## `numSurbs > 1`

In the current implementation, multiple SURBs attached to one request behave as
redundant return paths:

1. The sender creates `numSurbs` distinct SURB identifiers.
2. Each SURB has its own return path, header, reply key, and stored recovery
   credentials.
3. All identifiers are inserted into one `SURBIdentifierGroup`.
4. The exit sends the same destination response through all supplied SURBs.
5. The sender accepts the first valid reply to arrive.
6. The sender deletes credentials for every SURB in the group.
7. Late duplicate replies are discarded with `NO_CONN_FOUND`.
8. One response byte sequence is written to the reply queue.

This gives redundancy against return-path loss or delay, but it does not provide
multi-response semantics. If a future rewrite wants multiple distinct responses,
the grouping and `MixEntryConnection` read model need to change.

## Spec Mapping Summary

| Pull Request 307 Section | Spec Concept | Nim Implementation |
| --- | --- | --- |
| 8.7.1 | SURB is `hop_0`, header, reply key | `SURB(hop, header, key)` in `serialization.nim`; serialized as `hop || header || key` |
| 8.7.2 Step 1 | Select return path ending at sender | `MixProtocol.buildSurb`; last hop is `mixProto.mixNodeInfo` |
| 8.7.2 Step 2 | Sample `id` and `k_tilde` | `buildSurbs` samples `id`; `createSURB` samples `key` |
| 8.7.2 Step 3 | Header has zero address/delay plus `id` | `computeBetaGamma(..., Hop(), id)` |
| 8.7.2 Step 4 | Store recovery tuple by `id` | `mixProto.connCreds[id] = ConnCreds(...)` |
| 8.7.3 | Recipient uses SURB to reply | `ExitLayer.reply` -> `MixProtocol.reply` -> `useSURB` |
| 8.7.4 | Final return hop extracts `id` | `processSphinxPacket` returns `ProcessedSphinxPacket(status: Reply, id, delta_prime)` |
| 8.7.5 | Recover reply with stored keys | `processReply(surbKey, surbSecret, delta_prime)` |

## Rewrite-Relevant Observations

- The current model is single-request/single-visible-reply, even when multiple
  SURBs are attached.
- Multiple SURBs are grouped and treated as redundant alternatives. First valid
  reply consumes the whole group.
- The exit currently sends the same response through every SURB. That is a
  policy choice in `ExitLayer.reply`, not an inherent requirement of the SURB
  format.
- The reply queue is local connection glue, not part of the cryptographic spec.
- `MixEntryConnection` creates one future waiting for one incoming queue item.
  It is not currently a robust stream abstraction for repeated request/reply
  cycles over the same connection object.
- `connCreds` has a TODO in `MixProtocol`: credentials may need cleanup when a
  response never arrives or the connection is closed.
- The spec says a SURB must be used at most once. The implementation enforces
  sender-side single acceptance by deleting credentials, but the exit can still
  attempt to use all SURBs it was given. The sender drops late duplicates.
- The implementation does not explicitly check SURB identifier collisions before
  inserting into `connCreds`; it relies on 16 bytes of randomness.
- The implementation's application payload budget is smaller than raw
  `MessageSize` because `MessageChunk` reserves two bytes for padding length and
  four bytes for sequence number. Use `getMaxMessageSizeForCodec(codec,
  numberOfSurbs)` when calculating usable application bytes.

## Appendix: Filler as Suffix Consistency

Another useful way to understand filler is as a suffix consistency mechanism.
This view focuses on what happens to the tail of Beta when a processing node
appends zero bytes before decrypting.

Let:

```text
q = (t + 1) * k = 112 bytes
BetaSize = 576 bytes
betaPrefix size = 464 bytes
```

When hop `i` processes a packet, it decrypts:

```text
beta_i || 0^112
```

The appended 112 zero bytes are not transmitted, but after AES-CTR they become
position-specific keystream bytes. For hop 0:

```text
tail_0 = KS_0[576..687]
```

For hop 0 to reconstruct a full `beta_1`, the missing suffix of `beta_1` must
equal that tail:

```text
beta_1[464..575] = tail_0
```

The first filler iteration computes exactly this:

```text
F1 = AES-CTR_0(start = 576, 0^112)
   = KS_0[576..687]
```

For hop 1, the same problem appears one layer deeper. We need:

```text
beta_2[464..575] = KS_1[576..687]
```

But `beta_1[464..575]` is produced by encrypting `beta_2[352..463]` under hop
1's Beta key at positions `464..575`. To make hop 0's reconstructed
`beta_1[464..575]` equal `F1`, construction must choose:

```text
beta_2[352..463] XOR KS_1[464..575] = F1
```

So:

```text
beta_2[352..463] = F1 XOR KS_1[464..575]
```

The second filler iteration computes both required pieces at once:

```text
F2 = AES-CTR_1(start = 464, F1 || 0^112)

F2 =
  (F1 XOR KS_1[464..575])
  ||
  (0^112 XOR KS_1[576..687])
```

That final `F2` is appended to the terminal Beta block:

```text
beta_2 = AES-CTR_2(destPadding) || F2
```

So filler is not just "padding." It is precomputed tail material that makes the
suffix bytes created from appended zeros at one hop match the suffix bytes the
next Beta state needs.

Compactly:

```text
Construction:
  precompute encrypted tail bytes as filler

Processing at each hop:
  decrypt beta || 112 zero bytes
  consume the first 112 bytes as routing info
  carry the remaining 576 bytes forward as next beta
```
