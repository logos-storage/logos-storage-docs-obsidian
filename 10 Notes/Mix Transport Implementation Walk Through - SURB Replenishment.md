---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport SURB Replenishment Strategy]]"
  - "[[Mix Transport Implementation Walk Through]]"
  - "[[Mix Transport Implementation Walk Through - Connect Handshake]]"
  - "[[Mix Transport Implementation Walk Through - Stream Establishment Round Trip]]"
  - "[[Mix Transport Implementation Walk Through - Bounded Data Flow]]"
  - "[[Mix Transport Implementation Walk Through - Reply Credential Store]]"
---

# Mix Transport Implementation Walk Through - SURB Replenishment

This walk-through follows the implemented SURB supply path from session establishment to liveness failure. The session initiator creates public SURBs and retains their private reply credentials. The session recipient stores the public SURBs in one bounded queue and consumes them whenever it sends Data, ACK or another ordinary frame back to the anonymous initiator.

Replenishment is push-based. The recipient reports its queue state and available capacity as an absolute snapshot. The initiator applies every valid snapshot, but waits until the projected recipient inventory reaches a configured low watermark before sending more numbered SURBs. One replenishment cycle then restores the projected inventory to capacity. There is no `RefillRequest`, no pull-only mode and no set of SURBs reserved for refill control traffic.

The implementation is divided across three modules:

- `libp2p_mix_transport/wire.nim` defines handshake SURBs, numbered `SurbSupply`, `SurbStatusProbe`, `SurbStatus` and the absolute supply snapshot fields.
- `libp2p_mix_transport/sessions.nim` owns the recipient queue, supply sequence state, initiator retransmission state and status-probe deadlines.
- `libp2p_mix_transport/transport.nim` creates SURBs, sends the frames, applies returned snapshots and runs the session's supplier task.

## 1. One Session Owns One SURB Queue

`TransportSession` contains both sides of the supply protocol. Only the fields appropriate to the local session role are active.

```nim
TransportSession* = ref object
  receivedSurbs: Deque[SURB]
  recipientSurbCapacity: int
  surbSupplyReceiveBase: SurbSupplySequence
  surbSupplyAcknowledgementBitmap: seq[byte]
  surbSupplyLimit: SurbSupplySequence

  remoteSurbCapacity: int
  remoteSurbSupplyReceiveBase: SurbSupplySequence
  remoteSurbSupplyLimit: SurbSupplySequence
  nextSurbSupplySequence: Opt[SurbSupplySequence]
  pendingSurbSupply: Table[SurbSupplySequence, PendingSurbSupply]

  nextSurbStatusProbeAt: Opt[Moment]
  unansweredSurbStatusProbes: int
```

On the recipient, `receivedSurbs` is the bounded queue of usable public SURBs. `surbSupplyReceiveBase`, the bitmap and `surbSupplyLimit` describe which numbered SURBs have arrived and how many additional SURBs the initiator may send.

On the initiator, `pendingSurbSupply` retains every numbered public SURB that has been sent but not yet acknowledged by the recipient. Each entry also stores the identifier of the matching private credential and its next retransmission deadline.

All virtual streams in the session share this queue. A reverse frame belongs to the anonymous session, so its return path does not need to be assigned permanently to one stream.

## 2. Handshake Frames Carry Immediate Reply Paths and Initial Supply

`Connect` and `OpenStream` both need an immediate reverse response. Each frame reserves the first two SURBs for that response and uses its remaining guaranteed space for numbered session supply. `Connect` establishes the first supply entries because no session supplier can operate before the recipient acknowledges the session. Later `OpenStream` frames can extend the same supply sequence without requiring a separate forward packet.

The wire module records fixed capacities established from the maximum legal size of every variable-length field:

```nim
const
  DefaultReplySurbRedundancy* = 2
  MaxConnectSurbs* = 5
  MaxOpenStreamSurbs* = 4
  MaxSurbSupplyPerFrame* = 5
```

For both handshake frames, the first `DefaultReplySurbRedundancy` SURBs are unnumbered and dedicated to the immediate response. The current redundancy count is two. Any SURBs after those first two are numbered supply.

`Connect` holds five SURBs: two response paths and three numbered bootstrap entries. A dedicated `SurbSupply` frame also holds five SURBs, all of which are numbered supply. `OpenStream` includes a stream identifier and a codec, so its guaranteed capacity is four SURBs: two response paths and two numbered supply entries. The capacity assumes a codec of `MaxCodecBytes`, ensuring that a shorter codec does not change the frame layout or the amount of supply attached by `dial`.

The wire tests encode frames at these declared capacities with maximum-size fields and compare the raw Protobuf length with `MaxTransportFrameBytes`. The tests also add one SURB and verify that the raw encoding exceeds the available transport payload. These checks keep the named constants tied to the actual Sphinx framing boundary.

## 3. The Initiator Registers the Connect Bootstrap Supply

`createConnectFrame` creates the maximum number of SURBs that fit. It keeps every private credential in `ReplyCredentialStore`, attaches every public serialization to `Connect`, and registers the suffix after the two response paths as supply sequences beginning at zero:

```nim
proc createConnectFrame(
    self: MixTransport, destination: PeerId, session: TransportSession
): Result[MixTransportFrame, string] =
  var frame = MixTransportFrame(
    version: MixTransportVersion,
    sessionId: session.sessionId,
    kind: FrameKind.Connect,
  )
  let surbCount = MaxConnectSurbs
  let prepared =
    self.createReplySurbs(destination, session.sessionId, surbCount).valueOr:
      return err("could not prepare Connect reply SURBs: " & error)
  frame.surbs = prepared.encoded

  let suppliedCount = surbCount - DefaultReplySurbRedundancy
  if suppliedCount > 0:
    # Build credentialIdentifiers for the numbered suffix.
    let firstSequence = session.registerInitialSurbSupply(
      prepared.encoded.toOpenArray(
        DefaultReplySurbRedundancy, prepared.encoded.high
      ),
      credentialIdentifiers,
    ).valueOr:
      return err("could not register initial SURB supply: " & error)
    frame.firstSurbSequence = Opt.some(firstSequence)

  ok(frame)
```

`registerInitialSurbSupply` is separate from ordinary `registerSurbSupply` because the initiator has not received the recipient's credit snapshot yet. This one operation is allowed to establish sequences zero through two before remote credit exists. The configured recipient capacity must be large enough to hold this bootstrap suffix.

After `Connect` has been submitted, `connect` schedules retransmission deadlines for the numbered suffix. The two unnumbered response SURBs are not supply entries and are not retransmitted as numbered supply.

## 4. The Recipient Splits Connect SURBs by Position

`handleConnect` applies the same positional rule. It first decodes exactly two response SURBs. Failure to decode either response SURB prevents the recipient from accepting a session that cannot acknowledge itself.

```nim
proc handleConnect(
    self: MixTransport, frame: MixTransportFrame
): Future[void] {.async: (raises: [CancelledError]).} =
  var replyBatch = newSeqOfCap[SURB](DefaultReplySurbRedundancy)
  for index in 0 ..< DefaultReplySurbRedundancy:
    let surb = frame.surbs[index].deserializeSurb().valueOr:
      return
    replyBatch.add(surb)

  let session = self.sessions.addRecipientSession(frame.sessionId).valueOr:
    return
  session.initializeSurbSupply().isOkOr:
    return

  if frame.surbs.len > DefaultReplySurbRedundancy:
    let firstSequence = frame.firstSurbSequence.get()
    for index in DefaultReplySurbRedundancy ..< frame.surbs.len:
      let surb = frame.surbs[index].deserializeSurb().valueOr:
        continue
      let sequence =
        firstSequence + SurbSupplySequence(
          index - DefaultReplySurbRedundancy
        )
      discard session.acceptSurbSupply(sequence, surb)
```

Each numbered SURB is decoded independently. A malformed supply entry does not discard the other valid entries. Its sequence remains absent from the acknowledgement bitmap, so the initiator retains and later retransmits that specific public SURB.

The recipient then attaches its complete supply snapshot to `ConnectAck`. With the default queue capacity of sixteen and three accepted bootstrap SURBs, the snapshot reports receive base three, an empty bitmap and supply limit sixteen. The initiator can infer that sequences zero through two arrived and that sequences three through fifteen are authorized.

## 5. OpenStream Carries Response Paths and Numbered Supply

After session establishment, `dial` creates an `OpenStream` frame. The first two SURBs are unnumbered response paths consumed by `StreamAck` or `StreamReject`. If the recipient has advertised at least two unfilled positions, `dial` also places two numbered supply SURBs in the remaining guaranteed frame space. When fewer positions are available, `dial` attaches only the number authorized by the latest supply snapshot.

```nim
proc dial*(
    self: MixTransport, destination: PeerId, codec: string
): Future[Result[TransportStream, string]]
    {.async: (raises: [CancelledError]).} =
  # Session and stream creation precede this excerpt.
  var frame = MixTransportFrame(
    version: MixTransportVersion,
    sessionId: session.sessionId,
    kind: FrameKind.OpenStream,
    streamId: Opt.some(stream.streamId),
    codec: Opt.some(codec),
  )
  let
    suppliedCount = min(
      MaxOpenStreamSurbs - DefaultReplySurbRedundancy,
      session.availableSurbSupplySlots,
    )
    surbCount = DefaultReplySurbRedundancy + suppliedCount
  let prepared = self.createReplySurbs(
    destination, session.sessionId, surbCount
  ).valueOr:
    return err("could not prepare OpenStream reply SURBs: " & error)
  frame.surbs = prepared.encoded
```

Before submitting `OpenStream`, `dial` registers the numbered suffix with `session.registerSurbSupply` and writes the returned first sequence into `frame.firstSurbSequence`. Registering before the asynchronous send prevents another supplier action from assigning the same sequence numbers. After submission, `dial` schedules the numbered suffix for the same acknowledgement and retransmission processing used by standalone supply.

On the recipient, `handleOpenStream` decodes the first two SURBs into a temporary response batch before looking up the requested protocol. The recipient uses the response batch for either acknowledgement or rejection. The handler independently decodes every later SURB and passes each valid entry to `session.acceptSurbSupply`. Those entries join the session-wide queue and are available to every stream in the session, including when this particular stream is rejected.

## 6. The Session Supplier Uses a Low Watermark

After `ConnectAck` establishes the initiator-side session, `startSurbSupplier` starts one supplier task owned by that session. The supplier first needs to know how much numbered supply it may allocate. `availableSurbSupplySlots` compares the next unused sequence with the recipient's latest absolute limit and the fixed supply receive window:

```nim
func availableSurbSupplySlots*(session: TransportSession): int =
  if session.role != SessionRole.Initiator:
    return 0
  let nextSequence = session.nextSurbSupplySequence.valueOr:
    return 0
  let upperBound = min(
    uint64(session.remoteSurbSupplyLimit),
    uint64(session.remoteSurbSupplyReceiveBase) + uint64(SurbSupplyWindow),
  )
  if uint64(nextSequence) >= upperBound:
    return 0
  int(upperBound - uint64(nextSequence))
```

The returned number describes authorized positions that the initiator has not allocated yet. The supply limit bounds queue occupancy. The receive-base-plus-window bound prevents one missing supply packet from leaving an unlimited number of later entries in the recipient's out-of-order state.

The initiator learns the recipient's queue capacity from the first `ConnectAck` snapshot. `estimatedRemoteSurbInventory` subtracts the currently unfilled positions from that capacity:

```nim
func estimatedRemoteSurbInventory*(session: TransportSession): int =
  if session.role != SessionRole.Initiator or
      session.remoteSurbCapacity == 0:
    return 0
  max(
    0,
    session.remoteSurbCapacity - session.availableSurbSupplySlots,
  )
```

This value is a projection rather than a direct measurement of the recipient's queue. A numbered SURB counts toward the projection as soon as the initiator allocates its sequence, including while the corresponding `SurbSupply` frame is in flight. If that packet is lost, the existing retransmission state resends the same numbered SURB. The initiator must not interpret an in-flight position as permission to create another SURB.

The constructor parameter `surbReplenishmentLowWatermark` controls when a new cycle begins. The default is one full dedicated supply packet below the default capacity:

```nim
DefaultSurbReplenishmentLowWatermark* =
  DefaultRecipientSurbCapacity - MaxSurbSupplyPerFrame
```

The current values produce a watermark of eleven for a capacity of sixteen and a five-SURB supply packet. `isSurbReplenishmentDue` requires both an unfilled authorized position and a projected inventory at or below the watermark:

```nim
func isSurbReplenishmentDue*(
    session: TransportSession, lowWatermark: int
): bool =
  session.availableSurbSupplySlots > 0 and
    session.estimatedRemoteSurbInventory <= lowWatermark
```

For example, sending one reverse frame consumes two SURBs and changes a full projected inventory from sixteen to fourteen. The snapshot on that reverse frame wakes the supplier, but `isSurbReplenishmentDue(session, 11)` remains false. No two-SURB supply packet is generated. Once five positions have become available, the projected inventory reaches eleven and one full supply packet can restore it to sixteen.

Once the projection reaches the configured watermark, `runSurbSupplier` sets its local `replenishing` state. The supplier retains this state until all available positions have been allocated:

```nim
proc runSurbSupplier(
    self: MixTransport, session: TransportSession
) {.async: (raises: [CancelledError]), gcsafe.} =
  var replenishing = false
  session.noteReverseActivity(self.reverseActivityTimeout)

  while session.state == SessionState.Established:
    session.clearSurbSupplyStateChanged()
    # Status-probe processing precedes this excerpt.

    if replenishing and session.availableSurbSupplySlots == 0:
      replenishing = false
    elif not replenishing and
        session.isSurbReplenishmentDue(
          self.surbReplenishmentLowWatermark
        ):
      replenishing = true

    if replenishing and session.availableSurbSupplySlots > 0:
      let count = min(
        MaxSurbSupplyPerFrame,
        session.availableSurbSupplySlots,
      )
      if await self.createAndSendSurbSupply(session, count):
        continue
```

Keeping `replenishing` true provides hysteresis between the low watermark and full capacity. With the defaults, reaching eleven makes exactly five positions available and one full packet restores the projection to sixteen. With a custom watermark farther below capacity, the supplier can require several packets; the active-cycle state ensures that the first packet crossing above the watermark does not stop replenishment early.

During an active cycle, `createAndSendSurbSupply` creates at most `MaxSurbSupplyPerFrame` SURBs, registers their serialized public values and credential identifiers, and sends them in one `SurbSupply` frame:

```nim
proc createAndSendSurbSupply(
    self: MixTransport, session: TransportSession, count: int
): Future[bool] {.async: (raises: [CancelledError]).} =
  let destination = session.destination.valueOr:
    return false
  let prepared =
    self.createReplySurbs(destination, session.sessionId, count).valueOr:
      return false
  let firstSequence = session.registerSurbSupply(
    prepared.encoded, credentialIdentifiers
  ).valueOr:
    self.retireReplyCredentials(prepared.credentials)
    return false
  await self.sendSurbSupply(session, firstSequence, prepared.encoded)
  true
```

`SurbSupply` carries `firstSurbSequence`; the position of each serialized SURB determines its sequence. The frame therefore needs no persistent group identifier. With steady reverse traffic and the default values, replenishment normally sends one full five-SURB frame after five SURBs have been consumed instead of sending one partially filled frame after every two-SURB reverse transmission.

## 7. The Recipient Accepts Supply Independently

`handleSurbSupply` derives every sequence and decodes every serialized SURB separately:

```nim
proc handleSurbSupply(
    self: MixTransport, frame: MixTransportFrame
) {.gcsafe, raises: [].} =
  # Session and role checks precede this excerpt.
  let firstSequence = frame.firstSurbSequence.get()
  for index, encodedSurb in frame.surbs:
    let sequence = firstSequence + SurbSupplySequence(index)
    let surb = encodedSurb.deserializeSurb().valueOr:
      continue
    discard session.acceptSurbSupply(sequence, surb)
```

`acceptSurbSupply` rejects already acknowledged sequences, duplicates represented in the bitmap, sequences outside the advertised limit and entries outside the fixed receive window. A valid new entry is appended to the recipient queue and represented in the bitmap:

```nim
proc acceptSurbSupply*(
    session: TransportSession,
    sequence: SurbSupplySequence,
    surb: sink SURB,
): SurbSupplyDisposition =
  if sequence < session.surbSupplyReceiveBase:
    return SurbSupplyDisposition.Duplicate
  if sequence >= session.surbSupplyLimit:
    return SurbSupplyDisposition.OutsideWindow

  let offset = sequence - session.surbSupplyReceiveBase
  if offset >= SurbSupplySequence(SurbSupplyWindow):
    return SurbSupplyDisposition.OutsideWindow
  if session.surbSupplyAcknowledgementBitmap.bitmapContains(offset):
    return SurbSupplyDisposition.Duplicate
  if session.receivedSurbs.len >= session.recipientSurbCapacity:
    return SurbSupplyDisposition.AtCapacity

  session.receivedSurbs.addLast(move(surb))
  session.surbSupplyAcknowledgementBitmap.setBitmapBit(offset)
  while session.surbSupplyAcknowledgementBitmap.bitmapContains(0):
    session.shiftSupplyBitmap()
    inc session.surbSupplyReceiveBase
  session.replyCapacityStateChanged.fire()
  SurbSupplyDisposition.Accepted
```

The queue entry and bitmap bit are created in the same synchronous operation. The bitmap acknowledges receipt to the initiator; the queue owns the usable public SURB. When all sequences from the receive base are present, the loop advances the base across that contiguous prefix.

## 8. Reverse Sends Wait for a Complete Redundancy Batch

The session recipient cannot send an ordinary frame through the forward Mix route because the anonymous initiator is not known as a destination. The recipient must remove two public SURBs from its session queue.

`sendStreamFrame` serializes reverse sends with `replySendLock`. After taking the lock, the procedure calls `waitForReplySurbs`:

```nim
proc waitForReplySurbs(
    session: TransportSession, count: int
): Future[Result[void, string]] {.async: (raises: [CancelledError]).} =
  while session.receivedSurbCount < count:
    if session.state != SessionState.Established:
      return err("session closed while waiting for reply SURBs")
    session.clearReplyCapacityStateChanged()
    if session.receivedSurbCount < count:
      await session.waitForReplyCapacityStateChange()
  ok()
```

There is no control reserve. If fewer than two SURBs exist, the operation waits until supply arrives or session shutdown wakes it. Once a complete batch is available, `sendStreamFrame` removes it:

```nim
proc sendStreamFrame(
    self: MixTransport,
    session: TransportSession,
    frame: MixTransportFrame,
): Future[Result[void, string]] {.async: (raises: [CancelledError]).} =
  case session.role
  of SessionRole.Initiator:
    # Encode and send through the forward Mix path.
    discard
  of SessionRole.Recipient:
    await session.acquireReplySend()
    defer:
      session.releaseReplySend()
    (await session.waitForReplySurbs(DefaultReplySurbRedundancy)).isOkOr:
      return err(error)
    var replyBatch =
      session.takeReceivedSurbs(DefaultReplySurbRedundancy).valueOr:
        return err(error)
    var replyFrame = frame
    session.attachSurbSupplySnapshot(replyFrame)
    let payload = replyFrame.encode().valueOr:
      return err("could not encode " & $frame.kind & " frame: " & error)
    (await self.sendWithSurbRedundancyBatch(replyBatch, payload)).isOkOr:
      return err("could not send " & $frame.kind & " frame: " & error)
  ok()
```

`takeReceivedSurbs` increases `surbSupplyLimit` by the number removed. Attaching the snapshot after that removal advertises the newly available queue positions in the same reverse frame. The initiator does not need a separate refill request.

## 9. The Initiator Applies an Absolute Snapshot

Every ordinary reverse frame and every `SurbStatus` can carry the three snapshot fields:

```nim
proc attachSurbSupplySnapshot(
    session: TransportSession, frame: var MixTransportFrame
) =
  let snapshot = session.surbSupplySnapshot()
  frame.surbSupplyReceiveBase = Opt.some(snapshot.receiveBase)
  frame.surbSupplyAcknowledgementBitmap =
    Opt.some(snapshot.acknowledgementBitmap)
  frame.surbSupplyLimit = Opt.some(snapshot.supplyLimit)
```

When the initiator recovers the frame, `handleReplyFrame` applies that snapshot before processing the frame kind:

```nim
proc handleReplyFrame(
    self: MixTransport, frame: MixTransportFrame
): Future[void] {.async: (raises: [CancelledError]).} =
  let session = self.sessions.get(frame.sessionId).valueOr:
    return

  if not session.applySurbSupplySnapshot(frame):
    return
  if frame.surbSupplyReceiveBase.isSome:
    session.noteReverseActivity(self.reverseActivityTimeout)

  case frame.kind
  # ConnectAck, StreamAck, Data, Ack and SurbStatus handling follows.
```

`applySurbSupplySnapshot` removes pending public serializations below the reported receive base and those selected by set bitmap bits. The initiator retains entries corresponding to gaps because the recipient has not acknowledged them. The procedure also advances the initiator's view of the supply limit and signals the supplier task when new capacity becomes available.

The snapshot is absolute rather than incremental. A duplicate or delayed frame can repeat old state without granting the initiator the same capacity twice.

## 10. Unacknowledged Supply Is Retransmitted

`sendSurbSupply` schedules a retransmission deadline after every initial send or retry:

```nim
proc sendSurbSupply(
    self: MixTransport,
    session: TransportSession,
    firstSequence: SurbSupplySequence,
    encodedSurbs: seq[seq[byte]],
): Future[void] {.async: (raises: [CancelledError]).} =
  # Frame construction and send precede this excerpt.
  session.scheduleSurbSupplyRetransmission(
    firstSequence,
    encodedSurbs.len,
    self.surbSupplyRetransmissionTimeout,
  )
```

The supplier selects one due entry at a time. Before retransmitting it, the supplier purges expired credentials and verifies that the matching private credential still exists:

```nim
let retransmission = session.takeDueSurbSupplyRetransmission()
if retransmission.isSome:
  let value = retransmission.get()
  discard self.replyCredentials.purgeExpired()
  if self.replyCredentials.get(value.credentialIdentifier).isNone:
    session.removePendingSurbSupply(value.sequence)
    continue
  await self.retransmitSurbSupply(
    session, value.sequence, value.encodedSurb
  )
  continue
```

Reusing the original sequence and serialized public SURB is essential. Creating a replacement credential for the same sequence would leave credentials that the recipient can never use. Retransmitting a SURB after its credential expires would give the recipient an unusable return path, so the supplier removes that pending entry instead.

If an arriving snapshot removes the pending entry while a retransmission is being submitted, completion only attempts to schedule the existing table entry. Completion does not recreate an acknowledged entry.

## 11. Status Probes Recover a Lost Snapshot

The recipient may consume SURBs and send a reverse frame whose every redundant copy is lost. The initiator then retains an obsolete view of the queue: the initiator has not received the higher supply limit and may believe no further supply is authorized. A recipient with fewer than two SURBs cannot send another ordinary reverse frame to correct that view.

The initiator handles this case by tracking valid reverse activity. `noteReverseActivity` resets the unanswered-probe count and starts a new inactivity period:

```nim
proc noteReverseActivity*(
    session: TransportSession,
    probeInterval: Duration,
    now: Moment = Moment.now(),
) =
  session.unansweredSurbStatusProbes = 0
  session.nextSurbStatusProbeAt = Opt.some(now + probeInterval)
  session.surbSupplyStateChanged.fire()
```

When that deadline expires, the supplier records an attempt before awaiting network delivery and calls `sendSurbStatusProbe`:

```nim
if statusProbeIsDue:
  if session.unansweredSurbStatusProbeCount >=
      self.maxSurbStatusProbeAttempts:
    # Remove and shut down the unresponsive session.
    return
  session.recordSurbStatusProbeAttempt(
    self.surbStatusProbeRetryInterval
  )
  await self.sendSurbStatusProbe(session)
  continue
```

Recording first prevents a very fast response from being overwritten by state written after the send completes.

`sendSurbStatusProbe` creates two fresh response paths and places them directly in the forward probe:

```nim
proc sendSurbStatusProbe(
    self: MixTransport, session: TransportSession
): Future[void] {.async: (raises: [CancelledError]).} =
  let destination = session.destination.valueOr:
    return
  let prepared = self.createReplySurbs(
    destination,
    session.sessionId,
    DefaultReplySurbRedundancy,
  ).valueOr:
    return
  let probe = MixTransportFrame(
    version: MixTransportVersion,
    sessionId: session.sessionId,
    kind: FrameKind.SurbStatusProbe,
    surbs: prepared.encoded,
  )
  discard await self.sendStreamFrame(session, probe)
```

The recipient's `handleSurbStatusProbe` uses these two SURBs immediately to send `SurbStatus` with the current absolute snapshot. The probe SURBs do not enter `receivedSurbs`, do not consume supply sequence numbers and do not require free queue capacity.

Sending a probe is not reverse activity. Only a valid recovered snapshot calls `noteReverseActivity`, resets the attempt count and returns the deadline to the normal inactivity interval.

## 12. Repeated Silence Fails One Session

The constructor exposes three liveness controls:

```nim
proc newMixTransport*(
    mix: MixProtocol,
    reverseActivityTimeout = DefaultReverseActivityTimeout,
    surbStatusProbeRetryInterval =
      DefaultSurbStatusProbeRetryInterval,
    maxSurbStatusProbeAttempts =
      DefaultMaxSurbStatusProbeAttempts,
    # Other transport parameters omitted.
): MixTransport
```

After ordinary reverse activity stops, the initiator waits `reverseActivityTimeout` before sending the first probe. Each unanswered attempt is followed by `surbStatusProbeRetryInterval`. After the final configured attempt, the initiator still waits one complete retry interval for its response.

If no valid reverse snapshot arrives by the next deadline, `runSurbSupplier` removes that session from the transport registry, removes the session's reply credentials and calls `session.shutdown()`. Shutdown cancels and awaits the supplier and stream-owned tasks and wakes reverse senders that may be waiting for SURBs. Other sessions owned by the same transport remain active.

## 13. What the Tests Establish

`tests/test_wire.nim` verifies the physical frame capacities using raw Protobuf lengths. `Connect` fits five SURBs, a maximum-length `OpenStream` fits four, and a dedicated `SurbSupply` frame fits five; adding one SURB to any of these full frames exceeds `MaxTransportFrameBytes`. The same tests verify that the first two handshake SURBs remain the unnumbered response batch and that any suffix has numbered-supply metadata.

`tests/test_sessions.nim` verifies the bounded queue and sequence rules directly. The Connect bootstrap test registers three initial sequences before credit exists, applies a snapshot with receive base three and supply limit sixteen, and verifies that the projected inventory begins at three. After allocating the remaining thirteen positions, the projection reaches sixteen. A snapshot granting two replacement positions lowers the projection to fourteen and does not cross the default watermark. A later snapshot grants five positions, lowers the projection to eleven and makes a replenishment cycle due. The status-probe test verifies that attempts advance their deadline and that valid reverse activity resets the counter.

`tests/test_lifecycle.nim` verifies that the default watermark equals recipient capacity minus one full `SurbSupply` packet and that the constructor accepts an explicit watermark for deployments that tune the policy through field measurements.

`tests/test_connect.nim` runs the protocol through a live five-node Mix topology. The test establishes a session and stream, waits for the initiator-driven numbered supply to fill the recipient's advertised capacity, and exchanges application data through the standard `Connection` interface.
