---
related-to:
  - "[[Multicodec]]"
---
Content Identifiers are central to the Codex protocol.

A CID is a self-describing content-addressed identifier. It uses cryptographic hashes to achieve content addressing. It uses several [[Multiformats|multiformats]] to achieve flexible self-description, namely:

1. [multihash](https://github.com/multiformats/multihash) to hash content addressed, and
2. [multicodec](https://github.com/multiformats/multicodec) to type that addressed content, to form a binary self-contained identifier, and optionally also
3. [multibase](https://github.com/multiformats/multibase) to encode that binary CID as a string.

Concretely:

```
<cidv1> ::= <CIDv1-multicodec><content-type-multicodec><content-multihash>
```

Source: https://github.com/multiformats/cid.
See also: [https://docs.ipfs.tech/concepts/content-addressing/#content-identifiers-cids](https://docs.ipfs.tech/concepts/content-addressing/#content-identifiers-cids).
