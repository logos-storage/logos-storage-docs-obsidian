Having a Nim sequence:

```nim
var buff = newSeq[byte](buffSize)
```

if you want to get a pointer to the underlying data buffer that is suitable for being passed to a C library, you can simply use:

```nim
sha256Update(ctx, addr buff[0], input[i].len.uint)
```

If your input is a `string`, you can use the following:

```nim
let str = "abcdefghijklmnopqrstuvwxyz"
sha256Update(ctx, str.cstring, input[i].len.uint)
```

Here we use `sha256Update` from [[BearSSL]] library. See [[BearSSL hashing]] for more complete examples.
See also [Accessing seq pointer](https://forum.nim-lang.org/t/1489) and [Use cstring for C binding](https://forum.nim-lang.org/t/8179) on Nim forum.
