Here is an example, of how to use hashing in [[BearSSL]]:

```nim
import bearssl/hash
import stew/byteutils

let data = "0123456789abcdef".toBytes
let buff = newSeq[byte](sha256SIZE)

var sha256HashCtx = Sha256Context()
sha256Init(sha256HashCtx)
sha224Update(sha256HashCtx, addr data[0], data.len.uint)
sha256Out(sha256HashCtx, addr buff[0])

echo "Hash out: ", buff.toHex

```

>[!note]
> notice that above we use `sha224Update` and not the expected `sha256update`. This is because of a bug, which is addressed here: https://github.com/status-im/nim-bearssl/pull/68

BearSSL also simulates an [OOP interface](https://bearssl.org/oop.html), which can be used to create a generic `hash` function which can then be reused for various hashing algorithms:

```nim
import bearssl/hash

proc hash(hashClass: ptr HashClass, data: openArray[byte]): seq[byte] =
  var compatCtx = HashCompatContext()
  let buffSize = (hashClass[].desc shr HASHDESC_OUT_OFF) and HASHDESC_OUT_MASK
  result = newSeq[byte](buffSize)

  let hashClassPtrPtr: ConstPtrPtrHashClass = addr(compatCtx.vtable)

  hashClass[].init(hashClassPtrPtr)
  hashClass[].update(hashClassPtrPtr, addr data[0], data.len.uint)
  hashClass[].`out`(hashClassPtrPtr, addr result[0])
```

Then such a hash function can be conveniently reused for various hashing functions:

```nim
import stew/byteutils

let data = "0123456789abcdef".toBytes

var sha256HashCtx = Sha256Context()
sha256Init(sha256HashCtx)
echo "Hash out[sha256]: ", hash(sha256HashCtx.vtable, data).toHex

var sha1HashCtx = Sha1Context()
sha1Init(sha1HashCtx)
echo "Hash out[sha1]: ", hash(sha1HashCtx.vtable, data).toHex

var md5Ctx = Md5Context()
md5Init(md5Ctx)
echo "Hash out[md5]: ", hash(md5Ctx.vtable, data).toHex
```

