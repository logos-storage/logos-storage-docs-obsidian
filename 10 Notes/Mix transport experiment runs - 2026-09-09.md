# Mix transport experiment runs - 2026-09-09

Related: [[Mix transport measurement harness]]

This note records the MixTransport harness runs performed on 9 September 2026. The purpose is to preserve which configurations completed, which configuration failed, and which output directories should be used when the high-delay failure is investigated.

## Result interpretation

The harness appends a CSV row whenever the timed `curl` process terminates. A CSV row therefore does not by itself prove that a transfer succeeded. A successful transfer must also end with `ok` in the corresponding file under `<run-directory>/logs/transfers/`.

This distinction matters for interrupted and failed runs. When the experiment is stopped, the outstanding `curl` processes terminate and their elapsed times are still appended to the CSV. Those rows describe how long the requests existed before teardown; they are not successful transfer measurements.

## Preliminary smoke tests

The initial six-node smoke test completed all of the following operations without network emulation:

- A 4 KiB direct libp2p transfer completed in 0.379 seconds.
- A 4 KiB MixTransport transfer completed in 3.265 seconds.
- A second 1 MiB MixTransport transfer between the same nodes completed in 1.796 seconds, exercising session reuse and another stream.
- Two concurrent 256 KiB MixTransport transfers between another pair of nodes completed in 0.813 and 0.870 seconds.

A separate `wired-lossy` smoke test used six nodes, three sequential 256 KiB MixTransport transfers, and concurrency one. All three transfers completed. The measurements are stored in:

```text
tools/experiments/multitransfer/output/20260909043648-30548
```

## Completed full-sweep configurations

The full sweep defines 18 configurations, each containing 500 transfers. Six configurations completed before the first failure stopped the sweep:

| Nodes | Concurrency | Mix delay | Network profile | Successful transfers | Mean | Maximum |
| ---: | ---: | --- | --- | ---: | ---: | ---: |
| 100 | 20 | default | none | 500/500 | 4.520 s | 11.189 s |
| 100 | 20 | exponential | none | 500/500 | 12.343 s | 28.436 s |
| 100 | 80 | default | none | 500/500 | 18.415 s | 34.481 s |
| 100 | 80 | exponential | none | 500/500 | 20.651 s | 38.711 s |
| 100 | 80 | default | wired | 500/500 | 19.788 s | 42.290 s |
| 100 | 80 | default | wired-lossy | 500/500 | 20.601 s | 46.072 s |

These six runs are stored under `tools/experiments/multitransfer/output/`, with run identifiers from `20260909052744-1956` through `20260909054221-23875`.

## Failed full-sweep configuration

The next full-sweep configuration was:

```text
nodes:           100
transfers:       500
concurrency:     80
transfer size:   1,000,000 bytes
Mix delay:       default
network profile: hi-delay-jittery
```

One request failed with `MixTransport connect timed out`. Because the experiment script uses fail-fast Bash execution, that failure initiated teardown while the other requests were still running. The resulting `Empty reply from server` messages were consequences of node teardown and must not be counted as separate transport failures.

The run directory is:

```text
tools/experiments/multitransfer/output/20260909054447-13173
```

The CSV from this run is incomplete and contains rows produced during failure cleanup. The CSV must not be included in aggregate performance analysis.

## Targeted high-delay diagnostics

### Concurrency 20

The first diagnostic reduced the workload to 100 transfers while preserving 100 nodes, 1 MB transfers, the default Mix delay, and the `hi-delay-jittery` network profile. It used concurrency 20.

All 100 transfers completed:

| Minimum | Median | Mean | Maximum |
| ---: | ---: | ---: | ---: |
| 28.740 s | 40.063 s | 63.617 s | 195.592 s |

The run directory is:

```text
tools/experiments/multitransfer/diagnostics/20260909110409-19155
```

This result shows that the high-delay profile does not fail by itself at the lower concurrency, although it produces a substantial latency tail.

### Concurrency 80

The second diagnostic used the same 100-node, 100-transfer, 1 MB, default-delay and `hi-delay-jittery` configuration, but increased concurrency to 80.

The run made progress normally at first. After 89 successful transfers, the remaining 11 requests stopped completing. The experiment was manually interrupted with `Ctrl-C` after approximately six additional minutes without another success.

The 11 requests then reported `curl: (52) Empty reply from server` at the same time because teardown stopped the nodes. These messages do not indicate 11 independent HTTP failures. Before teardown, the corresponding node logs show that several affected requests had already established their MixTransport streams and entered the data-transfer path. The investigation should therefore consider ACK progress, retransmission, SURB availability, and forward-path delivery under sustained concurrency rather than only connection establishment.

The run directory is:

```text
tools/experiments/multitransfer/diagnostics/20260909111357-14148
```

The CSV contains 100 rows, but only the first 89 correspond to successful transfers. The final 11 rows contain the durations of requests terminated by `Ctrl-C` and must be excluded from performance calculations. Among the 89 successful transfers, the minimum was 99.040 seconds, the median was 220.334 seconds, the mean was 206.506 seconds, and the maximum was 300.282 seconds.

## Remaining full-sweep configurations

The original sweep completed 6 of its 18 configurations. Twelve configurations remain incomplete:

- The 100-node, concurrency-80, default-delay, `hi-delay-jittery` configuration must be rerun after the failure is understood. The 100-transfer diagnostic is not a substitute for its intended 500 transfers.
- The 100-node, concurrency-80, default-delay, `hi-delay-jittery-lossy` configuration has not run.
- All ten 200-node configurations have not run: concurrency 20 with both delay strategies, concurrency 40 with both delay strategies, and concurrency 160 with both delay strategies plus the four emulated-network profiles used by the default delay.

The full sweep should not be resumed yet. First, the harness should apply a bounded timeout to each transfer and record success or failure explicitly. Then the concurrency-80 high-delay configuration can fail cleanly without invalidating the remaining measurements or waiting indefinitely.

