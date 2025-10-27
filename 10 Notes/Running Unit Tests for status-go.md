---
related-to:
  - "[[Running tests with gotestsum]]"
  - "[[go testify assertions]]"
---
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

or to use specific version (`v1.13.0` was the most recent while writing this doc):

```bash
go install gotest.tools/gotestsum@v1.13.0
```

You can check it is available by running:

```bash
gotestsum --version
gotestsum version dev
```

`dev` version comes from using `@latest` when installing `gotestsum`. If you installed a concrete version, you will see:

```bash
gotestsum --version
gotestsum version v1.13.0
```

You may also manually install go Protobuf compiler: `protoc`. I have followed the instructions from [Protocol Buffer Compiler Installation](https://protobuf.dev/installation/).

The following bash script (Arch Linux) can come in handy:

```bash
#!/usr/bin/env bash

set -euo pipefail

echo "installing go..."

sudo pacman -S --noconfirm --needed go

echo "installing go protoc compiler"

PB_REL="https://github.com/protocolbuffers/protobuf/releases"
VERSION="32.1"
FILE="protoc-${VERSION}-linux-x86_64.zip"

# 1. create a temp dir
TMP_DIR="$(mktemp -d)"

# ensure cleanup on exit
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Created temp dir: $TMP_DIR"

# 2. download file into temp dir
curl -L -o "$TMP_DIR/$FILE" "$PB_REL/download/v$VERSION/$FILE"

# 3. unzip into ~/.local/share/go
mkdir -p "$HOME/.local/share/go"
unzip -o "$TMP_DIR/$FILE" -d "$HOME/.local/share/go"

# 4. cleanup handled automatically by trap
echo "protoc $VERSION installed into $HOME/.local/share/go"
```

After that make sure that `$HOME/.local/share/go/bin` is in your path, and you should get:

```bash
protoc --version
libprotoc 32.1
```

#### go-zerokit-rln-x86_64 vendoring problem

If you try to run the tests for the first time, you may face the following error:

```bash
gotestsum --packages="./protocol/communities" -f standard-verbose --rerun-fails -- -v -run "TestCodexClientTestSuite" -count 1
FAIL    github.com/status-im/status-go/protocol/communities [setup failed]

=== Failed
=== FAIL: protocol/communities  (0.00s)
FAIL    github.com/status-im/status-go/protocol/communities [setup failed]

=== Errors
vendor/github.com/waku-org/go-zerokit-rln/rln/link/x86_64.go:8:8: cannot find module providing package github.com/waku-org/go-zerokit-rln-x86_64/rln: import lookup disabled by -mod=vendor

        (Go version in go.mod is at least 1.14 and vendor directory exists.)


DONE 0 tests, 1 failure, 1 error in 0.000s
ERROR rerun aborted because previous run had errors
```

The problem can be outlined as follows:

1. **The package *IS* declared in dependencies**: 
   - `go.mod` has: `github.com/waku-org/go-zerokit-rln-x86_64 v0.0.0-20230916171518-2a77c3734dd1 // indirect`
   - `modules.txt` lists it as *vendored*
2. **BUT it's excluded from git**:
   - `.gitignore` has: `vendor/github.com/waku-org/go-zerokit-rln-x86_64/`
   - as the result. the actual vendor directory is **missing** from your file system
3. **Why it's excluded**: these seems to platform-specific native libraries (RLN - Rate Limiting Nullifier) with binary/compiled components that are large and platform-specific. The project excludes them from version control.
4. **The build tag restriction**: The file x86_64.go has build tags:
   `//go:build (linux || windows) && amd64 && !android`
   
   So it only compiles on x86_64 Linux/Windows, but when it tries to compile, it needs the vendored package.

#### The Solution

We need to vendor the missing dependencies:

```bash
# This will download the missing vendored dependencies
go mod vendor
```

This will populate the `vendor/github.com/waku-org/go-zerokit-rln-x86_64/` directory with the necessary files, even though they're gitignored.

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

a number of tests will most certainly. To understand the root cause, let's investigate a bit.

`make test` uses `_assets/scripts/run_unit_tests.sh` under the hood, where we find the following fragment:

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

From the comments, we see that the `else` branch is currently used when running the tests. It splits running tests into two parts:

1. All the tests except for the tests for `status-go/protocol` module, those are faster, which is reflected in the the shorter timeout: `DEFAULT_TIMEOUT_MINUTES=5`.
2. The `protocol tests` - there are many of them (over 900) and can take longer to run (`PROTOCOL_TIMEOUT_MINUTES=45`). By default `UNIT_TEST_COUNT=1`, which means it tries to run the protocol tests only once.

> The timeout variables `DEFAULT_TIMEOUT_MINUTES` and `PROTOCOL_TIMEOUT_MINUTES` are used as the value of the `-timeout` option passed down to `go test`. It limits the time all the tests are allowing to take.

We may observe more or less failures, depending on the run, but one test will consistently fail, even if we modify the script to only run non-protocol tests:  `TestBasicWakuV2`:

```bash
=== RUN   TestBasicWakuV2
    waku_test.go:172:
        	Error Trace:	/home/mc2/code/status-im/status-go/messaging/waku/waku_test.go:172
        	Error:      	Received unexpected error:
        	            	Get "http://localhost:8645/debug/v1/info": dial tcp [::1]:8645: connect: connection refused
        	Test:       	TestBasicWakuV2
--- FAIL: TestBasicWakuV2 (0.00s)
```

Let's try to run this test without using the `run_unit_tests.sh` script to confirm the problem:

```bash
gotestsum --packages="./messaging/waku" -f testname --rerun-fails -- \
  -count 1 -timeout "5m" \
  -tags "gowaku_no_rln gowaku_skip_migrations" \
  -run TestBasicWakuV2
```

and we will get the same error.

If we look into source code of `messaging/waku/waku_test.go` where `TestBasicWakuV2` is defined, and scroll down a bit (!!), we will find the following comment:

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

Now, we should also be able to successfully run all the non-protocol tests using `make test`:

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

### Running "protocol" tests

When runing all the tests (including `protocol` tests) using `make test`, most of the tests pass, but not all. As already indicated above, in order to get a better feedback and to track progress, I prefer to run them using `gotestsum` command:

```bash
gotestsum --packages="./protocol" -f testname --rerun-fails -- -count 1 -timeout "45m" -tags "gowaku_no_rln gowaku_skip_migrations" | tee "test_1.log"

DONE 964 tests, 5 skipped in 1159.570s
```

Redirecting output to a file using `tee` is pretty much needed as `protocol` tests may generate a lot of log messages.

Here - just for the record - an example failing session:

```bash
gotestsum --packages="./protocol" -f testname --rerun-fails -- -count 1 -timeout "45m" -tags "gowaku_no_rln gowaku_skip_migrations" | tee "test_1.log

DONE 3 runs, 968 tests, 5 skipped, 6 failures in 1194.882s
```

So, the reason I recorded it here, is that the output can be pretty misleading if you are seeing this output for the first time. The `6 failures` is actually $1$ (one) failing test:

```bash
TestMessengerCommunitiesTokenPermissionsSuite/TestAnnouncementsChannelPermissions
```

This one failing test makes the whole suite `TestMessengerCommunitiesTokenPermissionsSuite` failing which is also counted as a failure, and then we have `3 runs`  which is why we see $3 \times 2 = 6$ failures in the end.

Also it is important to mention here that `--rerun-fails` option takes $2$ as default value, which means after first pass, if there are any failing tests, these tests will be rerun, and, if there are still some failing tests after second run, those tests will be rerun as well. So we have $3$ runs in total. Also notice, that the `-count 1` option we pass to the underlying `go test` ensures that each test execution is "fresh" and not cached making sure that it does not use cached results from previous test runs.

On each rerun I am also observing the following error message:

```bash
failed to IncreaseLevel: invalid increase level, as level "fatal" is allowed by increased level, but not by existing core
```

This simply means that the logger (it seems to be [Zap logger](https://github.com/uber-go/zap)) tries to increase the log level before re-running failing tests, but apparently we are already at the max log level - thus the warning message.

About this one failing test: `TestAnnouncementsChannelPermissions`.

We see the following errors reported:

```
2025-09-17T07:01:42.088+0200	ERROR	6decc309-0976-4da3-ada2-d20566a30b02	node/node.go:386	error while mapping sync state	{"mvds": {"error": "sql: database is closed"}}
ERROR	758f6b9d-fa86-44fd-851a-d727d8a57732	protocol/messenger.go:1802	can't post on chat	{"chatID": "0x03aa871de09ab76e4fba610c520735125f36795fb2ca6cb03f10520da449fcd0c5ab08e1bc-61bf-4ce6-82cb-e8c40f37abd2", "chatName": "general", "messageType": "CHAT_MESSAGE"}
...
ERROR	758f6b9d-fa86-44fd-851a-d727d8a57732	protocol/messenger.go:1802	can't post on chat	{"chatID": "0x03aa871de09ab76e4fba610c520735125f36795fb2ca6cb03f10520da449fcd0c5ab08e1bc-61bf-4ce6-82cb-e8c40f37abd2", "chatName": "general", "messageType": "CHAT_MESSAGE"}
...
    communities_messenger_token_permissions_test.go:1169: 
        	Error Trace:	/home/mc2/code/status-im/status-go/protocol/communities_messenger_token_permissions_test.go:1169
        	Error:      	Received unexpected error:
        	            	no messages
        	Test:       	TestMessengerCommunitiesTokenPermissionsSuite/TestAnnouncementsChannelPermissions

    communities_messenger_token_permissions_test.go:1169: 
        	Error Trace:	/home/mc2/code/status-im/status-go/protocol/communities_messenger_token_permissions_test.go:1169
        	Error:      	Received unexpected error:
        	            	no messages
        	Test:       	TestMessengerCommunitiesTokenPermissionsSuite/TestAnnouncementsChannelPermissions
# still some log messages
--- FAIL: TestMessengerCommunitiesTokenPermissionsSuite/TestAnnouncementsChannelPermissions (11.44s)
```

When running this single test isolated, it is a bit flaky, sometimes it passes right away, sometimes it passes on the second run.

```bash
❯ gotestsum --packages="./protocol" -f testname --rerun-fails -- -count 1 -timeout "45m" -tags "gowaku_no_rln gowaku_skip_migrations" -run TestMessengerCommunitiesTokenPermissionsSuite/TestAnnouncementsChannelPermissions
PASS protocol.TestMessengerCommunitiesTokenPermissionsSuite/TestAnnouncementsChannelPermissions (1.42s)
PASS protocol.TestMessengerCommunitiesTokenPermissionsSuite (1.42s)
PASS protocol

DONE 2 tests in 1.453s

❯ gotestsum --packages="./protocol" -f testname --rerun-fails -- -count 1 -timeout "45m" -tags "gowaku_no_rln gowaku_skip_migrations" -run TestMessengerCommunitiesTokenPermissionsSuite/TestAnnouncementsChannelPermissions
...
DONE 3 runs, 6 tests, 4 failures in 27.876s
```

Thus, being able to run all the tests successfully a number of time, we should be allowed to conclude that our setup is correct.