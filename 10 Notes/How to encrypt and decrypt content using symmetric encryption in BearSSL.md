We show how to use symmetric encryption in BearSSL to encrypt and decrypt the content.
This is a very basic code demonstrating the use of the BearSSL symmetric encryption API. In [[Codex Encryption Design]] we show a more complete example. In the code below we also use [[BearSSL]] to generate a random number. See [[How to generate a random number using BearSSL]] for more details:

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