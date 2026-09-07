---
tags:
  - logos-storage/discovery
  - logos-storage/mix
  - logos-storage/libp2p
related:
  - "[[New Logos Storage Discovery]]"
  - "[[Block Exchange Peer Stores]]"
  - "[[Mix Transport Design Specification]]"
---
# Mix Discovery through Provider Records

When a node discovers providers for a CID, the returned provider record already identifies nodes that are relevant to the requested content. If the provider record also carries the provider's Mix public key, the requester can add the provider to the Mix node pool before calling `MixTransport.connect(providerPeerId)`. Provider discovery then serves two related purposes: finding a content provider and obtaining the public information required to route anonymously to that provider.

## Information already present in a provider record

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

## Encoding the Mix key as a multiaddress component

An address such as:

```text
/ip4/192.0.2.10/tcp/8901/mix-transport/<encoded-data>
```

cannot be parsed by the current `nim-libp2p` implementation. `MultiAddress.init` accepts only protocols present in the compile-time multicodec and multiaddress protocol tables, and neither `mix-transport` nor `mix` is currently registered.

`nim-libp2p` supports compile-time multicodec and multiaddress extensions, so a custom length-delimited component could make this representation mechanically possible. Every DHT node that decodes and stores the provider record would need the same extension. A node without the extension would reject the unknown multiaddress while decoding the signed provider record, which makes a gradual deployment difficult.

Embedding the complete `MixPubInfo` would also duplicate the peer ID, transport address and libp2p public key already authenticated by the signed provider record. If a custom multiaddress is used as an interim representation, the component should contain only a versioned 32-byte Mix public key. Discovery must remove or ignore the metadata component before passing ordinary addresses to libp2p dialing or to Mix's transport-address encoder.

The multiaddress representation remains a semantic compromise. A multiaddress normally describes how to reach a service, whereas the Mix public key is cryptographic service metadata. Treating metadata as an address also allows the pseudo-address to leak into address selection and dialing code unless every consumer filters it correctly.

Record size also matters in the current discovery transport. Provider messages travel through discovery v5 over UDP. `handleGetProviders` currently puts every returned provider record into one `ProvidersMessage`; the source contains a `TODO` for splitting provider responses across multiple messages. A large text-encoded `MixPubInfo` in every address would amplify an existing packet-size risk. Carrying only the 32-byte key keeps the additional cost small, but provider-response sizing and splitting should still be corrected independently.

## Extended peer records provide a cleaner shape

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

## Validation and updates

Whichever encoding is selected, a requester must validate the information before adding the provider to the Mix node pool:

1. Verify the signed provider-record envelope.
2. Verify that the envelope's public key produces the `PeerId` carried by the record.
3. Require a secp256k1 libp2p key because the current Mix implementation stores `SkPublicKey`.
4. Decode exactly one supported, versioned Mix public key and reject malformed or conflicting declarations.
5. Select a Mix-supported TCP or QUIC address from the ordinary provider addresses.
6. Apply the provider record's sequence number or another freshness rule so an older advertisement cannot overwrite a newer Mix key or address.

Provider records are replicated and can remain available after a provider rotates its Mix key or changes address. Dynamic pool insertion therefore also needs an update and expiry policy. The current `MixNodePool.add` overwrites the Mix public key, adds the address with infinite confidence, and does not remove older addresses. Those semantics are suitable for manually curated static configuration but need refinement before discovered records can rotate or expire cleanly.

## Recommended direction

Carrying Mix discovery information with the CID provider advertisement is a strong fit for the download flow: the provider lookup returns both a relevant provider and the information needed to establish a Mix session with that provider.

The preferred representation is signed service metadata containing only a version and the 32-byte Mix public key, while reusing the peer ID, address and libp2p public key already present in the signed record. `ExtendedPeerRecord.services` has the right conceptual shape and size, but the Storage DHT must first support extended provider records. A custom multiaddress component can serve as a prototype, but the custom component requires protocol registration throughout the DHT deployment and careful filtering from ordinary address consumers.
