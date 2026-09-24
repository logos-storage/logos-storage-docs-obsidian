---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Logos Storage Integration - Download Transport Selection]]"
  - "[[Mix Transport Documentation Maintenance]]"
---
# Mix Discovery through Provider Records

## A provider record supplies a destination

Discovery finds providers for a content CID. Each provider record contains its peer identity and advertised multiaddresses. A Mix-capable provider can advertise a `/mix-transport/` component alongside its ordinary addresses. That address supplies the endpoint and public keys required to contact the provider anonymously; it does not mean that the provider must become a relay.

The component carries 65 bytes: a 33-byte secp256k1 libp2p public key followed by a 32-byte Mix public key. Its textual representation uses canonical URL-safe base64. The preceding components carry the network endpoint. The codec and conversions come from MixTransport's `address/ext.nim`; the surrounding application includes this extension in its libp2p multiaddress build configuration.

## Validation before dialing

Storage's `mixAddresses` helper selects addresses whose parsed Mix identity matches the provider PeerId. MixTransport's parser checks the encoded key lengths, reconstructs the peer identity from the public key, and retains the endpoint prefix. Mix’s explicit-destination send API separately validates that this endpoint can be encoded for its packet path. Invalid declarations are not usable Mix destinations. This address validation does not replace provider-record signature or freshness handling in discovery.

For a Mix download, manifest fetching and BlockExchange pass these addresses to the address-aware `dial` or `connect` overload. If none is usable, that provider cannot be dialed through this path. A Mix request does not fall back to a Direct connection.

## The destination and relay pool are separate

MixTransport retains the parsed `MixPubInfo` for the session and supplies it to Mix's explicit-destination `send` overload. Mix selects intermediate relays from its pool, excluding the destination from that selection. It uses the explicit public information for the final hop without inserting the provider into the pool or temporarily changing peer-store addresses.

This is distinct from a recipient reusing an existing anonymous session. The recipient opens another stream using the session pseudonym and does not need a provider record identifying the initiator. [[Mix Transport Implementation Walk Through - Recipient-Originated Streams]] follows that path.

## Discovery results and content availability

A provider advertisement identifies a candidate for the CID, not its current per-block availability or reachability. BlockExchange obtains availability through presence messages and manages the download's swarm separately. Direct and Mix both use the default connected-peer selection policy unless a different policy is explicitly configured. Optional provider prioritization uses the latest matching discovery result, filtered to peers present in the selected transport's peer store; it is not an accumulated provider cache.

[[Mix Transport Logos Storage Integration - Download Transport Selection]] follows the provider record through both connection paths and explains the policy options. Record freshness, size and address-mapper limitations are tracked separately in [[Mix Transport Documentation Maintenance]].
