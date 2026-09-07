---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through]]"
  - "[[Mix Transport Implementation Walk Through - Bounded Data Flow]]"
  - "[[Mix Transport Implementation Walk Through - SURB Replenishment]]"
  - "[[Mix Transport Implementation Walk Through - Connect Handshake]]"
  - "[[Mix Transport Implementation Walk Through - Reply Credential Store]]"
  - "[[Mix Transport Implementation Walk Through - Session Registry]]"
  - "[[Mix Transport Implementation Walk Through - Stream Establishment Round Trip]]"
---
This note explains how MixTransport maintains the return paths that a session recipient needs to communicate with an anonymous session initiator. [[Mix Transport Implementation Walk Through - SURB Replenishment]] maps the design to the corresponding types and procedures.

The replenishment protocol uses an initiator-driven push model. The recipient reports which SURBs arrived and how much queue capacity remains. The initiator records every report, but does not send replacements whenever one or two queue positions become free. Replenishment starts when the initiator estimates that the recipient's usable supply has reached a configured low watermark. The initiator then restores the projected inventory to capacity in batches. The recipient never requests a quantity of SURBs and does not maintain a separate refill transaction.

## Communication Directions and Session Roles

A MixTransport session has an initiator and a recipient. The initiator creates the session by sending `Connect` to the recipient's real Mix destination. The recipient learns the session pseudonym carried by `Connect`, but the recipient does not learn an address through which it could send an ordinary Mix packet back to the anonymous initiator.

This document calls a packet from the initiator to the recipient a forward packet. The initiator can create a forward packet whenever it knows the recipient's Mix destination. A packet from the recipient back to the initiator is a reverse packet. The recipient can send a reverse packet only through a single-use reply block, or SURB, previously created by the initiator.

Creating a SURB produces two related values. The public SURB gives the recipient a one-use mechanism for sending one encrypted reply. The corresponding private reply credential remains with the initiator and is required to recover the payload when the returned packet arrives. The initiator must therefore create return paths before the recipient can send anything in the reverse direction.

## The Session-Wide SURB Queue

The recipient keeps available public SURBs in one bounded queue owned by the recipient-side transport session. A reverse stream frame identifies its stream, so any SURB in this queue can carry traffic for any stream belonging to the session. The queue can also carry session-level control frames.

One session-wide queue prevents SURBs from becoming stranded in an idle stream while another stream needs a return path. Closing one stream also does not discard SURBs that remain useful to other streams in the same session.

When the recipient sends one reverse frame, it removes several individual SURBs from the queue and sends the same encoded frame through each selected SURB. This temporary collection is a redundancy batch. The current policy selects two SURBs, giving the logical frame two independent opportunities to reach the initiator.

The redundancy batch exists only for the duration of that send operation. Neither the queue nor the wire format stores persistent SURB groups. A later policy can therefore choose a different redundancy count for a particular session, stream or frame kind without changing how individual SURBs are supplied and acknowledged.

## Establishing Supply During Handshakes

The initial `Connect` handshake carries as many SURBs as its encoded transport frame can hold. The first SURBs form the response redundancy batch. With the current redundancy policy, the recipient uses the first two SURBs for `ConnectAck`.

Any remaining SURBs are numbered session supply. The recipient processes these SURBs with the same sequence and capacity rules used for a standalone `SurbSupply` frame. Handshake framing therefore uses otherwise padded Sphinx payload space without introducing a second kind of persistent SURB storage.

With the current Sphinx and MixTransport encoding, a `Connect` frame can carry five SURBs. Two carry redundant copies of `ConnectAck`, while the remaining three enter the recipient's session queue with supply sequences zero, one and two. The recipient's configured queue capacity must be large enough to hold this bootstrap supply. The current default capacity is sixteen.

`ConnectAck` reports that the first three numbered SURBs arrived and advertises the recipient's absolute supply limit. For a capacity of sixteen, the snapshot contains a supply receive base of three and a supply limit of sixteen. The initiator can then send sequences three through fifteen to fill the remaining thirteen queue positions.

An `OpenStream` frame also uses all of its guaranteed SURB capacity. The first two SURBs are unnumbered and dedicated to `StreamAck` or `StreamReject`. Any remaining positions carry numbered supply for the session-wide queue. Because `OpenStream` must be sent regardless, attaching these additional SURBs uses space in an existing Sphinx packet and can avoid a later standalone `SurbSupply` packet.

The guaranteed `OpenStream` capacity is calculated for the maximum permitted codec length rather than the codec supplied by one particular call. Consequently, every valid codec gives `OpenStream` the same SURB layout. The current maximum-length frame holds four SURBs: two response paths and two numbered supply entries.

## Bounding Supply with Absolute Credit

The initiator can create SURBs faster than the recipient can consume them. Allowing every arriving SURB to remain in memory would let the recipient's queue grow without limit. MixTransport therefore configures a maximum number of SURBs that the recipient may retain. The current default is sixteen.

The recipient expresses available capacity through an absolute supply limit. Every supplied SURB has a monotonically increasing sequence number. A limit of sixteen authorizes sequence numbers below sixteen; repeating the same limit grants no additional permission.

Whenever the recipient removes SURBs from its queue for a reverse transmission, the same number of queue positions become free. The recipient increases the absolute limit by that number. The initiator can then assign the newly authorized sequence numbers to replacement SURBs.

Absolute credit remains safe when snapshots are duplicated, delayed or reordered. A duplicate limit does not grant capacity twice, and the initiator never moves its stored receive base or limit backwards when an older snapshot arrives.

## Recording Received Supply

The recipient must distinguish a new SURB from a retransmission of one it has already stored or consumed. The recipient records the first sequence number not covered by a contiguous prefix of received supply. This number is the supply receive base. A fixed bitmap records later sequences that arrived beyond a gap.

Suppose the receive base is ten. If sequences ten and twelve arrive while sequence eleven is missing, the bitmap records both arrivals. Receiving sequence ten advances the base to eleven, while the shifted bitmap continues recording that sequence twelve has already arrived.

The bitmap covers 256 sequence positions beginning at the receive base. The recipient accepts a supplied SURB only when its sequence is inside this window, is below the absolute supply limit, has not been recorded before, and the queue still has physical capacity. These checks bound both stored SURBs and the state needed to remember out-of-order arrivals.

Receiving a SURB and consuming that SURB are separate events. Removing a SURB from the queue does not erase the sequence record showing that the SURB arrived. A retransmitted copy can therefore be recognized as a duplicate even after the first copy has been used.

Each serialized SURB is decoded independently. If one entry in a handshake or `SurbSupply` frame is malformed, the recipient retains other valid entries and leaves a gap at the malformed entry's sequence. Retransmission can later fill that gap.

## Reporting Supply State

The initiator needs to know which numbered SURBs arrived and how many new SURBs the recipient can accept. The recipient reports both facts in one absolute supply snapshot containing:

- the supply receive base;
- the fixed acknowledgement bitmap;
- the absolute supply limit.

`ConnectAck` carries the initial snapshot. Later reverse Data, ACK, `StreamAck`, `StreamReject` and `SurbStatus` frames carry the recipient's latest snapshot. All three values travel together so the initiator applies receipt information and the corresponding capacity information as one state update.

When a snapshot acknowledges a numbered SURB, the initiator removes that SURB's public serialization from retransmission state. The initiator retains the corresponding private reply credential because the recipient may still hold and later use the public SURB.

## Initiator-Driven Replenishment

After recovering `ConnectAck`, the initiator starts one supplier task owned by the transport session. The task compares the next unused supply sequence with the latest absolute limit reported by the recipient. The difference tells the initiator how many queue positions have been authorized but have not yet been assigned numbered SURBs.

The initiator converts this unfilled capacity into a projected recipient inventory. The projection starts with the capacity learned from `ConnectAck` and subtracts the number of unfilled positions. Numbered SURBs already assigned by the initiator count toward the projection even while they remain in flight. A lost assigned SURB is handled by retransmission; treating the same position as new capacity would create a second SURB and break the absolute-credit model.

The default recipient capacity is sixteen. A dedicated `SurbSupply` frame holds five SURBs, so the default low watermark is eleven: one full supply packet below capacity. A reverse frame that consumes two SURBs changes the projected inventory from sixteen to fourteen. The supplier records the new snapshot but sends nothing. Once subsequent reverse activity reduces the projection to eleven or less, the supplier begins a replenishment cycle.

A replenishment cycle continues until every currently authorized position has been assigned a numbered SURB. With the default capacity and watermark, reaching eleven makes five positions available, so the initiator normally restores the projected inventory to sixteen with one full `SurbSupply` packet. The supplier still retains an explicit active-cycle state because custom capacities and watermarks can require more than one packet. In that case, crossing above the watermark after the first packet does not stop the cycle before capacity has been restored.

Before sending a public SURB, the initiator registers its private credential and retains the public serialization under the assigned sequence number. Installing this state before the asynchronous send ensures that a fast returned packet cannot refer to a credential that the initiator has not registered yet.

Every applicable reverse snapshot wakes the supplier when receipt state or capacity advances. The supplier updates the projection and begins a new cycle only at or below the low watermark. When the snapshot acknowledges receipt of supplied sequences, the initiator stops retaining their public serializations for retransmission.

Replenishment is always enabled. MixTransport has no pull-only mode because a recipient that has exhausted its queue cannot reliably initiate a refill. The recipient communicates demand by reporting its absolute state; the initiator remains responsible for acting on that state.

## Waiting for Return Capacity

A recipient-side Data, ACK or other ordinary reverse frame needs one complete redundancy batch. If fewer than two SURBs are available under the current policy, the sending operation waits on the session's SURB-capacity event. Arrival of additional numbered supply wakes the operation, which checks the queue again before removing its response paths.

No SURBs are reserved exclusively for control traffic. The queue therefore has no distinction between reserved and unreserved SURBs, and its capacity is not derived from a separate control reserve.

The queue must still be capable of holding a complete ordinary redundancy batch. In addition, the production transport configuration must accommodate the numbered bootstrap supply carried by `Connect`. These constraints are consequences of the selected redundancy and handshake policies rather than a separate control-reserve policy.

## Retransmitting Numbered Supply

A forward packet containing numbered supply may be lost. Until the recipient acknowledges a sequence, the initiator retains the serialized public SURB and assigns it a retransmission deadline. The default deadline is thirty seconds after the previous send attempt.

The retained entry also records the identifier of the corresponding private reply credential. Before retransmission, the initiator purges expired credentials and verifies that the selected credential remains active. If the credential has expired or has already been consumed, the initiator removes the retained public serialization instead of sending a SURB whose eventual reply could no longer be recovered.

If the credential remains active, the initiator retransmits the same public serialization with the same sequence number. Retransmission creates neither a new SURB nor a new credential and does not extend the original credential lifetime.

If both the original and retransmitted copies reach the recipient, sequence tracking causes one copy to enter the queue and the other to be ignored. If an acknowledgement arrives while retransmission is being submitted, completion of the send does not recreate the acknowledged entry.

## Recovering Stale Supply State

Ordinary reverse frames normally keep the initiator's view current. A failure remains possible when the recipient consumes SURBs but every reverse copy carrying the new snapshot is lost. The recipient may then wait for new supply while the initiator still believes that no additional sequence numbers are authorized.

The initiator detects this condition through the absence of valid reverse activity. After the configured inactivity period, the initiator sends `SurbStatusProbe` through the forward path. The probe carries a fresh dedicated response redundancy batch and does not depend on SURBs stored in the recipient's session queue.

The recipient answers with `SurbStatus` even when no application data is waiting. `SurbStatus` contains the recipient's current absolute supply snapshot. Its dedicated response SURBs are used immediately and never enter the session queue or its numbered sequence space.

Any valid reverse frame carrying an applicable supply snapshot proves that the session can still return traffic. Such a frame resets the unanswered-probe counter and schedules the next inactivity deadline; the frame does not have to be `SurbStatus` specifically.

If no valid reverse frame arrives, the initiator repeats the probe after a configurable retry interval. Every attempt contains fresh response SURBs because the initiator cannot determine whether an earlier forward probe or its reverse response was lost. The maximum number of attempts is configurable.

After sending the final permitted probe, the initiator waits for one complete retry interval. Continued silence then fails the affected transport session. Session failure closes its streams, wakes operations waiting for SURBs, stops session-owned tasks, and removes the session's reply credentials. The failure does not stop unrelated sessions or the surrounding `MixTransport` instance.

## Session Lifetime

The supplier task, recipient queue, supply sequence state and registered streams share the lifetime of one transport session. Session shutdown cancels and awaits the supplier task, closes the session's streams and removes reply credentials associated with the session.

A new anonymous session begins with a new pseudonym, an empty recipient queue and a new supply sequence space. Receipt acknowledgements and credit from an earlier session cannot be applied to the new session.

## Resulting Safety and Liveness Properties

- The recipient never retains more SURBs than its configured session-queue capacity.
- `Connect` and `OpenStream` use their guaranteed payload space for immediate response paths followed by numbered session supply.
- Every persistent supplied SURB participates in the same sequence, credit, acknowledgement and retransmission protocol.
- The initiator cannot introduce new numbered SURBs beyond the recipient's absolute credit or the fixed receive window.
- Releasing one redundancy batch does not immediately produce a partially filled `SurbSupply` frame; replenishment begins at the configured low watermark and continues to the advertised capacity.
- Retransmitting a supplied SURB does not create another private credential.
- The recipient stores at most one copy of a numbered SURB, including after the original copy has been consumed.
- A malformed supplied SURB does not prevent other valid supplied SURBs in the same frame from being accepted.
- A recipient without stored SURBs can still report its state through response paths carried by `SurbStatusProbe`.
- Repeated absence of valid reverse activity produces a bounded session failure instead of an indefinite wait.
