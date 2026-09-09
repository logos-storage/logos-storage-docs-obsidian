> [!info] Canonical source
> This note mirrors `tools/README-MC.md` from the `libp2p-mix-transport` repository. Keep the explanatory content and commands synchronized with that repository file when the harness changes.

This guide explains how to run the standalone Mix transport experiments, how the harness constructs its network, how Linux `tc netem` changes that network, and how the R Markdown files turn experiment output into tables and plots.

The harness has three distinct parts:

1. A standalone Nim node provides a small request/response protocol over direct libp2p streams and over `MixTransport` streams.
2. Bash scripts start many node processes, request transfers, measure completion time, and optionally configure Linux network emulation.
3. R Markdown notebooks read the generated CSV and JSON files and produce analysis reports. R is not involved in running the nodes or collecting measurements.

## What the harness measures

Every node mounts `/test/simple-transfer/1.0.0`. A client sends a request containing a byte count and a pseudorandom-number-generator seed. The remote node regenerates the requested bytes from the seed and writes them to the stream. The client regenerates the same byte sequence while reading and fails the request if any byte differs.

The experiment therefore measures a complete operation:

```text
HTTP request sent to source node
  -> source opens a direct or MixTransport stream
  -> source sends TransferRequest
  -> destination sends TransferResponse
  -> destination streams the requested pseudorandom bytes
  -> source receives and validates every byte
  -> source closes the stream
  -> HTTP request returns successfully
```

The HTTP `POST /request` call does not return when the transfer merely starts. The HTTP response is sent only after all bytes have arrived and passed validation. Measuring the wall-clock duration of the `curl` command therefore measures the complete transfer as observed by the client of the source node.

The same workload can use two paths:

- A request containing `peerId` calls `mixTransport.dial(peerId, TransferCodec)` and transfers the bytes over Mix.
- A request containing `address` connects and dials directly through libp2p. This path provides a non-Mix baseline.

## What kind of network is created

The harness starts independent node processes on different addresses in the IPv4 loopback range:

```text
node 0: 127.0.0.1, API port 8000, libp2p port 9000
node 1: 127.0.0.2, API port 8000, libp2p port 9000
node 2: 127.0.0.3, API port 8000, libp2p port 9000
...
```

Using a different loopback address for every process allows every node to use the same two port numbers. The processes still establish real TCP, Noise, Mplex, Mix and MixTransport connections; only the physical network is replaced by the host's loopback interface.

Nodes start sequentially. When node `i` starts, the harness gives node `i` the API URLs of nodes `0` through `i - 1`. Node `i` calls `/status` on those nodes and inserts their `MixPubInfo` values into its Mix node pool. The harness does not run service discovery.

Consequently, knowledge is intentionally asymmetric:

```text
node 0 knows no earlier nodes
node 1 knows node 0
node 2 knows nodes 0 and 1
node 3 knows nodes 0, 1 and 2
```

The current Mix path length is three. A source node must know enough earlier nodes to select the path and destination, so Mix experiments choose two node indices from `3 ..< nodeCount` and make the larger index the source. At least five nodes are needed to obtain two distinct indices from that range.

This setup is deliberately simple. The harness does not simulate separate physical links or a geographic topology. All node processes share the same CPU, the same host kernel, and the same emulated loopback interface. A configured bandwidth limit is therefore shared across the experiment rather than applied separately to every node pair.

## Requirements

Running the nodes requires:

- Bash 5; the scripts use `EPOCHREALTIME` and `wait -n`.
- `curl`, `jq` and `shuf`.
- Nim 2.2.4 or newer, Nimble, and the repository dependencies.

Network emulation additionally requires Linux and:

- `ip` and `tc` from `iproute2`.
- `sudo`, because the scripts create and configure a network namespace.
- `iperf3` and `ss` only when running the emulation sanity test.

Rendering the analysis notebooks additionally requires R. The R environment is independent of the Nim and Bash runtime.

## Build the standalone node

From the repository root, install dependencies and build the release node:

```bash
make setup NIMBLE_FLAGS="-y"
nimble node
```

The resulting executable is:

```text
tools/node/node
```

For message-level analysis, build the variant that writes Chronicles events as JSON:

```bash
nimble debugNode
```

The debug executable is:

```text
tools/node/node-debug
```

Despite the task name, `debugNode` still enables Nim's release build. The important difference is `-d:chronicles_sinks=json`, which changes the log representation to structured JSON.

The harness uses `tools/node/node` by default. To run the debug executable, set `TR_NODE_BINARY` before sourcing the harness:

```bash
export TR_NODE_BINARY="$PWD/tools/node/node-debug"
source tools/harness/harness.bash
```

Set the variable while the repository root is the current directory so that `$PWD/tools/node/node-debug` resolves to the built executable. Setting `TR_NODE_BINARY` before sourcing is important for network-emulated experiments because the harness records the configured path in `TR_ENV` and passes `TR_ENV` into the network namespace.

If the harness has already been sourced in the current shell, update the variable and reload the harness configuration:

```bash
export TR_NODE_BINARY="$PWD/tools/node/node-debug"
reload
```

## First experiment without network emulation

The smallest useful interactive session is:

```bash
# Omit this export when using the normal tools/node/node executable.
export TR_NODE_BINARY="$PWD/tools/node/node-debug"
source tools/harness/harness.bash
tr_init
tr_start_network 5
tr_list_nodes
tr_transfer_mix 4 3 1000000
tr_transfer_regular 4 3 1000000
tr_kill_nodes
```

The operations perform the following work:

- `source tools/harness/harness.bash` loads configuration, node-control functions, transfer functions and network-emulation functions into the current shell.
- `tr_init` creates a new output directory, resets the harness's node table, and creates the transfer-measurement CSV.
- `tr_start_network 5` starts nodes 0 through 4 and waits for every node's `/status` response to report `running: true`.
- `tr_transfer_mix 4 3 1000000` asks node 4 to retrieve 1,000,000 bytes from node 3 through MixTransport.
- `tr_transfer_regular 4 3 1000000` runs the same workload over a direct libp2p connection.
- `tr_kill_nodes` stops all node processes started by the harness.

When `harness.bash` is sourced by a non-interactive experiment script, the harness installs an `EXIT` trap that stops its nodes. When `harness.bash` is sourced from an interactive prompt, the harness leaves the caller's shell options unchanged and does not install that trap because the shell may remain open for a long time. Run `tr_kill_nodes` explicitly after interactive experiments.

## Harness configuration

Configuration uses environment variables whose names begin with `TR_`. Set overrides before sourcing `harness.bash`, because `config.bash` computes derived paths while the library is loaded:

```bash
export TR_NODE_BINARY="$PWD/tools/node/node-debug"
export TR_LOG_LEVEL='INFO;trace:mix-transport-messages'
export TR_BASE="$PWD/my-experiment-output"
source tools/harness/harness.bash
```

The principal variables are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TR_NODE_BINARY` | `tools/node/node` | Executable started for every node |
| `TR_BASE` | `experiment-output` | Parent directory for measurements and run files |
| `TR_LOG_LEVEL` | `INFO` | Chronicles log level and optional topic directives |
| `TR_API_PORT` | `8000` | HTTP control API port on every node address |
| `TR_LISTEN_PORT` | `9000` | libp2p TCP port on every node address |
| `TR_RUN_ID` | timestamp plus random suffix | Identifier distinguishing one run |
| `TR_RUNTIME_FOLDER` | `$TR_BASE/$TR_RUN_ID` | Logs and other files for one run |

The harness exports these values and records them in `TR_ENV`. `emu_enter` uses `TR_ENV` to reproduce the same configuration inside the network namespace.

An experiment can add constant columns to every CSV row before calling `tr_init`:

```bash
tr_field strategy exponential
tr_field scenario wired-lossy
tr_init
```

`TR_FIELDS` is a Bash associative array, so additional column order is not stable. Analysis code must select columns by header name.

## The standalone node API

Every node exposes two HTTP endpoints.

### `GET /status`

`/status` reports readiness and the node's public Mix descriptor:

```json
{
  "mixInfo": {
    "peerId": "<base64>",
    "multiAddr": "/ip4/127.0.0.4/tcp/9000",
    "mixPubKey": "<base64>",
    "libp2pPubKey": "<base64>"
  },
  "running": true
}
```

The command `tr_status 3` retrieves and formats this document. `tr_peer_id 3` returns only the peer ID.

### `POST /request`

A Mix request identifies the destination by peer ID:

```json
{"peerId":"<base64-peer-id>","size":1000000}
```

A direct request identifies the destination by multiaddress:

```json
{"address":"/ip4/127.0.0.4/tcp/9000/","size":1000000}
```

`size` is encoded as an `int32` in `TransferRequest`, so experiment sizes must remain within the positive `int32` range. The server produces the data in chunks, while the receiving side validates the pseudorandom stream incrementally rather than retaining the complete transfer in memory.

## Mix delay strategies

The command-line option is named `--mix-config`, and the multitransfer script calls the corresponding argument the Mix delay strategy. The available values are `default` and `exponential`.

These strategies control how long an intermediate Mix relay holds a Sphinx packet before forwarding the packet to the next hop. Mix packet delay is separate from `netem`: the Mix strategy introduces an intentional protocol-level hold inside relay processes, whereas `netem` delays or drops IP packets in the kernel.

The harness maps `default` to `NoSamplingDelayStrategy`. When the sender constructs a Sphinx path, `NoSamplingDelayStrategy.generateForEntry` chooses one concrete delay from 0, 1 or 2 milliseconds for each intermediate relay. The chosen delay is encrypted into the Sphinx routing information. Each intermediate relay decrypts its delay and uses that value directly:

```nim
method generateForEntry*(self: NoSamplingDelayStrategy): Delay =
  self.rng.generate(uint16) mod 3

method generateForIntermediate*(
    self: NoSamplingDelayStrategy, encodedDelay: Delay
): Delay =
  encodedDelay
```

The `default` preset therefore adds almost no intentional Mix latency. The preset is useful as a functional and performance baseline, but the 0–2 ms delays provide little protection against an observer correlating packet timing across relays.

The harness maps `exponential` to `ExponentialDelayStrategy` with its constructor defaults. The sender encodes a mean delay of 100 milliseconds for each intermediate relay:

```nim
const DefaultMeanDelay*: Delay = 100

method generateForEntry*(self: ExponentialDelayStrategy): Delay =
  self.meanDelay
```

The encoded value is not the relay's exact holding time. Each intermediate relay independently samples an actual delay from an exponential distribution whose mean is the encoded value. The implementation truncates the extreme tail when its remaining probability falls below `1e-6`. With a 100 ms mean, the practical upper bound is approximately 1,381 ms. The ordinary exponential preset has a minimum of zero.

Exponential sampling produces many short delays and progressively fewer long delays. Independent sampling makes packet departure times less directly correlated with packet arrival times, which is the reason the Mix implementation describes exponential delay as the recommended strategy.

The current Sphinx path contains three Mix nodes. The exit node receives `NoDelay`, so the intentional delay is applied by the two intermediate forwarding nodes. Ignoring network and processing time, one forward packet therefore accumulates approximately 200 ms of expected intentional delay with the exponential preset, compared with approximately 2 ms total expected delay under the default preset. A request and its reply traverse separate paths and can accumulate these delays in both directions.

Select the preset when starting the network directly:

```bash
tr_start_network 5 --mix-config=exponential
```

For `multitransfer.bash`, the sixth positional argument selects the preset:

```bash
tools/experiments/multitransfer/multitransfer.bash \
  20 50 5 1000000 true exponential none
```

An emulation profile can be combined with either Mix delay strategy. For example, `exponential wired-lossy` combines protocol-level exponential relay holding times with kernel-level link delay, jitter and packet loss.

## Network emulation: the purpose

An experiment using ordinary loopback sees extremely low delay, almost no packet loss, and very high bandwidth. Those conditions are useful for functional tests but do not resemble a real network.

Linux traffic control, normally invoked through the `tc` command, can attach a queueing discipline to a network interface. A queueing discipline decides how outgoing packets wait and when they leave the interface. Linux commonly abbreviates queueing discipline as `qdisc`.

`netem` is a queueing discipline that emulates network effects. The harness uses `netem` to add:

- delay: every packet waits before transmission;
- jitter: the delay varies between packets;
- packet loss: selected packets are discarded;
- rate limiting: packets leave no faster than the configured aggregate rate.

`netem` affects packet handling in the kernel. The application and transport continue using ordinary sockets and do not know that delay or loss was introduced.

## The network namespace

The harness creates a Linux network namespace named `mixtests`. A network namespace has its own interfaces, routes and traffic-control configuration. Nodes started inside `mixtests` use the namespace's loopback interface rather than the host's normal loopback configuration.

The namespace provides two safety and reproducibility properties:

- Traffic-control changes do not modify the host's normal loopback interface.
- Deleting the namespace removes the emulated interface and its queueing disciplines together.

The script brings the namespace's `lo` interface up and changes its MTU from the unusually large loopback default to 1500 bytes. The smaller MTU causes TCP to use packet sizes closer to an ordinary Ethernet path.

## Why API traffic is excluded

Two types of traffic use the same loopback interface:

- port 9000 carries the libp2p and Mix traffic being measured;
- port 8000 carries harness control requests such as `/status` and `/request`.

The experiment should emulate the data path without making the control API unreliable. For example, packet loss on `/status` could make the harness believe a healthy node failed to start. The final HTTP response also tells the harness that the transfer completed; delaying that response would add control-plane delay to the measured duration.

The traffic-control configuration therefore divides packets into two queues:

```text
namespace loopback interface (lo)
  |
  `-- root PRIO qdisc, handle 1:
        |
        |-- first band, class 1:1
        |     selected when source or destination port is 8000
        |     child qdisc: pfifo, without netem
        |
        `-- second band, class 1:2
              selected for every other packet
              child qdisc: netem
```

The Bash comments call the two queues “band 0” and “band 1”, while `tc` addresses the same queues as class `1:1` and class `1:2`. The different numbering conventions are easy to confuse:

| Conceptual name | `tc` class identifier | Traffic |
| --- | --- | --- |
| PRIO band 0, the first band | `1:1` | HTTP API traffic, unshaped |
| PRIO band 1, the second band | `1:2` | libp2p and Mix traffic, shaped by `netem` |

In this context, a **band** means one child queue of the `prio` scheduler. A band is not a bandwidth measurement and does not itself impose a rate limit.

## Reading the `tc` setup command by command

The root scheduler is created with:

```bash
tc qdisc add dev lo root handle 1:0 prio bands 2 \
  priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
```

The terms mean:

- `qdisc add dev lo` attaches a queueing discipline to the loopback interface.
- `root` makes `prio` the first scheduler that sees outgoing packets.
- `handle 1:0` assigns an identifier in the `1:` namespace to this scheduler. Later commands use `parent 1:0` or `parent 1:` to refer to it.
- `prio bands 2` creates two strict-priority child queues. The first band is serviced before the second whenever both contain packets.
- `priomap` maps the kernel's 16 packet-priority values to bands. Sixteen values are present because this legacy map corresponds to the possible four-bit IP precedence values.
- Every mapping value is `1`, so packets without an explicit filter go to the second band, where `netem` is installed.

Two classifiers override the default for API traffic:

```bash
tc filter add dev lo parent 1:0 protocol ip u32 \
  match ip sport 8000 0xffff flowid 1:1

tc filter add dev lo parent 1:0 protocol ip u32 \
  match ip dport 8000 0xffff flowid 1:1
```

The terms mean:

- `filter` classifies packets before the parent scheduler chooses a band.
- `u32` is the traffic-control classifier used to inspect fields in the IP packet.
- `sport 8000 0xffff` matches an exact 16-bit source port.
- `dport 8000 0xffff` matches an exact 16-bit destination port.
- `flowid 1:1` directs a matching packet to the first band.

Both source and destination ports are checked because an HTTP request has destination port 8000, whereas the corresponding HTTP response has source port 8000. The client's temporary port is otherwise unpredictable.

The first band receives a plain packet-first-in-first-out queue:

```bash
tc qdisc add dev lo parent 1:1 handle 10: pfifo
```

`pfifo` sends packets in arrival order and introduces none of the configured `netem` effects.

The second band receives `netem`:

```bash
tc qdisc add dev lo parent 1:2 handle 20: netem \
  delay 10ms 2ms distribution normal loss 0.1% rate 100mbit
```

The arguments following `netem` are exactly the values previously passed to `emu_set_params`.

## Understanding common `netem` parameters

Consider:

```bash
emu_set_params delay 10ms 2ms distribution normal loss 0.1% rate 100mbit
```

The parameters mean:

- `delay 10ms` adds approximately 10 milliseconds to each transmission through the shaped queue.
- The second delay value, `2ms`, specifies jitter. Individual packet delays vary around 10 milliseconds.
- `distribution normal` asks `netem` to draw the delay variation from its normal-distribution table instead of the default uniform distribution.
- `loss 0.1%` independently discards approximately one packet in one thousand. TCP and MixTransport may retransmit at their respective layers, so the application-level effect is larger and more variable than the raw loss percentage.
- `rate 100mbit` limits the aggregate traffic leaving the shaped queue to approximately 100 megabits per second.

Loopback traffic in each direction is transmitted through `lo`, so both request and response packets encounter the outgoing queue when their sender writes them. A `delay 10ms` setting therefore normally contributes roughly 20 milliseconds to a round trip before protocol processing and queueing are considered.

The bandwidth limit belongs to one queue on one shared interface. Ten simultaneous transfers do not each receive 100 Mbit/s; the transfers compete for an aggregate rate of approximately 100 Mbit/s. The high-priority API band can also be serviced before the shaped band, although normal harness API traffic is small.

## Running an emulated interactive experiment

Build the node first, then run:

```bash
source tools/harness/harness.bash
emu_set_params delay 10ms 2ms distribution normal loss 0.1%
emu_enter
```

`emu_enter` creates the namespace and starts a new interactive shell inside it. The new shell does not inherit Bash functions, so source the harness again:

```bash
source tools/harness/harness.bash
tr_init
tr_start_network 5
tr_transfer_mix 4 3 1000000
tr_transfer_regular 4 3 1000000
tr_kill_nodes
exit
```

After the inner shell exits, the outer `emu_enter` invocation deletes the namespace. `emu_teardown` can delete the namespace manually if an interrupted experiment leaves it behind.

## How scripted emulation enters the namespace

An experiment script uses the same `emu_enter` function differently:

```bash
emu_set_params delay 10ms 2ms distribution normal loss 0.1%
emu_enter
```

When no explicit command is supplied and the caller is not interactive, `emu_enter` starts the current script again inside `mixtests`. The environment variable `_emu_inside=1` tells the second execution that the namespace is already configured. The second call to `emu_enter` returns immediately, allowing the remainder of the experiment to run exactly once inside the namespace. When the inner execution finishes, the outer execution removes the namespace and exits with the experiment's status.

For an isolated command, pass the command explicitly:

```bash
emu_set_params loss 1%
emu_enter bash -c 'tc qdisc show dev lo'
```

## Named emulation profiles

`tools/harness/emu-profiles.bash` defines reusable parameter strings:

| Profile | Parameters | Intended effect |
| --- | --- | --- |
| `wired` | `delay 10ms 2ms distribution normal loss 0.1%` | modest delay and rare loss |
| `wired-lossy` | `delay 10ms 2ms distribution normal loss 1%` | modest delay and significant loss |
| `wired-capped` | `wired` plus `rate 100mbit` | modest impairment with a shared 100 Mbit/s limit |
| `wired-very-capped` | `wired` plus `rate 1mbit` | deliberately severe shared bandwidth limit |
| `hi-delay-jittery` | `delay 100ms 30ms distribution normal loss 0.1%` | long and variable delay with rare loss |
| `hi-delay-jittery-lossy` | `delay 100ms 30ms distribution normal loss 1%` | long and variable delay with significant loss |

The profile names are convenient labels, not claims that the values accurately represent all wired or high-delay networks. The source explicitly marks selecting evidence-based profiles as future work.

## Verify the emulation setup

Run:

```bash
tools/harness/emu-test.bash
```

The test configures a shared 0.5 Mbit/s rate limit and starts two one-shot `iperf3` servers:

- one server listens on the libp2p port and should report low throughput because its packets enter the `netem` band;
- one server listens on the API port and should remain fast because its packets enter the unshaped band.

The sanity test verifies traffic classification. The sanity test does not validate the Mix protocol or MixTransport.

## Run the multitransfer experiment

The main experiment keeps a requested number of transfers active until the requested total has completed:

```bash
tools/experiments/multitransfer/multitransfer.bash \
  <node-count> \
  <total-transfers> \
  <concurrent-transfers> \
  <bytes-per-transfer> \
  <use-mix> \
  <mix-delay-strategy> \
  <emulation-profile>
```

For example:

```bash
tools/experiments/multitransfer/multitransfer.bash \
  20 50 5 1000000 true default wired-lossy
```

This command starts 20 nodes, completes 50 one-megabyte Mix transfers, keeps at most five transfers active, uses the Mix `default` delay strategy, and applies the `wired-lossy` network profile.

The defaults are:

| Argument | Default |
| --- | --- |
| node count | 40 |
| total transfers | 50 |
| concurrent transfers | 5 |
| bytes per transfer | 1,048,576 |
| use Mix | `true` |
| Mix delay strategy | `default` |
| emulation profile | `none` |

The scheduler starts transfers in background processes. When the concurrency limit is reached, `wait -n` waits until any transfer process exits. Bash does not return the completed process identifier in the form used by the script, so the scheduler checks every recorded PID with `kill -0` and removes processes that no longer exist.

`multitransfer-set.bash` contains a `PARAMS` array for running several experiment configurations sequentially. Edit that array before launching a large sweep. The script refreshes the caller's `sudo` timestamp every 30 seconds so repeated namespace creation does not repeatedly prompt for a password.

## Output files

The default multitransfer output root is:

```text
tools/experiments/multitransfer/output/
```

One run produces:

```text
output/
├── <run-id>-transfer-times.csv
└── <run-id>/
    └── logs/
        ├── node-0.log
        ├── node-1.log
        └── transfers/
            ├── mix-<source>-<destination>-<random>.log
            └── regular-<source>-<destination>-<random>.log
```

The CSV begins with:

```text
timestamp,filesize,source,destination,wallclock,cpu
```

The experiment adds columns such as `concurrent`, `emulator`, `strategy`, `netsize` and `mix`.

`wallclock` is the elapsed time of the synchronous `curl /request` operation. `cpu` is Bash `time`'s user-CPU time for the `curl` process; `cpu` does not measure the CPU consumed by the node processes. Node CPU consumption is currently not recorded.

A failed `curl` still causes Bash `time` to append a CSV row, and the CSV has no success-status column. Inspect the corresponding transfer log and node logs before interpreting an unusual measurement as a valid completed transfer.

## What R Markdown is

R is a programming language commonly used for statistics, data manipulation and plotting. RStudio and several editor extensions provide interactive environments for R, but R itself can also run from the command line.

R Markdown files use the `.Rmd` extension and combine two forms of content:

- ordinary Markdown explains the analysis;
- fenced R code chunks execute the analysis and generate tables or figures.

A code chunk begins with a marker such as:

````text
```{r}
means <- transfers |>
  group_by(netsize, concurrent) |>
  summarise(wallclock = median(wallclock))
```
````

Rendering an R Markdown document is commonly called **knitting**. The renderer executes the R chunks from top to bottom in one R session and combines the Markdown, printed results and generated plots into an output document. These notebooks request HTML output in the YAML header at the top of each file.

R Markdown is only a post-processing tool in this repository. Deleting or ignoring the notebooks does not affect the harness, node behavior, network emulation, or collected CSV files.

## Reproducible R packages with `renv`

R analyses depend on packages such as `tidyverse`, `ggplot2`, `jsonlite` and `rmarkdown`. Installing whichever package versions happen to be newest can make an old notebook behave differently.

The `renv.lock` file records the package versions used by this analysis. `renv` restores those packages into a project-specific library, serving a role similar to a dependency lockfile in other ecosystems. The analysis directory's `.Rprofile` automatically sources `renv/activate.R` when R starts with the analysis directory as its working directory.

Prepare the environment with:

```bash
cd tools/experiments/multitransfer/analysis
R -e 'install.packages("renv", repos="https://cloud.r-project.org")'
R -e 'renv::restore()'
```

The first command is needed only when `renv` is not already available. `renv::restore()` can download and compile many packages, so the first restoration may take time and require ordinary system build dependencies.

## Transfer-time notebook

`analysis.Rmd` performs the following operations:

1. Find every CSV file directly under `../output`.
2. Combine the measurement rows.
3. Convert wall-clock time to a numeric value and experiment parameters to categorical values.
4. Compute median transfer time for each network size, concurrency, Mix delay strategy and emulator profile.
5. Plot transfer time against concurrency.
6. Plot transfer-time distributions for the different emulation profiles.

Render the notebook from the analysis directory:

```bash
Rscript -e 'rmarkdown::render("analysis.Rmd")'
```

The command writes `analysis.html` next to the notebook. The analysis `.gitignore` excludes generated HTML and PNG files.

The notebook assumes that all CSV files under `../output` have compatible named columns. Move unrelated or older incompatible CSV files elsewhere before rendering.

## Message-level notebook

`analysis-messages.Rmd` examines MixTransport protocol messages rather than transfer completion times. Producing suitable input requires both structured logging and the message trace topic:

```bash
nimble debugNode
export TR_NODE_BINARY="$PWD/tools/node/node-debug"
export TR_LOG_LEVEL='INFO;trace:mix-transport-messages'
tools/experiments/multitransfer/multitransfer.bash \
  20 50 5 1000000 true default none
```

The notebook:

1. Selects JSON log lines containing the `mix-transport-messages` topic.
2. Extracts the node index from filenames such as `node-7.log`.
3. Counts incoming and outgoing frame kinds for each named experiment.
4. Correlates the first `Connect`, `ConnectAck`, `OpenStream` and `StreamAck` events by session and stream identifiers.
5. Plots message counts, message rates over time, and observed establishment latencies.

The current notebook does not discover run directories automatically. The `logs <- ...` block contains explicit paths such as:

```r
logs <- read_experiment(
  "../output/push-unconstrained/logs/",
  "push_unconstrained"
)
```

Rename run directories, create descriptive symbolic links, or edit these paths and labels before rendering. Each path must point at the directory containing `node-<index>.log`, not at the `transfers` subdirectory.

Render the notebook with:

```bash
Rscript -e 'rmarkdown::render("analysis-messages.Rmd")'
```

The latency calculation uses the first matching event for each session, stream, frame kind and direction. Treat the resulting plots as exploratory diagnostics rather than a complete statistical treatment of retransmissions or repeated lifecycle events.

## Practical interpretation limits

Keep the following constraints in mind when comparing results:

- Every node process competes for the same host CPU and memory bandwidth. Higher concurrency can measure host contention as well as protocol behavior.
- All emulated data traffic shares one queue. The harness cannot assign different delay or loss values to individual node pairs.
- A rate cap is network-wide within the namespace.
- Node startup gives later nodes knowledge of earlier nodes only; the harness does not model live service discovery or pool churn.
- Direct transfers explicitly drop the libp2p peer after every request because dialing by address otherwise creates retained connections. Mix transfers follow MixTransport's session lifecycle and may reuse session state.
- Transfer payload generation and validation consume CPU because every byte is produced and checked with a pseudorandom generator.
- The current CSV records completion timing but not success status or node-process resource consumption.

These constraints do not invalidate comparisons. Comparisons are most useful when the host, binary, node count, concurrency, payload size and emulation profile remain fixed and only the intended transport parameter changes.

## Cleanup and troubleshooting

Stop interactive nodes with:

```bash
tr_kill_nodes
```

Remove a leftover emulation namespace with:

```bash
emu_teardown
```

Inspect namespace state with:

```bash
sudo ip netns list
sudo ip netns exec mixtests tc qdisc show dev lo
sudo ip netns exec mixtests tc filter show dev lo parent 1:
```

If `harness.bash` reports that the node executable is missing, run `nimble node` or set `TR_NODE_BINARY` to the debug-node path before sourcing the harness.

If a node does not become ready, inspect:

```text
$TR_LOGS_FOLDER/node-<index>.log
```

If an individual transfer fails, inspect the corresponding file under:

```text
$TR_LOGS_FOLDER/transfers/
```

Run `tools/harness/emu-test.bash` when API traffic appears to be delayed or the configured rate limit appears ineffective. The test distinguishes a broken `netem` configuration from a MixTransport-level problem.
