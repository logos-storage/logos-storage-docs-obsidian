# Mix Protocol API Changes for MixTransport

MixTransport turns independent Mix messages into sessions containing bidirectional, reliable streams. To do that, it needs to send transport frames, supply SURBs independently of individual application requests, and associate returning messages with its own sessions. The original Mix connection interface coupled these operations to a request/reply exchange.

The additions described here expose a message-oriented interface alongside that connection interface. Mix continues to select routes, build and process Sphinx packets, apply delays, and perform reply cryptography. MixTransport owns stream semantics and the lifetime of the reply credentials it creates.

For the complete round trip, see [[MixTransport to Mix Protocol Boundary Flow]]. The wire protocol is described in [[Mix Transport Design Specification]].

## Overview presentation

The title slide is embedded below. For the more detailed communication flow, use the presentation in [[MixTransport to Mix Protocol Boundary Flow]].

> This presentation is an Obsidian Excalidraw drawing. To view it, open this vault in Obsidian with the Excalidraw plugin installed and enabled.

![[Mix Protocol API Changes Overview.excalidraw#^frame=apiTitle2026]]

### Presenter guide

The overview follows six questions: why expose messages, how forward delivery works, who owns return-path material, how a destination is supplied, how a reply is recovered, and how the original interface coexists with the additions.

| Slide | Use the drawing to explain |
| --- | --- |
| Connections and messages | The legacy path associates reply credentials with a `MixEntryConnection` queue at A. At a local destination B, `MixExitConnection` buffers the handler's request and response, and `MixReplyConnection` sends the response using supplied SURBs. The added API lets the caller manage return capacity and message dispatch independently of those wrappers. |
| Forward delivery | Follow the payload from `send` to `MixDelivery`. The two-part message strip shows the service identifier followed by the service's bytes, before Mix padding. The relay drawing is schematic, not an additional packet-format definition. |
| Two owners | Follow the fork from one `createSurb` result. The ticket travels to B; the credential stays at A. The small return path shows the identifier selecting the matching credential. |
| Destination and route | The destination record supplies the final hop. The dashed links show intermediate relays selected from the pool. The solid route still traverses Mix: an explicit destination is not a direct network send. |
| Reverse delivery | B spends a SURB. A receives an identifier and encrypted payload, chooses its credential, and asks Mix to recover the original bytes. The callback owns credential storage; `recoverReply` does not remove a store entry. |
| Compatibility | Read forward and reverse dispatch separately. A registered forward service receives its payload; an unknown return identifier can fall back to Mix's legacy connection store. `Handled` is an ownership decision, not a wire acknowledgement. |

In the diagrams, `q` is a symbolic SURB reply identifier, not a supply sequence or session ID. A serialized SURB does not contain the caller's complete reply credential. A recognized return packet may be discarded as invalid or retired while still being claimed by MixTransport.

## 1. What the original interface provided

A caller used `toConnection` to obtain a `MixEntryConnection`, then used connection reads and writes. For an exchange expecting a reply:

1. A write supplied application bytes, an application codec, a destination, and parameters describing whether replies were expected.
2. Mix generated SURBs and retained their recovery material in its own store, associated with the connection's incoming queue.
3. Mix prepended its SURB envelope to the application message.
4. The exit either forwarded the request to another destination or ran a local protocol handler.
5. Reply recovery delivered the response to the connection's incoming queue.

This is useful for a single request/reply exchange. In particular, the reply-expecting `MixEntryConnection` permits one write; it is not the persistent multiplexed stream abstraction that MixTransport provides.

MixTransport needs a different lifetime: one session may carry many streams and many exchanges, and the recipient may open streams too. SURBs must therefore belong to the session's available return capacity, rather than to one connection write.

Source: [MixEntryConnection](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/entry_connection.nim).

## 2. Overview of the API changes

| Concern | Original arrangement | Interface available to MixTransport |
| --- | --- | --- |
| Forward sending | Connection write, with optional Mix-managed SURBs | `send(destination, service, payload)` |
| Forward receiving | Exit forwarding or a local connection-style handler | `registerMixDeliveryHandler(service, handler)` |
| Creating return capacity | SURBs generated as part of sending a request | `createSurb(destination)` returns a SURB and its separate credential |
| Transferring SURBs | Mix's SURB envelope around application bytes | `serializeSurb` / `deserializeSurb`; the caller chooses its enclosing format |
| Sending a return message | Exit-layer reply handling | `sendWithSurb(surb, payload)` |
| Receiving a return message | Mix looks up its connection-associated credentials | Raw-reply callback, then explicit `recoverReply` |
| Destination information | Destination resolved through the Mix node pool | Additional `send` overload accepts explicit `MixPubInfo` |
| Exit behavior | Local delivery depended on a compile-time flag | Local delivery and forwarding are selected at runtime |

The public facade exports these operations through `import libp2p_mix`. The snippets below show interface shape; explanatory snippets omit some Nim effect annotations.

Source: [public exports](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix.nim).

## 3. Separate the SURB from the reply credential

The original in-memory `SURB` combined the transferable reply block with an optional `secret` field containing return-path secrets. Those secrets were not part of the serialized SURB, but the type mixed two different ownership roles.

The new construction result separates them:

```nim
proc createSurb*(
    mixProto: MixProtocol, destination: MixDestination
): Result[tuple[surb: SURB, credential: ReplyCredential], string]
```

- **SURB:** sent to the recipient, who can use it once to send a message back.
- **ReplyCredential:** retained by the initiator, who needs it to recover that returning message.

The lower-level Sphinx `createSURB` likewise returns this pair. `ReplyCredential` holds its identifier, key, and path secrets behind private fields; `credential.identifier` exposes the lookup identifier. The transferable SURB still contains the key needed to construct the reply—it does not contain the entire reply credential.

`createSurb` selects a return path ending at the local Mix node. The intended recipient is excluded from the randomly selected return relays. The operation currently accepts only `MixDestination.exitNode(peerId)`; it rejects the forward-to-another-address mode. It does not send a packet or register the credential in Mix's legacy connection store.

MixTransport stores the credential itself, together with the session ID and an expiry time.

Sources: [credential and raw-reply types](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/sphinx.nim#L174), [createSurb](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L851).

### Serializing an individual SURB

```nim
proc serializeSurb*(surb: SURB): seq[byte]
proc deserializeSurb*(data: openArray[byte]): Result[SURB, string]
```

These encode and decode one SURB: first-hop information, Sphinx header, and reply key. In the current packet profile the encoding is exactly 734 bytes. It contains neither a MixTransport session ID nor a supply sequence number.

MixTransport places each encoded SURB in its own repeated Protobuf field. The transport frame supplies the session association and, where applicable, the supply numbering. This avoids requiring Mix to understand the transport's supply protocol.

Source: [SURB serialization](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/serialization.nim#L205).

## 4. Send one forward message

The basic message API is:

```nim
proc send*(
    mixProto: MixProtocol,
    destination: MixDestination,
    service: string,
    payload: sink seq[byte],
): Future[Result[void, string]]
```

For MixTransport, `service` is `/libp2p/mix-transport/1.0.0` and `payload` is one encoded transport frame.

This API requires a nonempty service and an exit that is also the destination. It creates no reply credentials and adds no legacy SURB envelope. Mix still adds its protocol-identifier framing and padding, constructs the Sphinx packet, and sends it through the normal packet path.

The destination-based overload resolves the destination from the node pool. A second overload accepts its information directly:

```nim
proc send*(
    mixProto: MixProtocol,
    destination: MixPubInfo,
    service: string,
    payload: sink seq[byte],
): Future[Result[void, string]]
```

Here, the supplied `MixPubInfo` provides the final hop's peer identity, address, and Mix public key. Other hops are selected from the relay pool, excluding that destination. The destination need not be inserted into the relay pool, and the caller need not temporarily rewrite peer-store addresses. This is particularly useful when discovery supplied a Mix address for an application peer.

This does not make the relay pool unnecessary: Mix still needs eligible intermediate relays, and SURB creation still uses the pool to construct return paths.

Source: [both send overloads](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L1081).

## 5. Deliver a forward message to a registered service

```nim
type
  MixDelivery* = object
    service*: string
    payload*: seq[byte]

  MixDeliveryHandler* =
    proc(delivery: MixDelivery): Future[void] {.
      async: (raises: [CancelledError])
    .}
```

`registerMixDeliveryHandler(service, handler)` installs a handler for one service. Duplicate registration, an empty service, and a nil handler return errors. `unregisterMixDeliveryHandler(service)` removes it.

At the final Mix hop, after Sphinx processing and Mix-message decoding, Mix checks for a registered handler when the exit is the destination. If found, it passes the service and the entire payload to that handler and returns. It does not try to extract the legacy SURB envelope first.

Consequently, MixTransport can decode its own frame and find SURBs inside it. The callback does not provide the application's sender identity: a preceding relay's identity would not identify the anonymous session initiator.

Sources: [registration](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L39), [final-hop dispatch](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L383).

## 6. Send one message using a SURB

```nim
proc sendWithSurb*(
    mixProto: MixProtocol,
    surb: sink SURB,
    payload: sink seq[byte],
): Future[Result[void, string]]
```

The caller supplies one SURB and the message bytes. Mix builds a message with an empty service identifier, constructs the reply packet using the SURB, and sends it to the SURB's first hop.

The caller must treat the SURB as consumed once this operation is invoked, even if it returns an error. It cannot safely retry using that same SURB. Redundant copies use different SURBs.

The API does not choose a redundancy level, allocate a stream sequence, or attach a supply snapshot. MixTransport does those things before calling it.

Source: [sendWithSurb](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L1133).

## 7. Receive and recover a raw SURB reply

At the initiator, Sphinx processing identifies a returning SURB packet, but its application payload still requires the matching reply credential.

```nim
type
  RawSurbReply* = object
    identifier*: SURBIdentifier
    encryptedPayload*: seq[byte]

  RawSurbReplyDisposition* {.pure.} = enum
    Unhandled
    Handled
```

`registerRawSurbReplyHandler(handler)` installs a callback returning `Future[RawSurbReplyDisposition]`. There is one such callback slot per MixProtocol instance, unlike the service-keyed table for forward delivery. Duplicate registration is an error.

- `Handled`: the callback owns this reply; Mix must not try its legacy connection store.
- `Unhandled`: the identifier was not recognized by the callback; Mix may attempt legacy recovery.

Ownership does not mean successful decoding. A recognized but malformed transport reply is still handled, because it must not be offered to an unrelated connection.

The caller performs recovery with:

```nim
proc recoverReply*(
    credential: ReplyCredential, reply: RawSurbReply
): Result[seq[byte], ReplyRecoveryError]
```

Recovery checks the identifier, performs Sphinx reply recovery, removes padding, decodes the Mix message, and requires an empty service identifier. The result is the original payload bytes. Errors distinguish `SphinxRecoveryFailed` from `PayloadDecodingFailed`.

The function does not own a credential store or consume entries in one. MixTransport decides which credential to look up, when to retire it, and whether the recovered frame belongs to the associated session.

Sources: [raw-reply dispatch and legacy fallback](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L421), [recovery](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim#L256), [transport credential store](https://github.com/logos-storage/libp2p-mix-transport/blob/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport/reply_credentials.nim).

## 8. Existing consumers and runtime exit behavior

The existing `toConnection`, `MixEntryConnection`, legacy SURB envelope, and connection-associated reply store remain available. Forward messages without a matching local service handler follow the legacy exit path; unclaimed raw replies fall back to the legacy credential store.

The `libp2p_mix_experimental_exit_is_dest` compile-time choice was removed. Destination constructors now express the choice at runtime:

```nim
MixDestination.exitNode(peerId)
MixDestination.forwardToAddr(peerId, address)
```

Local exit delivery and forwarding to a separate destination can coexist in one build. The new message API uses the first mode; the legacy path retains both. This preserves the connection-oriented use case, although code directly using the old internal SURB fields or Sphinx constructor return type must adapt to the new types.

`setLocalMultiAddr`, `localMixPubInfo`, the delay strategies, and the node pool are relevant to integration but are not API additions introduced by this transport extension. In particular, `setLocalMultiAddr` already existed before the comparison baseline.

Source: [runtime exit dispatch](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/exit_layer.nim#L157).

## 9. Reference versions

This comparison uses Mix before the transport API series, commit `e7b0c4e6a026b2aa1144fd7945464502d82632da`, and the local `feat/mix-transport` revision `0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0`. “Original” means that baseline, not whichever revision a moving master branch points to.

The consumer examples use MixTransport `feat/mix-transport` at `653bcd6d8c2a74b72b7207723938c643416670a0`. Links above are pinned to these revisions.
