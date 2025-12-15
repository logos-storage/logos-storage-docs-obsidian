---
related-to:
  - "[[testing codex-status-go integration]]"
  - "[[Running Unit Tests for status-go]]"
  - "[[Running functional tests in status-go]]"
---
The easiest way:

```bash
make lint
```

And the detailed manual commands:

```bash
golangci-lint --build-tags 'gowaku_no_rln lint' run ./...
```

and:

```bash
make lint-panics
```
