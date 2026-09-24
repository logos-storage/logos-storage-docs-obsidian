---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through - Reply Credential Store]]"
  - "[[libp2p MIX Architecture and API]]"
---

# Mix Transport - Pluggable Integration Model

## Two layers with separate responsibilities

MixProtocol provides anonymous packet routing, intentional delays, SURB creation and reply recovery. MixTransport adds sessions and multiplexed application streams to that packet service. It owns the transport frame codec, sequence numbers, flow control, private reply credentials and received public SURBs. [[Mix Transport Design Specification]] defines the resulting protocol.

MixProtocol also supports its embedded connection and reply machinery, used by callers such as the legacy DHT proxy. Registering MixTransport does not replace those APIs. Dispatch selects the consumer by service codec for forward deliveries and by reply ownership for SURB replies.

## Registering forward delivery

`MixTransport.start` registers a `MixDeliveryHandler` for `/libp2p/mix-transport/1.0.0`. When that service arrives at the destination Mix node, Mix invokes the registered handler with the opaque payload. MixTransport decodes its envelope and routes it by session and stream IDs. A service without such a registration uses Mix's embedded destination handling.

The destination is the final Mix node, not an external peer reached through an exit connection. The transport does not ask Mix to interpret the application codec or perform an application-specific response read. `OpenStream` identifies the application protocol, and MixTransport invokes its mounted libp2p handler with a `TransportStream`.

## Selecting an explicit destination

The address-aware connection API decodes the provider's Mix multiaddress and retains its `MixPubInfo` for that session. Forward sends then supply that destination information directly to Mix:

```nim
proc sendToDestination(
    self: MixTransport, destination: PeerId, sessionId: PeerId, payload: sink seq[byte]
): Future[Result[void, string]] {.async: (raw: true, raises: [CancelledError]).} =
  self.addressDestinations.withValue(sessionId, info):
    return self.mix.send(info[], MixTransportCodec, move(payload))
  self.mix.send(MixDestination.exitNode(destination), MixTransportCodec, move(payload))
```

The first branch supplies the final hop independently of the relay pool. The second supports peer-ID-only callers whose destination is resolvable by Mix. Neither branch temporarily modifies libp2p peer-store addresses. Intermediate relays still come from the configured pool. [[Mix Discovery through Provider Records]] explains the advertised destination format.

## Creating and consuming reply paths

`createSurb` returns a public SURB and its private `ReplyCredential`. MixTransport retains the credential at the initiator and sends the public SURB to the recipient. The recipient calls `sendWithSurb` to send one reverse copy. At the initiator, `recoverReply` uses the matching private credential to recover the opaque transport frame.

These operations do not create a persistent redundancy group. MixTransport chooses individual public SURBs for each reverse frame and tracks their private credentials independently. The registered raw-reply callback runs before Mix's embedded credential lookup and returns a `RawSurbReplyDisposition`:

- `Handled`: the reply identifier belongs to an active or retained retired MixTransport credential. Even recovery failure for a recognized identifier stays within this path.
- `Unhandled`: the identifier is unknown to MixTransport, so Mix may try its embedded reply store.

The recovered frame must identify the session that owns the credential. A valid decryption alone does not authorize delivery to another session. [[Mix Transport Implementation Walk Through - Reply Credential Store]] follows this lookup, consumption and retirement process.

## Startup and shutdown boundary

The application starts the underlying Switch and MixProtocol and mounts its application protocols. It then constructs and starts MixTransport. Consumers that need session lifecycle events subscribe before the transport starts accepting sessions.

MixTransport shutdown cancels connection attempts, detaches sessions, attempts best-effort session reset notifications, unregisters its service and raw-reply handlers, and awaits session cleanup. It does not own the lifetime of the underlying Switch or MixProtocol; their owner stops them separately. Removing the callbacks leaves unrelated Mix consumers on their own dispatch paths.
