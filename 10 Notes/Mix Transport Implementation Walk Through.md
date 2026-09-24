---
related:
  - "[[Mix Transport Design Specification]]"
---

# Mix Transport Implementation Walk Through

These notes explain the current implementation with contextual code excerpts. Start with [[Mix Transport Design Specification]] for the protocol contract, then follow the sequence below. Test reports, implementation milestones and open review items live separately in [[Mix Transport Documentation Maintenance]].

## Frames, sessions and streams

- [[Mix Transport Implementation Walk Through - Wire Format Foundation]]
- [[Mix Transport Implementation Walk Through - Reply Credential Store]]
- [[Mix Transport Implementation Walk Through - Session Registry]]
- [[Mix Transport Implementation Walk Through - Connect Handshake]]
- [[Mix Transport Implementation Walk Through - Concurrent Connect and Test Injection]]
- [[Mix Transport Implementation Walk Through - Virtual Stream Registry]]
- [[Mix Transport Implementation Walk Through - Stream Establishment Round Trip]]
- [[Mix Transport Implementation Walk Through - Recipient-Originated Streams]]
- [[Mix Transport Implementation Walk Through - Application Connection and Protocol Dispatch]]
- [[Mix Transport Implementation Walk Through - Bounded Data Flow]]
- [[Mix Transport Implementation Walk Through - SURB Replenishment]]
- [[Mix Transport Implementation Walk Through - Remote Teardown]]
- [[Mix Transport Implementation Walk Through - Session Lifecycle Events]]
- [[Mix Transport SURB Replenishment Strategy]]

## Storage integration

- [[Mix Transport Block Exchange Integration - Session Events]]
- [[Mix Transport Logos Storage Integration - Download Transport Selection]]
- [[Mix Discovery through Provider Records]]

## Decisions and experiments

[[BlockExchange Mix Integration - Behavioral Changes and Experiments]] preserves the Direct-versus-Mix policy review. [[Mix Transport Logos Storage Integration Plan]] and [[Mix Transport Logos Storage Integration Example]] are historical records, not current setup instructions.
