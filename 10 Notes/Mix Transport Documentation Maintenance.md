---
related:
  - "[[Mix Transport Design Specification]]"
  - "[[Mix Transport Implementation Walk Through]]"
  - "[[Mix Transport Logos Storage Integration - Validation and Open Questions]]"
  - "[[BlockExchange Mix Integration - Behavioral Changes and Experiments]]"
  - "[[Mix Transport Documentation Archive]]"
---
# Mix Transport Documentation Maintenance

## Reference baseline — 24 September 2026

The current-state documentation is aligned to MixTransport branch feat/mix-transport at edd2423 and Storage master at a7f557e6. Storage's vendored transport is the same revision. The concurrent-SURB-copy experiment is not this baseline: reverse copies are submitted sequentially here.

The documentation pass checks source definitions, frame validation, routing, state transitions and Storage integration against these revisions. It does not represent a new test-suite run, benchmark or formal protocol audit. The design specification is a description of the implemented version with normative framing rules, not evidence that every implementation path satisfies a formal proof.

## Document roles

- [[Mix Transport Design Specification]] describes the protocol, bounds, failure behavior and local defaults.
- [[Mix Transport Implementation Walk Through]] indexes current code walkthroughs; these retain contextual snippets rather than implementation chronology.
- [[Mix Transport Logos Storage Integration - Download Transport Selection]] follows the current Storage consumer. Its repository counterpart is docs/mix-downloads.md.
- [[BlockExchange Mix Integration - Behavioral Changes and Experiments]] is deliberately historical: before/after policy comparisons and the reasons for accepting or isolating changes belong there.
- [[Mix Transport Logos Storage Integration Plan]], [[Mix Transport Logos Storage Integration Example]], and the older MixMode/runtime-forwarding design notes preserve superseded designs. Their snippets are not current setup guidance.
- [[Mix Transport Documentation Archive]] retains validation descriptions and proposals removed from current walkthroughs. Those records are dated by their originating development work and have not been revalidated in this pass.
- [[Mix Transport Logos Storage Integration - Validation and Open Questions]] and experiment-run notes retain operational observations. Harness instructions remain paired with their repository README rather than being rewritten as a protocol specification.

## Current limits requiring separate design work

The specification states these limits rather than promising mechanisms that are absent:

- Connect and OpenStream are not retried; duplicate openings are discarded rather than re-acknowledged.
- Data retries use a fixed interval without an attempt limit. Failed ACK submission ends the ACK task, and no Data-window persist probe repairs a lost final credit update after all retained Data is acknowledged.
- Expired reply credentials prevent supply retransmission, but no exchange explicitly abandons a missing supply sequence to advance the receipt window.
- Teardown notifications are best effort. Local close is not a reliable flush of unacknowledged Data or a negotiated half-close.
- Per-stream and SURB state are bounded, but there is no global runtime session-count limit.
- Storage's recipient-side drop path can remove BlockExchange peer state without a retained session handle to reset the underlying session.
- Provider-priority tracking replaces its set from the latest matching discovery result. It is not an accumulated, bounded and aged provider pool. Default Direct and Mix policies do not use it.

This list records boundaries; it is not an implementation plan or authorization to change the release candidate.

## Integration follow-up context

Keep the AutoNAT/final-address mapper ordering discussion, provider-record freshness and packet sizing, legacy DHT-over-Mix failures, CacheStore duplicate-accounting observation, and high-concurrency harness stalls in the existing live/history notes. None is declared fixed by editing documentation. The Storage integration does not change discovery privacy automatically, and using Mix for transfer does not by itself prevent direct serving or provider announcements.

## Maintaining the distinction

When behavior changes, update the specification and affected walkthroughs together. Introduce roles, data structures and callers before using their names, label abbreviated excerpts, and retain enough repeated context to make an individual walkthrough readable. Record experiments, validation outcomes and proposed alternatives here or in a linked live/history note rather than appending development status to current-reference sections.
