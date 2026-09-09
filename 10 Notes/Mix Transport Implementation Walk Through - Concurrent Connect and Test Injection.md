---
related:
  - "[[Mix Transport Implementation Walk Through]]"
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through - Connect Handshake]]"
  - "[[Mix Transport Implementation Walk Through - Stream Establishment Round Trip]]"
---

This phase separates two concerns that had previously been implemented through generic procedures and inheritance inside `transport.nim`. Concurrent calls to `MixTransport.connect` are now coordinated by a transport-owned `ConnectAttemptCoordinator`, while the delayed-acknowledgement test modifies one private send operation through composition. Neither mechanism changes the MixTransport wire protocol.

The connection-attempt coordinator is implemented in `libp2p_mix_transport/connect_attempts.nim`. `MixTransport` integrates the coordinator in `libp2p_mix_transport/transport.nim`. The isolated coordinator tests and the real delayed-acknowledgement exchange are in `tests/test_connect.nim`.

## Why Concurrent Connect Calls Share One Attempt

Two application tasks can call `connect` for the same destination before either call receives `ConnectAck`. Sending a separate `Connect` handshake from each task would create two session pseudonyms for one destination and make the result depend on which handshake completes first.

MixTransport instead treats those calls as waiters for one transport-owned attempt. The first call starts `connectInternal(destination)`. A later call for the same destination waits for the same result. When the attempt succeeds, every waiting caller receives the same `TransportSession`.

The attempt must not be owned by the first caller. If caller A starts the handshake and caller B joins it, cancelling caller A must remove only A's interest. Caller B must continue waiting while the transport-owned handshake proceeds.

## The Coordinator Interface

`connect_attempts.nim` defines the operation supplied by the owner, the existing-connection lookup and the coordinator itself:

```nim
type
  ConnectOperation*[K, T] = proc(
    key: K
  ): Future[Result[T, string]].Raising([CancelledError]) {.gcsafe, raises: [].}

  ExistingConnectionLookup*[K, T] = proc(key: K): Opt[T] {.gcsafe, raises: [].}

  ConnectAttemptCoordinator*[K, T] = ref object
    lock: AsyncLock
    attempts: Table[K, ConnectAttempt[T]]
```

`K` is the value that identifies equivalent requests. MixTransport uses a destination `PeerId` as `K`, because calls for the same destination must share an attempt. `T` is the successful result, which is a `TransportSession` in MixTransport.

The coordinator exposes the following operation:

```nim
proc connect*[K, T](
    coordinator: ConnectAttemptCoordinator[K, T],
    key: K,
    operation: ConnectOperation[K, T],
    getExisting: ExistingConnectionLookup[K, T],
): Future[Result[tuple[connection: T, existing: bool], string]] {.
    async: (raises: [CancelledError])
.}
```

The result contains the connection and an `existing` flag. The flag is `true` when `getExisting` returned an already established connection or when the caller joined an attempt that another caller had started. MixTransport uses the flag to ensure that the established-session event has been published; event publication remains idempotent for a session that was already announced.

## How MixTransport Adapts Its Operations

The public `MixTransport.connect` procedure creates two closures with the coordinator's narrow signatures:

```nim
let operation: ConnectOperation[PeerId, TransportSession] = proc(
    destination: PeerId
): Future[Result[TransportSession, string]] {.
    async: (raw: true, raises: [CancelledError])
.} =
  self.connectInternal(destination)

let getExisting: ExistingConnectionLookup[PeerId, TransportSession] = proc(
    destination: PeerId
): Opt[TransportSession] {.gcsafe, raises: [].} =
  self.sessions.getByDestination(destination).withValue(existing):
    if existing.state == SessionState.Established:
      return Opt.some(existing)
  return Opt.none(TransportSession)
```

The first closure delegates to the complete `Connect`/`ConnectAck` handshake. The second closure queries the destination index in `SessionStore` and returns only an established session. A pending session is represented by the active coordinator attempt, not by the existing-session result.

`MixTransport.connect` then delegates coordination without exposing the coordinator to transport users:

```nim
let (session, existing) = (
  await self.connectAttempts.connect(destination, operation, getExisting)
).valueOr:
  return err(error)
```

`MixTransport` owns the coordinator as part of its long-lived state:

```nim
MixTransport* = ref object
  mix: MixProtocol
  # ...
  connectAttempts: ConnectAttemptCoordinator[PeerId, TransportSession]
```

The coordinator is created by `newMixTransport` and stopped by `MixTransport.stop`. This ownership makes the handshake lifetime independent from any individual caller while still allowing transport shutdown to terminate all outstanding handshakes.

## Creating or Joining an Attempt

`ConnectAttemptCoordinator.connect` acquires its lock before checking the existing connection and the active-attempt table. The lock is necessary because both checks are separated from later state changes by asynchronous operations. Cooperative scheduling prevents interruption between ordinary statements, but each `await` permits another caller to run.

If `getExisting(key)` returns a connection, the coordinator releases the lock and returns immediately. Otherwise, the coordinator looks for an attempt under the same key.

An existing, active attempt gains another waiter:

```nim
attempt = coordinator.attempts[key]
existingAttempt = true
if not attempt.cancelling:
  inc attempt.waiterCount
```

If no attempt exists, the coordinator creates one with a single waiter, records it before starting asynchronous work and stores the worker future:

```nim
attempt = ConnectAttempt[T](
  outcome: Future[Result[T, string]].Raising([]).init(
    "connect-attempt.outcome", {FutureFlag.OwnCancelSchedule}
  ),
  waiterCount: 1,
)
coordinator.attempts[key] = attempt
attempt.task = coordinator.runAttempt(key, attempt, operation)
```

Recording the attempt before starting the worker ensures that another `connect` call cannot start a second operation for the same key.

## Separating the Worker from Its Waiters

Each attempt contains two futures with different responsibilities:

```nim
ConnectAttempt[T] = ref object
  outcome: Future[Result[T, string]].Raising([])
  task: Future[void].Raising([CancelledError])
  waiterCount: int
  cancelling: bool
  cancellationReason: string
  retryAfterCancellation: bool
```

`task` is the transport-owned worker running `ConnectOperation`. `outcome` is a manually completed future observed by callers. A caller waits through `join`:

```nim
await attempt.outcome.join()
outcome = attempt.outcome.read()
```

`join` creates a wait operation without transferring ownership of `attempt.outcome` to the caller. Cancelling the caller cancels that caller's wait, but does not cancel the shared outcome or the worker task. The `finally` block still removes the caller from the waiter count:

```nim
finally:
  await noCancel coordinator.releaseWaiter(key, attempt)
```

`noCancel` ensures that waiter bookkeeping completes even though the surrounding `connect` future is already being cancelled.

## Cancelling the Worker When Nobody Is Waiting

The coordinator keeps the operation alive while at least one caller is interested. When `releaseWaiter` removes the final waiter from an unfinished attempt, the coordinator schedules cancellation of the worker:

```nim
if attempt.waiterCount == 0 and not attempt.outcome.finished and
    not attempt.cancelling:
  attempt.cancelling = true
  attempt.cancellationReason = "connection attempt has no remaining callers"
  attempt.retryAfterCancellation = true
  attempt.task.cancelSoon()
```

`cancelSoon` schedules cancellation without waiting while the coordinator lock is held. Waiting for task completion inside the locked section would deadlock because the worker finishes by acquiring the same lock to remove itself from the table and complete `outcome`.

A new caller can arrive after the final waiter has requested cancellation but before the worker has finished unwinding. The new caller does not join a worker that is already terminating. It waits for that attempt's outcome, observes `retryAfterCancellation`, returns to the top of the loop and starts a fresh attempt after the previous entry has been removed.

## Completing the Shared Outcome

`runAttempt` converts the operation's completion into one shared `Result`:

```nim
proc runAttempt[K, T](
    coordinator: ConnectAttemptCoordinator[K, T],
    key: K,
    attempt: ConnectAttempt[T],
    operation: ConnectOperation[K, T],
): Future[void] {.async: (raises: [CancelledError]).} =
```

A normal success or failure is copied into `outcome`. A `CatchableError` becomes an error result so every waiter observes the same failure message. When the worker receives `CancelledError`, the coordinator uses the recorded cancellation reason, completes the shared outcome and then re-raises cancellation from the worker task.

`finishAttempt` removes the table entry and completes the outcome while holding the coordinator lock. Performing both state changes together prevents a new caller from seeing neither a reusable connection nor the attempt whose result is about to be published.

## Transport Shutdown

`MixTransport.stop` calls:

```nim
await self.connectAttempts.cancelAll(
  "MixTransport stopped during connection attempt"
)
```

`cancelAll` marks every active attempt as a shutdown cancellation, sets `retryAfterCancellation` to `false`, schedules cancellation of every worker and then waits for all workers outside the lock. Each waiting caller receives the shutdown reason as an error result. A caller that encounters one of these cancelling attempts receives the shutdown error instead of retrying that attempt.

## Isolated Coordinator Tests

The test-only `Synchronizer` supplies a small existing-connection table and an `AsyncEvent` that holds the operation open:

```nim
type Synchronizer = ref object
  connectAttempts: ConnectAttemptCoordinator[string, Session]
  sessions: Table[string, Session]
  gate: AsyncEvent
  operationCancelled: AsyncEvent
```

Holding the operation at `gate.wait()` allows the test to start several callers before completing the attempt. The tests verify that one caller creates one connection, an existing connection is returned without another operation, concurrent callers receive the first caller's result, cancelling one of two callers leaves the worker alive, cancelling the only caller reaches the worker, shutdown gives all callers the shutdown reason and a failed attempt does not prevent a later retry.

The tests use `activeAttemptCount` to inspect only the coordinator's externally meaningful state. They do not reach into a private `ConnectAttempt` to inspect its worker future or waiter count.

## Why the Delayed-Acknowledgement Test Needs a Send Seam

`ConnectAck` and `StreamAck` are each submitted through a temporary redundancy batch. The recipient awaits each single-SURB send in sequence. The first acknowledgement copy can therefore reach the initiator before the recipient has submitted the second copy.

The initiator may send the next frame as soon as the first valid acknowledgement arrives. The recipient must establish and configure its session or stream before sending the first acknowledgement copy. The standalone harness exposed this ordering requirement under realistic timing, and `tests/test_connect.nim` preserves it by delaying the recipient between acknowledgement copies.

The test needs control over the timing of one SURB send. The test does not need to replace redundancy selection, success aggregation or error handling.

## The Private Single-SURB Sender

`transport.nim` defines a private callback type:

```nim
type SurbSender = proc(
  surb: sink SURB, payload: sink seq[byte]
): Future[Result[void, string]].Raising([CancelledError]) {.gcsafe, raises: [].}
```

`newMixTransport` installs the production implementation, which delegates directly to the injected `MixProtocol`:

```nim
let surbSender: SurbSender = proc(
    surb: sink SURB, payload: sink seq[byte]
): Future[Result[void, string]] {.
    async: (raw: true, raises: [CancelledError])
.} =
  mix.sendWithSurb(move(surb), move(payload))
```

The callback and the `surbSender` field are private implementation details. They are not constructor parameters and do not become a public extension API.

`sendWithSurbRedundancyBatch` remains an ordinary, non-virtual transport procedure:

```nim
proc sendWithSurbRedundancyBatch(
    self: MixTransport, surbs: sink seq[SURB], payload: sink seq[byte]
): Future[Result[void, string]] {.async: (raises: [CancelledError]).} =
  var sent = false
  for surb in surbs.mitems:
    traceOutbound(surb, payload)
    if (await self.surbSender(move(surb), payload)).isOk:
      sent = true

  if not sent:
    return err("could not send through any SURB in the redundancy batch")
  ok()
```

The procedure consumes every SURB exactly once and reports success when at least one copy was submitted successfully. The procedure passes `payload` without `move` because every SURB needs the same encoded frame. Nim therefore provides a separate payload value to each `sink` callback invocation while the loop retains the original value for subsequent iterations.

## Delaying ACK Copies Without Inheritance

The test imports private transport state through `std/importutils` and replaces the recipient's `surbSender` with a wrapper. The wrapper first captures the production callback:

```nim
proc delayAcknowledgementCopies(transport: MixTransport, interAckDelay: Duration) =
  let originalSurbSender = transport.surbSender
  transport.surbSender = proc(
      surb: sink SURB, payload: sink seq[byte]
  ): Future[Result[void, string]] {.async: (raises: [CancelledError]).} =
```

For each invocation, the wrapper decodes the frame only to decide whether the frame is `ConnectAck` or `StreamAck`. The wrapper delegates the actual send to the captured production callback and delays completion after an acknowledgement copy:

```nim
let
  frame = MixTransportFrame.decode(payload).get()
  isAcknowledgement =
    frame.kind == FrameKind.ConnectAck or frame.kind == FrameKind.StreamAck
  sendResult = await originalSurbSender(move(surb), move(payload))

if isAcknowledgement:
  await sleepAsync(interAckDelay)

sendResult
```

Because `sendWithSurbRedundancyBatch` awaits the callback before processing the next SURB, the delay after the first copy becomes a delay before the second copy. The first copy can traverse the Mix network and trigger the initiator's next action during that interval. Non-acknowledgement frames use the original sender without an artificial delay.

This composition-based seam keeps the tested production behavior intact. The test can alter timing at the external send boundary, but it cannot accidentally replace the transport's redundancy loop. `MixTransport` no longer inherits from `RootObj`, and no virtual method exists solely to support the test.

## End-to-End Ordering Assertion

The test named `data packets are not rejected if ACK arrives too fast` calls the normal five-node `establishSessionAndStream` helper with a two-second inter-copy delay. The helper runs real MixProtocol routing, SURB reply recovery, session establishment, stream establishment and application Data exchange.

The delay gives the first `StreamAck` copy enough time to reach the initiator and lets the initiator send Data while the recipient is still inside its redundancy loop. The test succeeds only because `handleOpenStream` configures and establishes the recipient stream before calling `sendStreamResponse`. If the old ordering returns, the early Data frame reaches a pending or unconfigured stream and the exchange fails.

The seam therefore preserves the failure mode discovered by the standalone harness while keeping production architecture independent from test inheritance.
