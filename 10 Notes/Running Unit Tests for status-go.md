Let's start with what we find in the [status-go build instructions](https://github.com/status-im/status-go/blob/develop/_docs/how-to-build.md) as lots of things just work.

We have two options: (1) use the [nix](https://nixos.org/) develop shell or (2) just use standard shell you have in your shell. Theoretically, nix should give you better isolation and repeatability, yet, it is quite opinionated, has learning curve, and adds quite a bit complexity. For now thus, I decided to a more conservative shell environment, where I feel more comfortable.

> In what follows I am using BASH on Arch Linux in [Omarchy](https://omarchy.org/) distribution.

### Pre-requisites

You need to have `go` installed on your system. On Arch Linux I used `sudo pacman -S go` to install it.

### GO dependencies

Right after cloning, you should be able to run:

```bash
make status-go-deps
```

Plus, and what the original documentation does not say, you will need `gotestsum` to conveniently run unit tests. We have to install it manually:

```bash
go install gotest.tools/gotestsum@latest
```

You can check it is available by running:

```bash
gotestsum --version
gotestsum version dev
```

> `dev` version may be coming from using `@latest` when installing `gotestsum`.

### Building backend and the libs

Just to check if everything is setup correctly, let's build `status-backend` (which is a wrapper over status-go that provides web API - handy for testing), and then status-go static and shared libraries:

```bash
make status-backend
```

It will be available as `./build/bin/status-backend`: 

```bash
./build/bin/status-backend -h
Usage of ./build/bin/status-backend:
  -address string
    	host:port to listen (default "127.0.0.1:0")
  -pprof
    	enable pprof
  -testify.m string
    	regular expression to select tests of the testify suite to run
```

Now, the libs. Static lib:

```bash
make statusgo-library
which: no go-generate-fast in (...)
Generated handlers in ../../protocol/messenger_handlers.go for Type enum.
Generated endpoints file: ../endpoints.go
## cmd/library/README.md explains the magic incantation behind this
mkdir -p build/bin/statusgo-lib
go run cmd/library/*.go > build/bin/statusgo-lib/main.go
Building static library...
go build \
	-tags 'gowaku_no_rln' \
	-ldflags="" \
	-buildmode=c-archive \
	-o build/bin/libstatus.a \
	./build/bin/statusgo-lib
Static library built:
-rw-r--r-- 1 mc2 mc2 247898154 Sep 17 01:24 build/bin/libstatus.a
-rw-r--r-- 1 mc2 mc2      8290 Sep 17 01:24 build/bin/libstatus.h
```

and shared lib:

```bash
make statusgo-shared-library
which: no go-generate-fast in (...)
Generated handlers in ../../protocol/messenger_handlers.go for Type enum.
Generated endpoints file: ../endpoints.go
## cmd/library/README.md explains the magic incantation behind this
mkdir -p build/bin/statusgo-lib
go run cmd/library/*.go > build/bin/statusgo-lib/main.go
Building shared library...
Tags: gowaku_no_rln
CGO_LDFLAGS="-Wl,-soname,libstatus.so.0" go build \
	-tags 'gowaku_no_rln' \
	-ldflags="" \
	-buildmode=c-shared \
	-o build/bin/libstatus.so \
	./build/bin/statusgo-lib
cd build/bin && \
ls -lah . && \
mv ./libstatus.so ./libstatus.so.0 && \
ln -s ./libstatus.so.0 ./libstatus.so
total 578M
drwxr-xr-x 1 mc2 mc2  190 Sep 17 01:39 .
drwxr-xr-x 1 mc2 mc2   10 Sep 10 05:15 ..
-rwxr-xr-x 1 mc2 mc2  44M Sep 10 05:15 generate-db
-rw-r--r-- 1 mc2 mc2 237M Sep 17 01:24 libstatus.a
-rw-r--r-- 1 mc2 mc2 8.1K Sep 17 01:39 libstatus.h
-rw-r--r-- 1 mc2 mc2 107M Sep 17 01:39 libstatus.so
-rwxr-xr-x 1 mc2 mc2  92M Sep 10 05:15 push-notification-server
-rwxr-xr-x 1 mc2 mc2 100M Sep 17 01:19 status-backend
drwxr-xr-x 1 mc2 mc2   14 Sep 10 05:08 statusgo-lib
Shared library built:
-rw-r--r-- 1 mc2 mc2 247898154 Sep 17 01:24 build/bin/libstatus.a
-rw-r--r-- 1 mc2 mc2      8290 Sep 17 01:39 build/bin/libstatus.h
lrwxrwxrwx 1 mc2 mc2        16 Sep 17 01:39 build/bin/libstatus.so -> ./libstatus.so.0
-rw-r--r-- 1 mc2 mc2 111911080 Sep 17 01:39 build/bin/libstatus.so.0
```

### Running unit test

The obvious

```bash
make test
```

is a mistery to me as looking at the source code, it looks it has no chance to succeed without some extra steps.

`make test` uses `_assets/scripts/run_unit_tests.sh`, where we find the following fragment:

```bash
if [[ $HAS_PROTOCOL_PACKAGE == 'false' ]]; then
  # This is the default single-line flow for testing all packages
  # The `else` branch is temporary and will be removed once the `protocol` package runtime is optimized.
  run_test_for_packages "${UNIT_TEST_PACKAGES}" "0" "${UNIT_TEST_COUNT}" "${DEFAULT_TIMEOUT_MINUTES}" "All packages"
else
  # Spawn a process to test all packages except `protocol`
  UNIT_TEST_PACKAGES_FILTERED=$(echo "${UNIT_TEST_PACKAGES}" | tr ' ' '\n' | grep -v '/protocol$' | tr '\n' ' ')
  run_test_for_packages "${UNIT_TEST_PACKAGES_FILTERED}" "0" "${UNIT_TEST_COUNT}" "${DEFAULT_TIMEOUT_MINUTES}" "All packages except 'protocol'" &
  bg_pids+=("$!")

  # Spawn separate processes to run `protocol` package
  for ((i=1; i<=UNIT_TEST_COUNT; i++)); do
    run_test_for_packages github.com/status-im/status-go/protocol "${i}" 1 "${PROTOCOL_TIMEOUT_MINUTES}" "Only 'protocol' package" &
    bg_pids+=("$!")
  done
fi
```

From the comments, we see that the `else` branch will be used. It is split into two parts:

1. All the tests except for the tests for `status-go/protocol` module, those are faster, which is reflected in the the shorter timeout: `DEFAULT_TIMEOUT_MINUTES=5`.
2. The `protocol tests` - slower (`PROTOCOL_TIMEOUT_MINUTES=45`). By default `UNIT_TEST_COUNT=1`.

For our regular development, we may not like to run all tests. In particular, the `protocol` tests seem to be less relevant to our use case of message history archives. Thus, in what follows I am skipping the longer protocol tests.

Now, if you run `make test` the tests will fail:

```bash
=== RUN   TestBasicWakuV2
    waku_test.go:172:
        	Error Trace:	/home/mc2/code/status-im/status-go/messaging/waku/waku_test.go:172
        	Error:      	Received unexpected error:
        	            	Get "http://localhost:8645/debug/v1/info": dial tcp [::1]:8645: connect: connection refused
        	Test:       	TestBasicWakuV2
--- FAIL: TestBasicWakuV2 (0.00s)
```

Indeed, we can confirm it by running just the `TestBasicWakuV2`:

```bash
gotestsum --packages="./messaging/waku" -f testname --rerun-fails -- \
  -count 1 -timeout "5m" \
  -tags "gowaku_no_rln gowaku_skip_migrations" \
  -run TestBasicWakuV2
```

and we will get the same error.

If we look into source code of `messaging/waku/waku_test.go`, and scroll down a bit (!!), we will find the following comment:

```go
// In order to run these tests, you must run an nwaku node
//
// Using Docker:
//
//	IP_ADDRESS=$(hostname -I | awk '{print $1}');
//	docker run \
//	 -p 60000:60000/tcp -p 9000:9000/udp -p 8645:8645/tcp harbor.status.im/wakuorg/nwaku:v0.36.0 \
//	 --tcp-port=60000 --discv5-discovery=true --cluster-id=16 --pubsub-topic=/waku/2/rs/16/32 --pubsub-topic=/waku/2/rs/16/64 \
//	 --nat=extip:${IP_ADDRESS} --discv5-discovery --discv5-udp-port=9000 --rest-address=0.0.0.0 --store
```

First, on Arch Linux it may happen that `-I` option is not available. As an alternative you can use:

```bash
IP_ADDRESS=$(ip -o -4 addr show up primary scope global | awk '{print $4}' | cut -d/ -f1 | head -n1);
```

Unfortunately, if we try to start waku node as recommended, we will get an error:

```bash
docker run \
  -p 60000:60000/tcp -p 9000:9000/udp -p 8645:8645/tcp \
  harbor.status.im/wakuorg/nwaku:v0.36.0 \
  --tcp-port=60000 --discv5-discovery=true --cluster-id=16 \
  --pubsub-topic=/waku/2/rs/16/32 --pubsub-topic=/waku/2/rs/16/64 \
  --nat=extip:${IP_ADDRESS} --discv5-discovery --discv5-udp-port=9000 \
  --rest-address=0.0.0.0 --store
Unrecognized option 'pubsub-topic'
Try wakunode2 --help for more information.
```

Using quick co-pilot fix, it seems that we need to use `--shard` instead of `--pubsub-topic` and the correct command to start a waku node (with a store) is:

```bash
docker run \
  -p 60000:60000/tcp -p 9000:9000/udp -p 8645:8645/tcp \
  harbor.status.im/wakuorg/nwaku:v0.36.0 \
  --tcp-port=60000 --discv5-discovery=true --cluster-id=16 \
  --shard=32 --shard=64 \
  --nat=extip:${IP_ADDRESS} --discv5-udp-port=9000 \
  --rest-address=0.0.0.0 --store
```

Now when we run `TestBasicWakuV2`, it passes:

```bash
gotestsum --packages="./messaging/waku" -f testname --rerun-fails -- -count 1 -timeout "5m" -tags "gowaku_no_rln gowaku_skip_migrations" -run TestBasicWakuV2
PASS messaging/waku.TestBasicWakuV2 (7.24s)
PASS messaging/waku
```

We can also run all the test relevant to the `messaging/waku` package and they should all pass:

```bash
gotestsum --packages="./messaging/waku" -f testname --rerun-fails -- -count 1 -timeout "5m" -tags "gowaku_no_rln gowaku_skip_migrations"
PASS messaging/waku.TestMultipleTopicCopyInNewMessageFilter (0.00s)
PASS messaging/waku.TestHandlePeerAddress/valid_enrtree (0.00s)
PASS messaging/waku.TestHandlePeerAddress/invalid_multiaddr (0.00s)
PASS messaging/waku.TestHandlePeerAddress/valid_multiaddr (0.00s)
PASS messaging/waku.TestHandlePeerAddress/valid_enr (0.00s)
PASS messaging/waku.TestHandlePeerAddress/unknown_address_format (0.00s)
PASS messaging/waku.TestHandlePeerAddress (0.00s)
PASS messaging/waku.TestDiscoveryV5 (4.20s)
2025-09-17T04:02:04.059+0200	DEBUG	p2p-config	config/log.go:21	[Fx] HOOK OnStop		github.com/libp2p/go-libp2p/p2p/transport/quicreuse.(*ConnManager).Close-fm() executing (caller: github.com/libp2p/go-libp2p/config.(*Config).addTransports.func9)
PASS messaging/waku.TestRestartDiscoveryV5 (10.86s)
2025-09-17T04:02:14.914+0200	DEBUG	p2p-config	config/log.go:21	[Fx] HOOK OnStop		github.com/libp2p/go-libp2p/p2p/transport/quicreuse.(*ConnManager).Close-fm() called by github.com/libp2p/go-libp2p/config.(*Config).addTransports.func9 ran successfully in 12.553µs
PASS messaging/waku.TestRelayPeers (0.01s)
PASS messaging/waku.TestBasicWakuV2 (7.46s)
PASS messaging/waku.TestPeerExchange (11.06s)
SKIP messaging/waku.TestWakuV2Filter (0.00s)
PASS messaging/waku.TestOnlineChecker (0.11s)
PASS messaging/waku

=== Skipped
=== SKIP: messaging/waku TestWakuV2Filter (0.00s)
    waku_test.go:392: flaky test

DONE 14 tests, 1 skipped in 33.720s
```

Now, we should also be able to successfully run all the tests using `make test`:

```bash
make test
...
DONE 1881 tests, 25 skipped in 93.841s
Gathering test coverage results:  output: coverage_merged.out, input: ./test_0.coverage.out
Generating HTML coverage report
Testing finished
```

Following the practice from running [[Running functional tests in development]], also here we have a handy script for starting a waku node suitable for unit testing:

```bash
_assets/scripts/run_waku.sh
Starting waku node...
0795dbb8e786cf9047c8162fcc1cbbb11cd22926a5091f4e07df0e1b259ef62d
Waku node started.
Press any button to exit...q
Removing containers...
0795dbb8e786
DONE!
```

Now, for the status-go-codex integration, most of the relevant tests are in the `TestManagerSuite`:

```bash
gotestsum --packages="./protocol/communities" -f testname --rerun-fails -- -count 1 -timeout "5m" -tags "gowaku_no_rln gowaku_skip_migrations" -run TestManagerSuite
PASS protocol/communities.TestManagerSuite/TestCheckAllChannelsPermissions (0.51s)
PASS protocol/communities.TestManagerSuite/TestCheckAllChannelsPermissions_EmptyPermissions (0.52s)
PASS protocol/communities.TestManagerSuite/TestCheckChannelPermissions_NoPermissions (0.53s)
PASS protocol/communities.TestManagerSuite/TestCheckChannelPermissions_ViewAndPostPermissions (0.51s)
PASS protocol/communities.TestManagerSuite/TestCheckChannelPermissions_ViewAndPostPermissionsCombination (0.53s)
PASS protocol/communities.TestManagerSuite/TestCheckChannelPermissions_ViewAndPostPermissionsCombination2 (0.50s)
PASS protocol/communities.TestManagerSuite/TestCheckChannelPermissions_ViewOnlyPermissions (0.52s)
PASS protocol/communities.TestManagerSuite/TestCommunityIDIsHydratedWhenMarshaling (0.25s)
PASS protocol/communities.TestManagerSuite/TestCommunityQueue (0.53s)
PASS protocol/communities.TestManagerSuite/TestCommunityQueueMultipleDifferentSigners (0.52s)
PASS protocol/communities.TestManagerSuite/TestCommunityQueueMultipleDifferentSignersIgnoreIfNotReturned (0.55s)
PASS protocol/communities.TestManagerSuite/TestCreateCommunity (0.27s)
PASS protocol/communities.TestManagerSuite/TestCreateCommunity_WithBanner (0.25s)
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrentFromMessages (0.27s)
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrentFromMessages_ShouldAppendArchives (0.25s)
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrentFromMessages_ShouldCreateMultipleArchives (0.24s)
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrent_ShouldAppendArchives (0.26s)
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrent_ShouldCreateArchive (0.25s)
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrent_ShouldCreateMultipleArchives (0.26s)
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrent_WithoutMessages (0.26s)
PASS protocol/communities.TestManagerSuite/TestDetermineChannelsForHRKeysRequest (0.27s)
PASS protocol/communities.TestManagerSuite/TestEditCommunity (0.25s)
PASS protocol/communities.TestManagerSuite/TestFillMissingCommunityTokens (0.26s)
PASS protocol/communities.TestManagerSuite/TestGetControlledCommunitiesChatIDs (0.26s)
PASS protocol/communities.TestManagerSuite/TestRetrieveCollectibles (0.50s)
PASS protocol/communities.TestManagerSuite/TestRetrieveTokens (0.53s)
PASS protocol/communities.TestManagerSuite/TestSeedHistoryArchiveTorrent (0.25s)
PASS protocol/communities.TestManagerSuite/TestStartAndStopTorrentClient (0.27s)
PASS protocol/communities.TestManagerSuite/TestStartHistoryArchiveTasksInterval (10.25s)
PASS protocol/communities.TestManagerSuite/TestStartTorrentClient_DelayedUntilOnline (0.26s)
PASS protocol/communities.TestManagerSuite/TestStopHistoryArchiveTasksIntervals (2.25s)
PASS protocol/communities.TestManagerSuite/TestStopTorrentClient_ShouldStopHistoryArchiveTasks (2.24s)
PASS protocol/communities.TestManagerSuite/TestUnseedHistoryArchiveTorrent (0.26s)
PASS protocol/communities.TestManagerSuite/Test_GetPermissionedBalances (0.50s)
PASS protocol/communities.TestManagerSuite/Test_calculatePermissionedBalances (0.50s)
PASS protocol/communities.TestManagerSuite (26.65s)
PASS protocol/communities

DONE 36 tests in 26.685s
```

To run a single test, you can do something like the following:

```bash
gotestsum --packages="./protocol/communities" -f testname --rerun-fails -- -count 1 -timeout "5m" -tags "gowaku_no_rln gowaku_skip_migrations" -run TestManagerSuite/TestCreateHistoryArchiveTorrent_ShouldCreateArchive
PASS protocol/communities.TestManagerSuite/TestCreateHistoryArchiveTorrent_ShouldCreateArchive (0.27s)
PASS protocol/communities.TestManagerSuite (0.27s)
PASS protocol/communities

DONE 2 tests in 0.307s
```

> The *suite* counts as one test.

