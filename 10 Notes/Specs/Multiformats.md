Multiformats is a set of self-describing protocol values. These values are foundational in that they are low-level building blocks for both data and network layers of the composable protocols making up IPFS, IPLD, libp2p, and many other decentralized data systems.

In the context of Codex, the most important multiformats are:

- [multiaddr](https://github.com/multiformats/multiaddr) - self-describing network addresses
- [multibase](https://github.com/multiformats/multibase) - self-describing base encodings
- [multicodec](https://github.com/multiformats/multicodec) - self-describing serialization
- [multihash](https://github.com/multiformats/multihash) - self-describing hashes

Codex specific multicodecs are currently defined in [nim-libp2p](https://github.com/vacp2p/nim-libp2p/blob/multihash-poseidon2/libp2p/multicodec.nim) - on the `multihash-poseidon2` branch (in Codex we currently use libp2p with commit id: `c08d80734`).

More information:
- [https://github.com/multiformats/multiformats](https://github.com/multiformats/multiformats)
- [https://multiformats.io/](https://multiformats.io/)
