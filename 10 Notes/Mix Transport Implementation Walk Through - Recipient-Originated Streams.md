---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through - Stream Establishment Round Trip]]"
  - "[[Mix Transport Logos Storage Integration Plan]]"
---
# Recipient-originated streams

A MixTransport session has two roles. The session initiator knows the destination's real peer ID and establishes the anonymous session. The session recipient knows the initiator only through the session's anonymous peer ID. Those roles determine how packets travel, but either endpoint can open a stream once the session is established.

This capability is implemented in `libp2p_mix_transport/transport.nim`. It does not let the recipient establish a new anonymous session back to the initiator. If the existing session disappears, its anonymous identity supplies no address or public keys with which to reconnect.

## 1. Find the existing session

An application on the recipient can use the peer ID from an incoming connection or the session-established event:

```nim
let session = (await transport.connect(anonymousPeerId)).expect("session unavailable")
let stream = (await transport.dial(anonymousPeerId, codec)).expect("stream rejected")
await stream.writeLp(message)
```

The endpoint accepting the new stream must have the requested protocol mounted. Replying on an existing stream does not require this new protocol-dispatch step.

Both public `connect` overloads use the following lookup before starting a connection attempt:

```nim
proc getExisting(
    self: MixTransport, destination: PeerId
): Opt[TransportSession] {.nimcall, gcsafe.} =
  self.sessions.get(destination).withValue(existing):
    if existing.role == SessionRole.Recipient and
        existing.state == SessionState.Established:
      return Opt.some(existing)
  self.sessions.getByDestination(destination).withValue(existing):
    if existing.state == SessionState.Established:
      return Opt.some(existing)
  return Opt.none(TransportSession)
```

The first lookup finds a recipient session by its anonymous session ID. The second preserves the original lookup by real destination ID for initiator sessions. Only established sessions are reused. Callers using an anonymous peer identity need no addresses; the address-taking overload retains its validation of explicitly supplied addresses.

## 2. Register and send the opening request

The public stream-opening operation is:

```nim
proc dial*(
    self: MixTransport, destination: PeerId, addrs: seq[MultiAddress], codec: string
): Future[Result[TransportStream, string]] {.async: (raises: [CancelledError]).}
```

After obtaining the session, `dial` registers an outbound stream and calls `sendOpenStream`. The session initiator allocates odd IDs; the session recipient allocates even IDs. The other endpoint uses the same ID, so there are not two identifiers for one stream.

The submission helper selects the packet path from the session role:

```nim
proc sendOpenStream(
    self: MixTransport, session: TransportSession, stream: TransportStream
): Future[Result[void, string]] {.async: (raises: [CancelledError]).}
```

For an initiator session, the helper preserves the existing forward request: create reply SURBs, attach them and any bootstrap supply to `OpenStream`, and send to the real destination.

For a recipient session, the helper passes `OpenStream` to `sendStreamFrame`. That operation waits for the session's SURB supply, takes a redundancy batch, attaches the updated supply snapshot, and sends the request through those SURBs. The request contains no attached SURBs: its acknowledgement will travel along the forward path.

Wire validation therefore accepts either no attached SURBs or a complete reply batch, up to the existing limit. Session-aware validation in `handleOpenStream` requires the form appropriate to the receiving endpoint. The new reverse form requires an updated peer; older implementations reject it.

## 3. Accept the stream at either endpoint

Opening requests recovered from SURB replies now reach the same handler as forward requests:

```nim
proc handleOpenStream(
    self: MixTransport, frame: MixTransportFrame
): Future[void] {.async: (raises: [CancelledError]).}
```

The handler first checks the established session and the direction-appropriate SURB form. Then, before any await or protocol lookup, the handler asks the session to record this opening attempt:

```nim
proc acceptInboundStreamOpening*(
    session: TransportSession, streamId: StreamId
): bool
```

This operation is defined in `sessions.nim` and is used for openings received through either packet path. A true result means the ID has valid remote parity and has not been processed within the retained window. A false result causes `handleOpenStream` to log and drop the request. Recording happens before deciding whether the requested protocol is supported, so rejected attempts are remembered too.

The history belongs to the session, not to an individual stream. Closing or removing a stream therefore cannot make its opening request acceptable again. Individual SURB credentials recover independently; this history prevents two successfully recovered copies from invoking the application twice.

### How the bounded history works

`InboundOpeningWindow` is currently 1,024 remote stream allocation positions. Because the remote endpoint allocates either odd or even IDs, `(streamId - 1) div 2` maps both progressions to positions 0, 1, 2, and so on. The window is not a limit on the number of active streams.

Each session keeps a lower bound named `inboundOpeningBase` and a 128-byte circular bitmap named `inboundOpeningBitmap`. Each set bit records one processed opening. When an opening arrives:

1. Invalid parity or a non-established session is rejected without changing the history.
2. A position below the lower bound is dropped, even if that position was never received.
3. A position beyond the current window moves the window just far enough to include it. Bits for positions leaving the window are cleared before their slots are reused.
4. A set bit identifies a duplicate. Otherwise the bit is set and processing continues.

The position maps to a bitmap slot using modulo 1,024. A jump of an entire window or more clears all slots; processing a jump never requires walking every skipped stream ID.

For example, after position 1,024 arrives, the retained window covers positions 1 through 1,024. An unseen position 10 can still be processed, but position 0 is now too old. Consequently, a genuinely new opening delayed behind 1,024 newer allocation positions is dropped and its caller may time out. This is the explicit reordering bound that keeps history storage fixed for long-lived sessions.

The history is not an acknowledgement cache. Duplicate openings are dropped, not answered with a cached outcome. Adding opening-handshake retries later will also require retaining or reconstructing the previous response.

For a new stream, the handler finds the mounted protocol, reserves an incoming protocol slot, and registers the inbound stream. The protocol limit is charged against the peer identity exposed at that endpoint: the real destination on the session initiator, or the anonymous identity on the session recipient.

Before sending a positive acknowledgement, the handler configures and establishes the stream. This lets the opener send Data immediately after receiving the acknowledgement. After successful submission, the accepting endpoint starts the protocol handler as a separate stream-owned task. The packet handler does not wait for the application's read loop to finish.

## 4. Return the acknowledgement on the opposite path

The shared response helper is:

```nim
proc sendStreamResponse(
    self: MixTransport,
    session: TransportSession,
    replyBatch: sink seq[SURB],
    streamId: StreamId,
    kind: FrameKind,
    rejectionReason = "",
): Future[bool] {.async: (raises: [CancelledError]).}
```

When the session recipient accepts a forward opening request, the response uses the attached reply SURBs, as before. When the session initiator accepts a reverse opening request, the response is sent to the known destination through the forward path. Both acceptance and rejection follow this rule.

Forward delivery now dispatches `StreamAck` and `StreamReject` to the existing response handler. That handler resolves only a pending outbound stream. Rejection carries the same bounded reason in either direction.

## 5. Resolution, cancellation, and application behavior

Both directions return through the same remaining `dial` code. After request submission, `dial` waits for acknowledgement or rejection with `streamOpenTimeout`. Successful acceptance configures the local stream and returns it; failure or cancellation removes and shuts down the locally registered stream. Cancellation is not swallowed. As with the existing path, a lost opening acknowledgement is not retried by this increment.

A recipient waiting for SURBs is waiting within request submission, before that acknowledgement timeout starts. Session shutdown wakes the supply wait; caller cancellation also interrupts it. This increment does not introduce a separate deadline for obtaining SURBs.

Every returned stream remains bidirectional. An application can retain an existing incoming stream for replies or dial another stream in the same session. The transport no longer forces the first choice solely because the application runs at the session recipient.

## Verification and integration boundary

The full local suite passed: 85 tests, compiled with usage style checks. Seven focused session-history tests cover removal, rejected attempts, in-window reordering, window advancement, large jumps, maximum IDs, and invalid parity. Each runs for both session roles. These checks do not replace loss/reordering stress experiments.

The real-network regression in `tests/test_connect.nim` establishes one session, reuses it through the recipient's anonymous peer identity, opens two even-numbered streams, exchanges length-prefixed bytes in both directions, and checks unsupported-protocol rejection. Existing tests continue to cover initiator-originated opening and delayed acknowledgements.

The transport increment was pushed as `edd2423`. A subsequent Storage integration update now pins that revision and removes the incoming-stream reuse workaround. BlockExchange uses recipient-side dialing for its normal retained sending connection; real-network checks cover presence delivery, connection reuse, and replacement within the same session. See [[Mix Transport Logos Storage Integration - Download Transport Selection]]. These Storage changes are a separate, uncommitted increment.
