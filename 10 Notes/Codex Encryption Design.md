---
related-to:
  - "[[Codex Encryption Basis]]"
  - "[[How to get a pointer to a seq to pass it to a C library]]"
---
As summarized in [[Codex Encryption Basis#^b2e265|the proposal]], we:

- use a freshly generated random master key (at least 256 bits) per dataset (generated and kept on the user's machine)
- derive a new encryption key and also an IV for each block from the master key and the block index
- use for example AES192-CBC

For example, we could have

    key = SHA256( MASTER_KEY || block_index ), truncated to 192 bits
    IV  = SHA256( MASTER_IV  || block_index ), truncated to 128 bits
    
where both `MASTER_KEY` and `MASTER_IV` are 256 bit random numbers, and `||` denotes concatenation.

If storing 512 bits (as opposed to a 256 bit minimum) of key material is a problem, we could derive both by the same key, for example as

    blockKEY = SHA256( MASTER_KEY || 0x01 || block_index ), truncated to 192 bits
    blockIV  = SHA256( MASTER_KEY || 0x02 || block_index ), truncated to 128 bits

In our implementation, we will be using the second scheme - starting with a random master key, and then for each block deriving a block level key (`blockKEY`) and block level initialization vector (`blockIV`).

For some introduction and examples on BearSSL, please consult:

- [[How to generate a random number using BearSSL]]
- [[How to create a hash using BearSSL]]
- [[How to encrypt and decrypt content using symmetric encryption in BearSSL]]

Before document design considerations for the content encryption in the Codex client, let's first see how to use BearSSL primitives to encrypt and decrypt some content:

```nim
import std/sequtils
import bearssl/blockx
import stew/byteutils

import ./rng

var plaintext = "0123456789abcdef".toBytes
echo "plaintext: ", plaintext.toHex

let key = newSeqWith(16, Rng.instance.rand(uint8.high).byte)
let ive = newSeqWith(16, Rng.instance.rand(uint8.high).byte)
let ivd = ive

echo "ive: ", ive.toHex

var encCtx: AesBigCbcencKeys
aesBigCbcencInit(encCtx, addr key[0], 16.uint)
aesBigCbcencRun(encCtx, addr ive[0], addr plaintext[0], 16.uint)
echo "Encrypted: ", plaintext.toHex

echo "ivd: ", ivd.toHex

var decCtx: AesBigCbcdecKeys
aesBigCbcdecInit(decCtx, addr key[0], 16.uint)
aesBigCbcdecRun(decCtx, addr ivd[0], addr plaintext[0], 16.uint)
echo "Decrypted: ", plaintext.toHex
```

Important to notice here is that `aesBigCbcencRun` will mutate the provided initialization vector `IV` so that it is ready to use for the subsequent chunk of data - a classical CBC mode for AES. Yet, for Codex, we use slightly modified scheme as already shown above.

For codex:

1. we first generate a `MASTER_KEY` - which will be returned to the user
2. from the `MASTER_KEY`, for each block, we derive the corresponding block level encryption key `blockKEY` and block level initialization vector `blockIV` as shown in the proposal above
3. using the derived `blockKEY` and `blockIV`, we then encrypt the block using the BearSSL encryption primitives as demonstrated above.

As we see above, the block index is used in the process of the key and initialization vector derivation. For this reason we also need to remember to convert the block index to a byte representation - we use big-endian ordering. For this conversion a very simple function can be used:

```nim
func toBytes[T: SomeInteger](value: T): seq[byte] =
  let v =
    if system.cpuEndian == bigEndian: value
    else: swapBytes(value)
  
  result = newSeq[byte](sizeof(T))
  copyMem(addr result[0], unsafeAddr v, sizeof(T))
```

or, we can just use the `endians2.toBytes` function from `nim-stew`: `toBytes(blockIndex.uint32, bigEndian)`

Below we show the code for the derivation of the block level key and initialization vector, followed by the encryption and decryption of a block:

```nim
import std/sequtils
import bearssl/[blockx, hash]
import stew/[byteutils, endians2]

import ./rng
import ./hash

let masterKey = newSeqWith(32, Rng.instance.rand(uint8.high).byte)

let blockIndex = 1.uint32  
let blockIndexArray = toBytes(blockIndex, bigEndian)

const KEY_SIZE = 24 # 192 bits for AES-192
const IV_SIZE = 16  # 128 bits
const DefaultBlockSize* = uint 1024 * 64 # as used in Codex

let keyForBlock = hash(addr sha256Vtable, masterKey & @[byte(0x01)] & blockIndexArray.toSeq)[0 ..< KEY_SIZE]
let ivForBlock = hash(addr sha256Vtable, masterKey & @[byte(0x02)] & blockIndexArray.toSeq)[0 ..< IV_SIZE]

var plaintext = newSeqWith(DefaultBlockSize.int, Rng.instance.rand(uint8.high).byte)

let key = keyForBlock
let ive = ivForBlock
let encBuffer = plaintext

# encryption
var encCtx: AesBigCbcencKeys
aesBigCbcencInit(encCtx, addr key[0], key.len.uint)
aesBigCbcencRun(encCtx, addr ive[0], addr encBuffer[0], ive.len.uint)

assert encBuffer != plaintext, "Encryption failed, output should differ from input!"

# decryption
let ivd = ivForBlock

var decCtx: AesBigCbcdecKeys
aesBigCbcdecInit(decCtx, addr key[0], key.len.uint)
aesBigCbcdecRun(decCtx, addr ivd[0], addr encBuffer[0], ivd.len.uint)

assert encBuffer == plaintext, "Decryption failed, output should match input!"
```

where `rng` and `hash` are defined as shown in [[How to generate a random number using BearSSL]] and [[How to create a hash using BearSSL]].

In a similar way we will proceed with other block.

More data to come.

### Links

- [bearssl](https://bearssl.org/)
- [bearssl Nim bindings](https://github.com/status-im/nim-bearssl)
- A nice example of using BearSSL encryption API (Arduino) https://github.com/kakopappa/esp8266-aes-cbc-encryption-decryption/blob/main/esp8266-aes-cbc-encryption-decryption.ino