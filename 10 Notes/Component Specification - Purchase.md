# Purchase module specification

## 1. Purpose and Scope

The Purchase module manages the lifecycle of a storage agreement between a client and a host in Codex. Its main responsibilities are to:

* Create new purchases from a `StorageRequest`.
* Initialize them in the correct starting state `pending` for new purchases, `unknown` for recovered ones.
* Keep accurate tracking so the current state of a purchase is always known and can be queried at any time.
* Determine the terminal state based on the request state returned by the `marketplace`.

Purchases are implemented as a state machine that progresses through defined states until reaching a deterministic terminal state (`finished`, `cancelled`, `failed`, or `errored`).

The `StorageRequest` contains all necessary data for the agreement (CID, collateral, expiry, etc.) and is stored in the `marketplace` dependency.

In this document, on-chain refers to interactions with that marketplace, but the abstraction could be replaceable: it could point to a different backend or custom storage system in future implementations.

---

## 2. Interfaces

| Interface (Nim)                                              | Description                                                  | Input                                                       | Output                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------- |
| `func new(_: type Purchase, requestId: RequestId, market: Market, clock: Clock): Purchase` | Construct a purchase from a storage request identifier. Used to recover a purchase. | `requestId: RequestId`, `market: Market`, `clock: Clock`    | `Purchase`                   |
| `func new(_: type Purchase, request: StorageRequest, market: Market, clock: Clock): Purchase` | Create a purchase from a full `StorageRequest`.              | `request: StorageRequest`, `market: Market`, `clock: Clock` | `Purchase`                   |
| `proc start*(purchase: Purchase)`                            | Start the state machine in pending mode (new on-chain submission flow). | `purchase: Purchase`                                        | `void`                       |
| `proc load*(purchase: Purchase)`                             | Start the state machine in unknown mode (restore/recover after restart). | `purchase: Purchase`                                        | `void`                       |
| `proc wait*(purchase: Purchase) {.async.}`                   | Await terminal state: completes on success or raises on failure. | `purchase: Purchase`                                        | `Future[void]`               |
| `func id*(purchase: Purchase): PurchaseId`                   | Stable identifier derived from `requestId`.                  | `purchase: Purchase`                                        | `PurchaseId`                 |
| `func finished*(purchase: Purchase): bool`                   | Check whether the purchase completed successfully.           | `purchase: Purchase`                                        | `bool`                       |
| `func error*(purchase: Purchase): ?(ref CatchableError)`     | Get error if the purchase failed.                            | `purchase: Purchase`                                        | `Option[ref CatchableError]` |
| `func state*(purchase: Purchase): ?string`                   | Query current state name via the state machine.              | `purchase: Purchase`                                        | `Option[string]`             |
| `proc hash*(x: PurchaseId): Hash`                            | Compute hash for `PurchaseId`.                               | `x: PurchaseId`                                             | `Hash`                       |
| `proc ==*(x, y: PurchaseId): bool`                           | Equality comparison for `PurchaseId`.                        | `x: PurchaseId`, `y: PurchaseId`                            | `bool`                       |
| `proc toHex*(x: PurchaseId): string`                         | Hex string representation of `PurchaseId`.                   | `x: PurchaseId`                                             | `string`                     |
| `method run*(state: PurchasePending, machine: Machine): Future[?State] {.async: (raises: []).}` | Submit request to market.                                    | `state: PurchasePending`, `machine: Machine`                | `Future[Option[State]]`      |
| `method run*(state: PurchaseSubmitted, machine: Machine): Future[?State] {.async: (raises: []).}` | Await purchase start.                                        | `state: PurchaseSubmitted`, `machine: Machine`              | `Future[Option[State]]`      |
| `method run*(state: PurchaseStarted, machine: Machine): Future[?State] {.async: (raises: []).}` | Run the purchase.                                            | `state: PurchaseStarted`, `machine: Machine`                | `Future[Option[State]]`      |
| `method run*(state: PurchaseFinished, machine: Machine): Future[?State] {.async: (raises: []).}` | Purchase completed.                                          | `state: PurchaseFinished`, `machine: Machine`               | `Future[Option[State]]`      |
| `method run*(state: PurchaseErrored, machine: Machine): Future[?State] {.async: (raises: []).}` | Purchase failed.                                             | `state: PurchaseErrored`, `machine: Machine`                | `Future[Option[State]]`      |
| `method run*(state: PurchaseCancelled, machine: Machine): Future[?State] {.async: (raises: []).}` | Purchase cancelled or timed out.                             | `state: PurchaseCancelled`, `machine: Machine`              | `Future[Option[State]]`      |
| `method run*(state: PurchaseUnknown, machine: Machine): Future[?State] {.async: (raises: []).}` | Recover a purchase.                                          | `state: PurchaseUnknown`, `machine: Machine`                | `Future[Option[State]]`      |

---

## 3. Functional Requirements (what it must do)

### 3.1 Definition
- Every purchase represents exactly one`StorageRequest`.
- The purchase must have a unique, deterministic identifier `PurchaseId` derived from `requestId`.
- It must be possible to restore any purchase from its `requestId` after a restart.
- A purchase is considered expired when the expiry timestamp in its `StorageRequest` is reached before the request start, i.e, an event `RequestFulfilled` is emitted by the `marketplace`.

### 3.2 State Machine Progression
- New purchases start in the `pending` state (submission flow).
- Recovered purchases start in the `unknown` state (recovery flow).
- The state machine progresses step-by-step until a deterministic terminal state (`finished`, `cancelled`, `failed`, or `errored`) is reached.
- The choice of terminal state is based on the `RequestState` returned by the `marketplace`.

### 3.3 Failure Handling
- On `marketplace` failure events, immediately transition to `errored` without retries.
- If a `CancelledError` is raised, log the cancellation and stop further processing.
- If a `CatchableError` is raised, transition to `errored` and record the error.

---

## 4. Non-Functional Requirements (how it should behave)

- **Execution model:** A purchase is handled by a single thread; only one worker should process a given purchase instance at a time.
- **Reliability:** `load` supports recovery after process restarts.
- **Performance:** State transitions should be non-blocking; all I/O is async.
- **Logging:** All state transitions and errors should be clearly logged for traceability.
- **Safety:**
    - Avoid side effects during `new` other than initialising internal fields; `on-chain` interactions are delegated to states using `marketplace `dependency.
    - Retry policy for external calls.
- **Testing:**
  - Unit tests check that each state handles success and error properly.
  - Integration tests check that a full purchase flows correctly through states.

---

## 5. Internal Behavior

### 5.1 State identifiers

* PurchasePending: `pending`
* PurchaseSubmitted: `submitted`
* PurchaseStarted: `started`
* PurchaseFinished: `finished`
* PurchaseErrored: `errored`
* PurchaseCancelled: `cancelled`
* PurchaseFailed: `failed`
* PurchaseUnknown: `unknown`

### 5.2 General rules for all states

- If a `CancelledError` is raised, the state machine logs the cancellation message and takes no further action.
- If a `CatchableError` is raised, the state machine moves to `errored` with the error message.

### 5.3 State descriptions

`pending`: A storage request is being created by making a call `on-chain`. If the storage request creation fails, the state machine moves to the `errored` state with the corresponding error.

`submitted`: The storage request has been created and the purchase waits for the request to start. When it starts, an `on-chain` event `RequestFulfilled` is emitted, triggering the subscription callback, and the state machine moves to the `started` state. If the expiry is reached before the callback is called, the state machine moves to the `cancelled` state.

`started`: At this point, the purchase is active and waits until the end of the request—defined by the storage request parameters, before moving to the `finished` state. A subscription is made to the `marketplace` to be notified about request failure. If a request failure is notified, the state machine moves to `failed`.  
`marketplace` subscription signature:

```nim
method subscribeRequestFailed*(market: Market, requestId: RequestId, callback: OnRequestFailed): Future[Subscription] {.base, async.}
```

`finished`: The purchase is considered successful and cleanup routines are called. The purchase module calls `marketplace.withdrawFunds` to release the funds locked by the `marketplace`:  

```nim
method withdrawFunds*(market: Market, requestId: RequestId) {.base, async: (raises: [CancelledError, MarketError]).}
```

After that, the purchase is done; no more states are called and the state machine stops successfully.

`failed`: If the `marketplace` emits a `RequestFailed` event, the state machine moves to the `failed` state and the purchase module calls `marketplace.withdrawFunds` (same signature as above) to release the funds locked by the `marketplace`. After that, the state machine moves to `errored`.

`cancelled`: The purchase is cancelled and the purchase module calls `marketplace.withdrawFunds` to release the funds locked by the `marketplace` (same signature as above). After that, the purchase is terminated; no more states are called and the state machine stops with the reason of failure as error.

`errored`: The purchase is terminated; no more states are called and the state machine stops with the reason of failure as error.

`unknown`: The purchase is in recovery mode, meaning that the state has to be determined. The purchase module calls the `marketplace` to get the request data (`getRequest`) and the request state (`requestState`):  

```nim
method getRequest*(market: Market, id: RequestId): Future[?StorageRequest] {.base, async: (raises: [CancelledError]).}

method requestState*(market: Market, requestId: RequestId): Future[?RequestState] {.base, async.}
```

Based on this information, it moves to the corresponding next state.


### 5.4 State diagram

```                                                                      |
                                                                      v
                                         ------------------------- unknown
        |                               /                             /
        v                              v                             /
     pending ----> submitted ----> started ---------> finished <----/
                        \              \                           /
                         \              ------------> failed <----/
                          \                                      /
                           --> cancelled <-----------------------
```

**Note**:
Any state can transition to errored upon a `CatchableError`.
`failed` is an intermediate state before `errored`.
`finished`, `cancelled`, and `errored` are terminal states.

---

## 6. Dependencies

- **marketplace**: External dependency used to submit and monitor storage requests (`requestStorage`, `withdrawFunds`, subscriptions for request events).
- **clock**: Provides timing utilities, used for expiry and scheduling logic.
- **nim-chronos**: Async runtime used for futures, awaiting I/O, and cancellation handling.
- **asyncstatemachine**: Base state machine framework used to implement the purchase lifecycle.
- **hashes**: Standard Nim hashing for `PurchaseId`.
- **questionable**: Used for optional fields like `request`.

---

## 7. Data Models

### `Purchase`
```nim
Purchase* = ref object of Machine
  future*: Future[void]
  market*: Market
  clock*: Clock
  requestId*: RequestId
  request*: ?StorageRequest
```

### Storage request

```nim
StorageRequest* = object
  client* {.serialize.}: Address
  ask* {.serialize.}: StorageAsk
  content* {.serialize.}: StorageContent
  expiry* {.serialize.}: uint64
  nonce*: Nonce
```

### Storage ask

```nim
StorageAsk* = object
  proofProbability* {.serialize.}: UInt256
  pricePerBytePerSecond* {.serialize.}: UInt256
  collateralPerByte* {.serialize.}: UInt256
  slots* {.serialize.}: uint64
  slotSize* {.serialize.}: uint64
  duration* {.serialize.}: uint64
  maxSlotLoss* {.serialize.}: uint64
```

### Storage content

```nim
StorageContent* = object
  cid* {.serialize.}: Cid
  merkleRoot*: array[32, byte]
```

### RequestId

```nim
RequestId* = distinct array[32, byte]
```

### Nonce

```nim
Nonce* = distinct array[32, byte]
```