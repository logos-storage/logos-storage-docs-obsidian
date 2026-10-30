This presentation explains how MixTransport turns independent Mix messages into bidirectional application streams. It follows a session initiator **A** and a session recipient **B**, then separates stream delivery from the SURB supply that makes reverse communication possible.

## Presentation

> This presentation is an Obsidian Excalidraw drawing. To view it, open this vault in Obsidian with the Excalidraw plugin installed and enabled.

![[How MixTransport Works.excalidraw#^frame=hwTitle2026]]

## Slide guide

| Topic                                  | Main point                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Legacy connections and the message API | Contrast the connection-associated reply queue with MixTransport’s message callbacks, sessions and streams.    |
| Reliable streams over Mix messages     | Mix transports messages; MixTransport provides the stream model above them.                                    |
| Four parts of MixTransport             | Establishing a session, sending data over streams, keeping delivery in order, and maintaining the SURB supply. |
| Forward and reverse paths              | A addresses B on the forward path; B uses SURBs to send back without needing A's network address.              |
| Session identity                       | Both endpoints use session ID S, but their applications see different remote peer identities.                  |
| Establishing a session                 | `Connect` supplies the SURBs for its acknowledgement and the initial session inventory.                        |
| Opening streams from either side       | Initiator/recipient roles stay fixed; opener/acceptor roles can swap for each stream.                          |
| Multiplexing                           | Streams share a session while keeping independent Data sequence state in each direction.                       |
| Chunking                               | A large write becomes multiple numbered Data frames, reconstructed as an ordered stream.                       |
| Redundancy and de-duplication          | Distinct SURBs carry copies of one frame; the receiver delivers its Data only once.                            |
| Why a receive window?                  | Bound out-of-order retention using a 256-position range of Data sequence numbers.                              |
| ACK feedback                           | The receiver reports a base and receipt bitmap; the sender derives the window limit.                           |
| Receive window                         | Out-of-order chunks are retained and acknowledged while waiting for missing earlier chunks.                    |
| Backpressure                           | Bounded buffering and the receive window eventually make a fast writer wait for a slow reader.                 |
| Shared SURB inventory                  | One arrival-order queue supplies all streams; missing supply sequences do not block use.                       |
| Why supply snapshots?                  | Receipt is tracked separately from the supply limit, which starts at capacity and grows as SURBs are spent.    |
| When snapshots are sent                | B includes them in reverse traffic and in responses to status probes.                                          |
| Spending SURBs frees space             | Spending two SURBs permits two new supply sequence numbers without undoing earlier receipt acknowledgements.   |
| Push replenishment                     | The initiator uses a watermark to batch replenishment instead of filling every small gap.                      |
| Probing during silence                 | Fresh response SURBs allow a status reply even when the ordinary queue is empty.                               |
| Three kinds of state                   | Session identity, per-stream Data flow, and session-wide return capacity serve different purposes.             |

## Presenter notes

### Legacy connections and the message API

The diagram shows the reply-expecting legacy interface, with B both the exit and the destination. The connection objects are local wrappers, not a single end-to-end libp2p connection:

- At A, `MixEntryConnection.write` invokes Mix's legacy send path. Mix creates the response SURBs and registers their reply credentials together with this connection's `incoming: AsyncQueue[seq[byte]]`.
- At B, `ExitLayer.runHandler` constructs `MixExitConnection(message)`. The application handler reads the request from its message buffer using `readOnce`; its writes accumulate in a separate response buffer. After the handler returns, `ExitLayer` takes that response with `getResponse()`.
- Still at B, `ExitLayer.reply` creates `MixReplyConnection` with the supplied SURBs and writes the response through it. This is a sending wrapper, not a reply read queue. The response travels back through Mix.
- At A, Mix recovers the first valid response using its connection-associated credential store, releases the redundant credential group, and puts the response bytes into that entry connection's incoming queue. The queue consumer moves them into `cached` and completes `replyReceivedFut`; `readOnce` reads from that cache. A reply-expecting entry connection accepts one request write.

When the destination is beyond the exit, the exit dials a regular libp2p connection, writes the request, and collects its response using the codec's registered destination-read callback. It does not create a `MixExitConnection` for that branch. The SURB-based response and A's incoming queue work as above.

MixTransport instead receives complete messages through its registered callbacks. It owns the reply credentials and maps incoming transport frames to sessions and streams; those frames do not pass through a legacy `MixEntryConnection` queue.

### Opening picture: a stream above messages

Read the “Reliable streams over independent Mix messages” slide from the applications down to the transport. The matching coloured strips represent the same application bytes at both endpoints. The dashed line denotes a logical stream, not a physical connection. Underneath, MixTransport packages bytes into messages that Mix carries through relays; the other transport reconstructs the ordered bytes for the receiving application. The envelopes are generic Mix messages, not named frame kinds.

Only one sending direction is drawn to introduce the layering. Every stream is bidirectional. Frame kinds, chunk numbering, acknowledgements and reverse-path SURBs are introduced on later slides. The colours do not specify message sizes, write boundaries, or a wire encoding.

### Session identity is not a return address

$A$ knows B's destination identity and addressing information. $A$ also generates the session identifier $S$, represented using the libp2p `PeerId` type. At $A$, the application-facing remote peer is $B$. At $B$, it is $S$: an anonymous session identity, not $A$'s physical identity or a routable address.

$B$ can open another stream to $S$ while that session exists. This does not let $B$ establish a new anonymous session to $A$ after the old one is gone. $A$'s streams use odd $ID$s; $B$'s use even $ID$s. Both kinds of stream carry application data in either direction.

### Receive-window feedback

For each stream direction, the receive window is the interval `[receiveBase, receiveBase + 256)`, subject to the sequence-space limit. It bounds how far ahead Data may be accepted while earlier chunks are missing or the ordered receive buffer is full. The receiver retains accepted chunks and delivers them in order. The other direction of the same stream has independent receive state.

The initial base is 1. The width of 256 is a protocol constant, not a separately advertised capacity. An `Ack` frame identifies the session and stream and carries `receiveBase` and a 256-bit `acknowledgementBitmap`. Bit `i` refers to sequence `receiveBase + i`; a set bit acknowledges receipt. Sequences below the base have already entered the ordered receive buffer. This is not proof that the application has consumed them.

In the reference implementation, accepting Data, recognizing a duplicate, or advancing the receive base signals the acknowledgement task. That task sends a snapshot in a separate `Ack` frame; it does not wait for application data to piggyback on. Several state changes can be covered by one ACK containing the latest snapshot. For example, if chunks 5 and 6 both arrive before the acknowledgement task runs, one ACK can acknowledge both. Local sending can also wait for Mix or, in the reverse direction, for SURBs. There is therefore no guarantee of one immediately transmitted ACK per incoming Data frame.

ACKs travel opposite to the Data they acknowledge: reverse for forward Data, forward for reverse Data. They free acknowledged chunks from the sender's retransmission state. Base advancement also moves the permitted sending range. The later worked example illustrates these two effects separately.

### What the sender is allowed to send

The **Data receive window** is the range of sequence numbers the receiver accepts. Advancing its base makes further sequence numbers available for sending. The sender derives the window's upper limit from the latest acknowledged receive base and the fixed width of 256.

For example:

- With base **4**, the window covers sequences **4–259**.
- A bitmap acknowledging chunks **5 and 6** lets the sender release their retained copies. The permitted range still ends at **259**.
- Once chunks **4, 5 and 6** have entered the ordered receive buffer, the base advances to **7**. The window now covers **7–262**, making three additional sequence positions available.

The sender must also respect the separate limit of **64 retained, unacknowledged chunks per stream direction**. A bitmap acknowledgement can free space under that limit without advancing the receive window. Sending new chunks requires room under both limits; reverse sending additionally requires SURBs.

### Two acknowledgement systems

**Data acknowledgements** belong to one stream direction. Their receive base and bitmap describe retained chunks and advancement into the ordered receive buffer. An acknowledgement does not mean that the application has processed the bytes. The receive base advances when ordered bytes can enter the bounded buffer; a slow application eventually prevents further advancement.

**SURB supply snapshots** belong to the session. They tell A which numbered SURBs have reached B and the upper boundary for new SURB sequence numbers B can accept. Receiving a SURB and spending it are separate events: a SURB remains acknowledged after B has taken it out of the queue for sending. These supply sequence numbers and limits are independent of the Data receive window.

Acknowledging receipt of a supplied SURB allows A to stop retaining its serialized bytes for retransmission. A must still retain the corresponding reply credential so it can recover a later reverse message sent using that SURB.

### Redundancy does not duplicate application data

The reverse-send example uses two different SURBs for two copies of the same encoded frame. Their reply identifiers differ, but their stream ID and Data sequence are the same. MixTransport's stream receive state prevents repeated application delivery. A later Data retry also needs fresh SURBs; it preserves the Data sequence and payload, while its supply snapshot can be updated.

### The queue can be used despite supply gaps

The recipient stores usable SURBs in a `Deque[SURB]`. Each accepted SURB is appended with `addLast`; sending takes entries with `popFirst`. This is a FIFO queue in **acceptance order**, not a sequence-sorted buffer. The queue stores SURBs themselves; the receipt base and bitmap track supply sequence numbers separately.

An accepted SURB is immediately usable even if lower supply sequence numbers are missing. Unlike application Data, SURBs do not need to be delivered in sequence before use. The ascending labels in “One SURB queue serves all streams in a session” illustrate one possible arrival order, not a requirement.

For a concrete example, suppose A has allocated supply sequences **0–6**, the queue capacity is **16**, and B has already spent **0 and 1**. SURB **2** arrived before **6**, and those are the two entries still queued. SURBs **3, 4 and 5** have not arrived.

| State | Before sending | After taking two SURBs |
| --- | --- | --- |
| Usable queue, front to back | SURB 2, SURB 6 | Empty |
| Supply receive base | 3 | 3 |
| Supply bitmap | Bit 3 is set, acknowledging sequence 6 | Bit 3 remains set |
| Exclusive supply limit | 18 | 20 |

The recipient uses 2 and 6 without waiting for 3–5. Spending 6 does not erase its receipt acknowledgement. If sequence 6 is retransmitted, the bitmap identifies it as a duplicate and prevents that already-used SURB from being enqueued again.

### Why supply snapshots exist

A creates the SURBs that B needs for reverse communication, but A cannot directly inspect B's queue. A needs two kinds of feedback: **which supplied SURBs arrived**, so it can stop retrying their delivery, and **which new SURB sequence numbers B can accept**, so replenishment does not overfill the queue.

A supply snapshot is a three-field report about the session's numbered supply:

- **Receive base** (`surbSupplyReceiveBase`): the first supply sequence not yet received. Every lower sequence is already acknowledged.
- **Receipt bitmap** (`surbSupplyAcknowledgementBitmap`): 256 bits starting at that base. Bit `i` refers to `base + i`; a set bit acknowledges a SURB received beyond a gap.
- **Exclusive supply limit** (`surbSupplyLimit`): a new SURB must have a sequence number strictly below this value. “Exclusive” means the limit itself is not allowed. The value is an absolute sequence boundary, not a queue length or a count of additional SURBs to send.

The numbered supply is shared across the session. Dedicated SURBs provided for particular responses are outside this numbered queue. A must also obey the supply receive window and account for sequence numbers it has already allocated, including supply still in flight.

### How the supply limit is maintained

Numbered supply starts at sequence zero. The recipient initializes the exclusive supply limit to its configured queue capacity:

```text
initial supply limit = recipient queue capacity
```

Accepting a supplied SURB changes receipt tracking and queue occupancy, but **does not change this limit**. Each SURB taken out of the queue for sending increases it by one:

```text
supply limit = recipient queue capacity + total SURBs taken from the ordinary queue
```

This counts removal for sending, not successful delivery. A SURB is not returned to the queue if its send fails. Dedicated response SURBs outside this queue do not affect the limit. The limit is not recomputed as capacity minus current queue length.

The **supply limit** is an exclusive sequence boundary. **Available supply slots** are the number of additional SURBs A may allocate after accounting for already allocated supply and the 256-position supply receive window:

```text
upper bound = min(reported supply limit, reported supply receive base + 256)
available supply slots = max(0, upper bound - next supply sequence)
```

In the 2-and-6 example, after those two SURBs are taken, the queue is empty and the limit is **20**. A has already allocated 0–6, so its next new sequence is **7**. With base 3, the receive-window boundary is 259 and is not restrictive here. A may allocate **7–19: thirteen new SURBs**.

Why only thirteen when the queue can hold sixteen? The outstanding SURBs **3, 4 and 5** already account for three positions and may still arrive. If those three arrive along with thirteen newly supplied SURBs, the queue holds sixteen. This accounting reserves capacity for delayed arrivals without preventing B from using the SURBs it already has.

### Why the example's bitmap has all zero bits

Initially, B has received all numbered SURBs **0–15**, filling its 16-entry queue. Its base is therefore **16**. The bitmap describes **16–271**, not 0–15. Since none of those later SURBs has arrived, every bitmap bit is zero. The bitmap is still transmitted as 32 bytes of zero bits; it is not an absent or zero-length field.

B then takes two SURBs out of the queue for reverse sending. Fourteen remain, but the receipt history has not changed: 0–15 all arrived. The base stays 16 and the bitmap stays all zero bits. This demonstrates why the bitmap must not be interpreted as a picture of the current queue.

Taking those two SURBs frees two queue slots, so the exclusive limit rises from **16 to 18**. If A has allocated only 0–15, it may now allocate **16 and 17**. Sequence 18 remains excluded. Receiving the same limit of 18 twice does not grant two more slots a second time. Permission to supply these SURBs also does not mean A must send them immediately: the watermark policy decides when to replenish.

### When supply snapshots are transmitted

B sends snapshots back to A in:

- `ConnectAck`, and reverse `StreamAck` / `StreamReject` responses.
- Ordinary reverse frames, including `Data`, `Ack`, recipient-opened `OpenStream`, and reverse teardown frames.
- `SurbStatus` replies to A's `SurbStatusProbe`.

For ordinary reverse sending, B first takes the required SURBs out of its queue, increasing the supply limit, and then attaches the snapshot to the outgoing frame. That report therefore includes the space freed for the current send. Dedicated response SURBs do not consume this ordinary queue.

There is no periodic recipient-side supply-status task that sends a report after every queue change. Receiving `SurbSupply` updates B's state and can unblock waiting reverse sends, but does not by itself trigger a standalone status reply. With active traffic, the next reverse frame carries the updated state. During reverse silence, A sends a probe with dedicated response SURBs, allowing B to answer even if its ordinary queue is empty.

### How the initiator tracks allocated supply

Each session keeps `nextSurbSupplySequence`, the next unused supply sequence number, and `pendingSurbSupply`, a table keyed by sequence number. Each pending entry retains the serialized SURB, its reply-credential identifier, and a retransmission deadline.

Before sending new supply, `registerSurbSupply` inserts these entries and advances the next sequence number. The allocation therefore reduces available supply slots immediately, without waiting for a receipt acknowledgement. The inventory estimate uses the next sequence number and the reported supply limits; it is not simply the number of pending table entries.

A received snapshot removes acknowledged entries from the pending table without moving the next sequence number backward. It also updates the reported supply base and limit. Unacknowledged entries can be retransmitted with the same sequence numbers and serialized SURBs, provided their reply credentials remain active; retries do not allocate additional supply. Acknowledging supply receipt does not retire the reply credentials themselves, because B may still use those SURBs later.

### Batching and liveness

The inventory example uses the reference defaults: capacity 16 and a low watermark of 11. Spending two SURBs at a time can move the estimate from 12 to 10. Replenishing the six available positions then takes one five-SURB supply frame and one one-SURB frame. Before deciding to send more, A counts the SURBs it has already allocated for delivery, even if they have not arrived yet. For example, after estimating ten remaining SURBs and allocating six more, A projects an inventory of sixteen; it does not allocate another six merely because their arrival has not been confirmed.

Status probes provide their own response SURBs. They recover knowledge of session supply during reverse silence; they do not tell the sender that the Data receive window has advanced if that information was lost with an ACK. The current protocol has no Data-window probe to request that missing update.

### A lost receive-window update can stall a stream

The limitation on the closing slide concerns a particular loss scenario, not ordinary loss of an unacknowledged Data frame:

1. The receiving application stops reading. Its ordered receive buffer fills, so the receive base stops advancing.
2. The sender fills the remaining receive window. The receiver retains these chunks and acknowledges them through bitmap bits, even though they cannot yet enter the ordered buffer.
3. Those acknowledgements reach the sender. It releases all retained Data copies, leaving nothing to retransmit, but its next sequence is outside the last reported receive window.
4. The application resumes reading. The receiver advances its base and sends ACK updates reporting the new window position.
5. The updates that would permit further sending are lost, including any redundant copies, and no later ACK reports the advanced base.

The sender now waits for the window to advance; the receiver has already reported that advancement and does not periodically repeat ACKs. With no unacknowledged Data left to retransmit, duplicates do not trigger another ACK either. The stream can therefore remain stalled even after packet delivery resumes. This is a potential failure path identified from the current state machines, not a claim that a specific experiment reproduced it.

`SurbStatusProbe` does not resolve this condition: its response reports session-wide SURB supply, not the stream's Data receive base and bitmap. A Data-window probe could provide a way for a blocked sender to ask for that information, but no such mechanism is currently implemented.

The separate live note [[MixTransport - Receive Window Recovery Follow-up]] tracks reproduction and recovery design.

### Mix API connections

The relevant slides identify the Mix primitives used at the boundary:

- `createSurb` creates a SURB and its associated local reply credential.
- `serializeSurb` and `deserializeSurb` let MixTransport carry SURBs in its frames and manage its own inventory.
- Forward `send` delivers to the destination; `sendWithSurb` uses a supplied return path.
- The raw-reply callback and `recoverReply` let MixTransport select its own credential and recover the reverse transport frame.

For full signatures, ownership rules and the specific API additions, see [[Mix Protocol API Changes for MixTransport]] and [[MixTransport to Mix Protocol Boundary Flow]].

## Scope and sources

The slides describe the current implementation, not an alternative wire protocol. Numerical examples use its current packet profile and reference defaults; configurable policy values should not be read as universal protocol requirements.

- [[Mix Transport Design Specification]]
- [MixTransport source at `653bcd6`](https://github.com/logos-storage/libp2p-mix-transport/tree/653bcd6d8c2a74b72b7207723938c643416670a0/libp2p_mix_transport)
- [Mix protocol source at `0883587`](https://github.com/logos-co/nim-libp2p-mix/blob/0883587f1f0d7fc6745e8db00fcd0cb0938d7dd0/libp2p_mix/mix_protocol.nim)
