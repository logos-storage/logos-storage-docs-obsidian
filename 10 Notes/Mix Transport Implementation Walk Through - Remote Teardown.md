---
related:
  - "[[Mix Transport Implementation Walk Through]]"
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through - Wire Format Foundation]]"
  - "[[Mix Transport Implementation Walk Through - Bounded Data Flow]]"
---

# Mix Transport Implementation Walk Through - Remote Teardown

## 1. Stream and session teardown are separate operations

MixTransport multiplexes several application streams inside one anonymous session. Closing one `TransportStream` therefore removes only that stream. The session remains available for another `dial` call until one endpoint explicitly disconnects or resets the complete session.

The wire protocol distinguishes normal completion from an immediate abort at both levels:

| Frame | Meaning at the receiving endpoint |
| --- | --- |
| `CloseStream` | Stop one stream after all preceding Data from the sender has entered the ordered `BufferStream` |
| `ResetStream` | Abort one stream immediately |
| `Disconnect` | Remove an otherwise idle session after its streams have closed |
| `ResetSession` | Abort the session and every stream that remains inside it |

All four notifications are best effort. Local cleanup does not depend on the remote endpoint receiving the notification. A lost notification can therefore leave remote state alive until another reliability or liveness mechanism removes it; teardown-frame retransmission is not part of this increment.

## 2. A normal libp2p close emits `CloseStream`

Applications already close a virtual connection through the inherited libp2p API:

```nim
await stream.close()
```

`LPStream.close` marks the stream closed and dispatches once to the virtual `closeImpl` method. Calling `reset` follows the same pattern through `resetImpl`. `TransportStream` maps both virtual methods to `closeTransportStream`:

```nim
method closeImpl*(stream: TransportStream): Future[void] {.async: (raises: []).} =
  await stream.closeTransportStream(reset = false)

method resetImpl*(stream: TransportStream): Future[void] {.async: (raises: []).} =
  await stream.closeTransportStream(reset = true)
```

`closeTransportStream` first wakes local waiters, requests cancellation of the stream-owned tasks and closes the underlying `BufferStream`. The procedure then invokes the teardown callback installed by `MixTransport.configureStream` unless session shutdown or remote teardown has suppressed a reply notification:

```nim
proc closeTransportStream(
    stream: TransportStream, reset: bool
): Future[void] {.async: (raises: []).} =
  stream.dataAvailable.fire()
  stream.shouldSendAck.fire()
  stream.sendStateChanged.fire()
  stream.retransmissionStateChanged.fire()
  stream.resolved.fire()
  stream.streamTasks.cancelSoon()
  await procCall BufferStream(stream).closeImpl()

  if not stream.suppressRemoteTeardown and not stream.teardownHandler.isNil:
    await stream.teardownHandler(reset, stream.finalOutboundSequence)
  if not stream.handlerTask.isNil:
    stream.handlerTask.cancelSoon()
```

`configureStream` connects this stream-level lifecycle hook to the owning transport and session. A normal close creates `CloseStream`; a local reset creates `ResetStream`. After attempting the notification, the callback waits for the internal Data, ACK and retransmission tasks and removes the stream from the session:

```nim
let teardownHandler: StreamTeardownHandler = proc(
    reset: bool, finalSequence: SequenceNumber
): Future[void] {.async: (raises: []).} =
  let frame = MixTransportFrame(
    version: MixTransportVersion,
    sessionId: session.sessionId,
    kind: if reset: FrameKind.ResetStream else: FrameKind.CloseStream,
    streamId: Opt.some(stream.streamId),
    finalSequence:
      if reset: Opt.none(SequenceNumber) else: Opt.some(finalSequence),
  )
  discard await self.sendTeardownFrame(session, frame)
  await stream.cancelAndWaitForStreamTasks()
  discard session.removeStream(stream.streamId)
```

The application-facing `TransportStream` does not contain a `MixTransport` reference. The callback supplies the connection between stream mechanics and transport delivery while keeping the stream owned by its `TransportSession`.

## 3. Teardown never waits for new SURBs

`sendTeardownFrame` follows the same two physical directions as other transport frames. The session initiator submits the notification through the forward Mix path. The session recipient forms a redundancy batch from two SURBs already present in the session queue and sends the notification through the return path.

Unlike ordinary reverse Data or ACK transmission, recipient teardown does not call `waitForReplySurbs`. If two SURBs are unavailable, `sendTeardownFrame` returns `false` immediately and local closure continues. Waiting for replenishment solely to announce a stream that has already closed could prevent local shutdown indefinitely.

For a stream, the teardown callback intentionally discards this Boolean result. For the public graceful session operation, `disconnect` returns an error when the transport cannot even submit `Disconnect`; in that case the session remains registered and the caller may decide whether to retry or reset it.

## 4. `CloseStream` must not overtake preceding Data

Mix packets can arrive in a different order from the order in which they were submitted. Closing a receiving stream immediately when `CloseStream` arrives could therefore discard an earlier Data frame that is still travelling through the Mix path.

The sender solves this ordering problem by including `finalSequence`. Data sequence numbers begin at `1`, so a stream that sent no Data uses final sequence `0`:

```nim
func finalOutboundSequence*(stream: TransportStream): SequenceNumber =
  stream.nextOutboundSequence - 1
```

The receiver records the declared final sequence through `receiveRemoteClose`:

```nim
proc receiveRemoteClose*(
    stream: TransportStream, finalSequence: SequenceNumber
): Result[bool, string] =
  if stream.remoteCloseFinalSequence.isSome and
      stream.remoteCloseFinalSequence.get() != finalSequence:
    return err("remote close changed the final sequence")
  if finalSequence + 1 < stream.receiveBase:
    return err("remote close precedes already delivered Data")
  stream.remoteCloseFinalSequence = Opt.some(finalSequence)
  ok(stream.remoteCloseReady)
```

`receiveBase` is the next Data sequence that has not entered `BufferStream`. The following predicate becomes true only after the receiver has passed every sequence through `finalSequence` into that ordered buffer:

```nim
func remoteCloseReady*(stream: TransportStream): bool =
  stream.remoteCloseFinalSequence.isSome and
    stream.receiveBase > stream.remoteCloseFinalSequence.get()
```

If `CloseStream` arrives after all preceding Data, `handleTeardownFrame` closes the stream immediately. If a preceding sequence is missing, the handler records the final sequence and leaves the stream open. `runInboundDelivery` checks `remoteCloseReady` after each ordered payload has been pushed and the receive window has advanced:

```nim
stream.advanceReceiveWindow(inbound.sequence)
if stream.remoteCloseReady:
  await noCancel self.finishRemoteStream(session, stream)
  return
```

Once a final sequence has been declared, `receiveData` rejects Data with a greater sequence. A duplicated `CloseStream` with the same final sequence is harmless; a second close that changes the final sequence is invalid.

The final-sequence rule preserves order among packets that arrive. The current best-effort close notification does not wait for every pending Data sequence to be acknowledged, and teardown frames are not retransmitted. Complete graceful-close reliability across packet loss remains separate work.

## 5. `ResetStream` is immediate and remains distinguishable from EOF

`ResetStream` does not carry `finalSequence`. The receiver marks the stream as remotely reset, suppresses a reply teardown frame and closes the `BufferStream` immediately:

```nim
if frame.kind == FrameKind.ResetStream:
  stream.receiveRemoteReset()
  await noCancel self.finishRemoteStream(session, stream)
  return
```

`BufferStream` normally represents closure as end-of-file. Exposing a reset as ordinary EOF would prevent a protocol from distinguishing successful remote completion from an aborted stream. `TransportStream` therefore overrides the lowest-level virtual read operation:

```nim
method readOnce*(
    stream: TransportStream, pbytes: pointer, nbytes: int
): Future[int] {.async: (raises: [CancelledError, LPStreamError]).} =
  if stream.remoteReset:
    raise newLPStreamResetError()
  let bytesRead = await procCall BufferStream(stream).readOnce(pbytes, nbytes)
  if stream.remoteReset:
    raise newLPStreamResetError()
  bytesRead
```

The first check covers reads started after the reset. The second check covers a read that was already blocked in `BufferStream.readOnce` and was awakened when remote reset closed the buffer.

Only `readOnce` needs an override because the higher-level libp2p read API is built from that virtual operation. `readExactly` repeatedly calls `readOnce`; `readLine` calls `readExactly`; `readVarint` calls `readExactly`; and `readLp` uses `readVarint` for its prefix followed by `readExactly` for its payload. Direct `readOnce`, `readExactly`, `readLine` and `readLp` callers therefore all observe `LPStreamResetError` without duplicating reset checks in every method. A normal `CloseStream` leaves `remoteReset` false and continues to appear as EOF after the buffered bytes have been read.

## 6. Graceful session disconnect waits for streams to close

The public session operation is:

```nim
proc disconnect*(
    self: MixTransport, session: TransportSession
): Future[Result[void, string]] {.async: (raises: [CancelledError]).}
```

`disconnect` rejects a session that still contains streams. The caller closes those streams first, allowing each stream to communicate its final Data sequence. `disconnect` then submits `Disconnect`, removes the session and its reply credentials from the initiating transport, and shuts down the detached session resources.

`Disconnect` can overtake a preceding `CloseStream` on the remote endpoint. The receiver therefore records `remoteDisconnectRequested` when streams remain instead of destroying them. Both local stream cleanup and remote stream cleanup check this flag after removing a stream. The endpoint finishes the remote disconnect when the final registered stream has gone.

`TransportSession.waitUntilClosed` exposes the session's `closedEvent`. Tests and future integration code can wait for actual session teardown without polling:

```nim
proc waitUntilClosed*(
    session: TransportSession
): Future[void] {.async: (raw: true, raises: [CancelledError]).} =
  session.closedEvent.wait()
```

## 7. Session reset and transport shutdown abort remaining streams

`resetSession` sends `ResetSession` on a best-effort basis and then removes the local session regardless of the send result. On receipt, `TransportSession.receiveRemoteReset` marks every registered stream as remotely reset before session shutdown closes those streams. A blocked read on any affected stream consequently wakes with `LPStreamResetError` through the `readOnce` override.

`MixTransport.stop` detaches every session, attempts one `ResetSession` notification while the Mix delivery handlers are still registered, unregisters those handlers, and waits for local session shutdown. `TransportSession.shutdown` suppresses individual stream notifications because the session-level reset already represents the complete subtree. The transport clears reply credentials only after the session and stream shutdown operations have completed.

## 8. Tests cover the semantic boundaries

`tests/test_wire.nim` verifies that `CloseStream` survives a Protobuf round trip with `finalSequence`, and that the validator rejects both a missing final sequence and a final sequence attached to `ResetStream`.

`tests/test_streams.nim` delivers Data sequence `2` before sequence `1` after recording a remote final sequence of `2`. The test confirms that the close condition remains false until both payloads have advanced through the ordered receive path. A separate test blocks in `readOnce`, applies a remote reset and verifies that the pending read raises `LPStreamResetError`.

`tests/test_connect.nim` exercises graceful teardown through five live Mix nodes. After the request and response have crossed the virtual connection, the initiator closes its `TransportStream` and waits for the recipient's matching stream to close. The initiator then calls `disconnect` and waits for the recipient session's `closedEvent`. Both session stream tables are empty before the surrounding test fixture stops either transport.

The same test module also dispatches `ResetSession` through the registered Mix delivery handler. The test confirms that the recipient removes the session, closes its stream and wakes a blocked stream read with `LPStreamResetError`.
