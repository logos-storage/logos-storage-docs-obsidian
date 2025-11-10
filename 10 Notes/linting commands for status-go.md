---
related-to:
  - "[[testing codex-status-go integration]]"
  - "[[Running Unit Tests for status-go]]"
  - "[[Running functional tests in status-go]]"
---
Here are two commands you should use before pushing:

```bash
golangci-lint run --build-tags=gowaku_no_rln
```

and:

```bash
make lint-panics
```
