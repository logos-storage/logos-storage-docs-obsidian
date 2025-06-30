---
related-to:
  - "[[Async Iterators can be unsafe in some circumstances]]"
---
We will be extracting our iterators: `Iter`, `AsyncIter`, and `AsyncResultIter` to a separate package. We will document it here, for now, we are communicating the process and related issues.

First check this Discord Discussion:
 - https://discord.com/channels/895609329053474826/1168926478180810903/1388143470945767587
 - and also here in the relation to https://github.com/status-im/nim-faststreams: https://discord.com/channels/895609329053474826/1168926478180810903/1388145112479170620

From those discussions:

- https://github.com/SirNickolas/asyncIters-Nim
- [asyncIters-Nim](https://github.com/SirNickolas/asyncIters-Nim)
- [Why isn’t `chronosInternalRetFuture` gensymmed?](https://github.com/status-im/nim-chronos/issues/368)
