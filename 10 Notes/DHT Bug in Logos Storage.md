This code in `vendor/logos-storage-nim-dht/codexdht/private/eth/p2p/discoveryv5/spr.nim`

```nim
proc ip*(r: SignedPeerRecord): Option[array[4, byte]] =
    for address in r.data.addresses:
      let ma = address.address
      let code = ma[0].get.protoCode()
      if code.isOk and code.get == multiCodec("ip4"):
        var ipbuf: array[4, byte]
        let res = ma[0].get.protoArgument(ipbuf)
        if res.isOk:
          return some(ipbuf)

#         err("Incorrect IPv4 address")
#       else:
#         if (?(?ma[1]).protoArgument(pbuf)) == 0:
#           err("Incorrect port number")
#         else:
#           res.port = Port(fromBytesBE(uint16, pbuf))
#           ok(res)
#     else:

#   else:
#     err("MultiAddress must be wire address (tcp, udp or unix)")

proc udp*(r: SignedPeerRecord): Option[int] =
  for address in r.data.addresses:
    let ma = address.address

    let code = ma[1].get.protoCode()
    if code.isOk and code.get == multiCodec("udp"):
      var pbuf: array[2, byte]
      let res = ma[1].get.protoArgument(pbuf)
      if res.isOk:
        let p = fromBytesBE(uint16, pbuf)
        return some(p.int)
```

```nim
proc ip*(r: SignedPeerRecord): Option[array[4, byte]] =
    for address in r.data.addresses:
      let ma = address.address
      let code = ma[0].get.protoCode()
      if code.isOk and code.get == multiCodec("ip4"):
        var ipbuf: array[4, byte]
        let res = ma[0].get.protoArgument(ipbuf)
        if res.isOk:
          return some(ipbuf)

proc udp*(r: SignedPeerRecord): Option[int] =
  for address in r.data.addresses:
    let ma = address.address

    let code = ma[1].get.protoCode()
    if code.isOk and code.get == multiCodec("udp"):
      var pbuf: array[2, byte]
      let res = ma[1].get.protoArgument(pbuf)
      if res.isOk:
        let p = fromBytesBE(uint16, pbuf)
        return some(p.int)
```