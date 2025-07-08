We show how to use symmetric encryption in BearSSL to encrypt and decrypt the content.
This is a very basic code demonstrating the use of the BearSSL symmetric encryption API. In [[Codex Encryption Design]] we show a more complete example. In the code below we also use [[BearSSL]] to generate a random number. See [[How to generate a random number using BearSSL]] for more details:

```nim
import std/sequtils
import bearssl/blockx
import stew/byteutils

import ./rng

const
  KeySize = 24 # 192 bits for AES-192
  IvSize = 16  # fixed - 128 bits - notice that the length og the content to be 
               # encrypted/decrypted must be multiply of 16

var plaintext = "0123456789abcdef".toBytes
echo "plaintext: ", plaintext.toHex

let key = newSeqWith(KeySize, Rng.instance.rand(uint8.high).byte)
let ive = newSeqWith(IvSize, Rng.instance.rand(uint8.high).byte)
let ivd = ive

echo "ive: ", ive.toHex

var encCtx: AesBigCbcencKeys
aesBigCbcencInit(encCtx, addr key[0], 16.uint)
aesBigCbcencRun(encCtx, addr ive[0], addr plaintext[0], plaintext.len.uint)
echo "Encrypted: ", plaintext.toHex

echo "ivd: ", ivd.toHex

var decCtx: AesBigCbcdecKeys
aesBigCbcdecInit(decCtx, addr key[0], 16.uint)
aesBigCbcdecRun(decCtx, addr ivd[0], addr plaintext[0], plaintext.len.uint)
echo "Decrypted: ", plaintext.toHex
```

As stated in the comment, the following note must be emphasized:

>[!note]
>The size of the `IV` vector must be $16$ bytes long. The data to be encrypted or decrypted must have length that is multiple of $16$

Also important to notice is that `aesBigCbcencRun` will mutate the provided initialization vector `IV` so that it is ready to be used for the subsequent chunk of data - a classical CBC mode for AES.