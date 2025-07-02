Extracted from [nim-libp2p](https://github.com/vacp2p/nim-libp2p/blob/cfd631457ae865852d17ed77a9d4d3ea37710082/libp2p/crypto/crypto.nim#L161) (`libp2p/crypto/crypto.nim`) and `codex/rng.nim`  in [nim-codex](https://github.com/codex-storage/nim-codex) so that it does not depend on libp2p anymore:

```nim
{.push raises: [].}

import bearssl/[rand, hash]

proc newRng*(): ref HmacDrbgContext =
  # You should only create one instance of the RNG per application / library
  # Ref is used so that it can be shared between components
  # TODO consider moving to bearssl
  var seeder = prngSeederSystem(nil)
  if seeder == nil:
    return nil

  var rng = (ref HmacDrbgContext)()
  hmacDrbgInit(rng[], addr sha256Vtable, nil, 0)
  if seeder(addr rng.vtable) == 0:
    return nil
  rng

type
  RngSampleError = object of CatchableError
  Rng* = ref HmacDrbgContext

var rng {.threadvar.}: Rng

proc instance*(t: type Rng): Rng =
  if rng.isNil:
    rng = newRng()
  rng

# Random helpers: similar as in stdlib, but with HmacDrbgContext rng
# TODO: Move these somewhere else?
const randMax = 18_446_744_073_709_551_615'u64

proc rand*(rng: Rng, max: Natural): int =
  if max == 0:
    return 0

  while true:
    let x = rng[].generate(uint64)
    if x < randMax - (randMax mod (uint64(max) + 1'u64)): # against modulo bias
      return int(x mod (uint64(max) + 1'u64))
```
