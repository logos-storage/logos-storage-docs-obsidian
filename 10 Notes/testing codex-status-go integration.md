---
related-to:
  - "[[status-go-codex integration - design notes]]"
---
In [[Running Unit Tests for status-go]] we provide general notes on running unit tests in the status-go project. And then we have a similar note about functional tests in [[Running functional tests in status-go]].

In this document, we focus on our Codex extension to status-go and here we focus on the related unit and integration tests.

There is one existing test in status-go that has slightly more end-to-end nature. It is from the `protocol` package:

```
protocol/communities_messenger_token_permissions_test.go
```

We will be providing an updated version of this test **AFTER** testing lower levels of the stack.

Thus, the plan is as follows:

1. More isolated tests of the CodexClient abstraction. There is a separate small utility project, where CodexClient can be exercised against the Codex client. I thought it may be easier this way to test the integration with the Codex library. The project repo url is: [codex-storage/go-codex-client](https://github.com/codex-storage/go-codex-client). Most of the tests from this project will be ported to the working branch where the main integration work takes place: `status-go-codex-integraion` in the [status-im/status-go](https://github.com/status-im/status-go) repo.
2. Tests of `protocol/communities/codex_index_downloader.go` and `protocol/communities/codex_archive_downloader.go`.
3. The "Codex" version of the above mentioned "integration" test.

After that we should be ready for the cluster testing. If needed, we can also try to run status-desktop locally.

So in this document we first document running unit and integration tests for the three major abstractions we introduced to status-go:

- CodexClient
- CodexIndexDownloader
- CodexArchiveDownloader

They are comprehensively tested in the [codex-storage/go-codex-client](https://github.com/codex-storage/go-codex-client) repo, but then they are integrated into the status-go. It is easy to figure out how to run the corresponding tests by just adjusting the commands in the above mentioned [codex-storage/go-codex-client](https://github.com/codex-storage/go-codex-client) repo, but for completeness, we present the updated content below.

### Regenerating artifacts

In [codex-storage/go-codex-client](https://github.com/codex-storage/go-codex-client) we include all the generated artifacts. In status-go, they are not included in the version control. Thus, what is optional in [codex-storage/go-codex-client](https://github.com/codex-storage/go-codex-client), here is obligatory to do before you will be able to run the tests.

There are two artifacts that need to be updated:

- the protobuf
- the mocks

For the first one - protobuf - you need two components:
1. **`protoc`** - the Protocol Buffer compiler itself
2. **`protoc-gen-go`** - the Go plugin for protoc that generates `.pb.go` files

#### Installing protoc

I have followed the instructions from [Protocol Buffer Compiler Installation](https://protobuf.dev/installation/).

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

#### Installing protoc-gen-go

The `protoc-gen-go` plugin is required to generate Go code from `.proto` files. 
Install it with:

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.34.1
```

Make sure `$(go env GOPATH)/bin` is in your `$PATH` so protoc can find the plugin.

Verify the installation:

```bash
which protoc-gen-go
protoc-gen-go --version
# Should output: protoc-gen-go v1.34.1
```

#### Installing mockgen

In order to regenerate mocks you will need `mockgen`.

You can install it with:

```bash
go install go.uber.org/mock/mockgen
```

> Also make sure you have `$(go env GOPATH)/bin` in your PATH. Otherwise
   make sure you have something like `export PATH="$PATH:$(go env GOPATH)/bin"` 
   in your `~/.bashrc` (adjusted to your SHELL and OS version). 
   This should be part of your standard GO installation.

If everything works well, you should see something like:

```bash
❯ which mockgen && mockgen -version
/home/<your-user-name>/go/bin/mockgen
v0.6.0
```

If everything seems to be under control, we can now proceed with actual generation.

The easiest way is to regenerate all in one go:

```bash
go generate ./...
```

If you just need to regenerate the mocks:

```bash
go generate ./protocol/communities
```

If you just need to regenerate the protobuf:

```bash
go generate ./protobuf
```

> If you run `make`, e.g. `make statusgo-library`, the correct `generate` commands for the protobuf will be run for you. So in practice, you may not need to run `go generate ./protobuf` manually yourself - but for reference, why not... let's break something ;).

### Running unit tests for Codex abstractions

We have some unit tests and a couple of integration tests.

In this section we focus on the unit tests. The integration tests are covered in the
next section.

To run all unit tests:

```bash
❯ go test -v ./protocol/communities -count 1
```

To be more selective, e.g. in order to run all the tests from 
`CodexArchiveDownloaderSuite`, run:

```bash
go test -v ./protocol/communities -run CodexArchiveDownloader -count 1
```

or for an individual test from that suite:

```bash
go test -v ./protocol/communities -run TestCodexArchiveDownloaderSuite/TestCancellationDuringPolling -count 1
```

You can also use `gotestsum` to run the tests (you may need to install it first, e.g. `go install gotest.tools/gotestsum@v1.13.0`):

```bash
gotestsum --packages="./protocol/communities" -f testname --rerun-fails -- -count 1
```

For a more verbose output including logs use `-f standard-verbose`, e.g.:

```bash
gotestsum --packages="./protocol/communities" -f standard-verbose --rerun-fails -- -v -count 1
```

To be more selective, e.g. in order to run all the tests from 
`CodexArchiveDownloaderSuite`, run:

```bash
gotestsum --packages="./protocol/communities" -f testname --rerun-fails -- -run CodexArchiveDownloader -count 1
```

or for an individual test from that suite:

```bash
gotestsum --packages="./protocol/communities" -f testname --rerun-fails -- -run TestCodexArchiveDownloaderSuite/TestCancellationDuringPolling -count 1
```

Notice, that the `-run` flag accepts a regular expression that matches against the full test path, so you can be more concise in naming if necessary, e.g.:

```bash
gotestsum --packages="./protocol/communities" -f testname --rerun-fails -- -run CodexArchiveDownloader/Cancellation -count 1
```

This also applies to native `go test` command.

### Running integration tests

When building Codex client for testing like here, I often remove some logging noise, by slightly changing the build params in `build.nims`:

```nim
task codex, "build codex binary":
  buildBinary "codex",
    # params = "-d:chronicles_runtime_filtering -d:chronicles_log_level=TRACE"
    params =
      "-d:chronicles_runtime_filtering -d:chronicles_log_level=TRACE -d:chronicles_enabled_topics:restapi:TRACE,node:TRACE"
```

You see a slightly more selective `params` in the `codex` task.

To start Codex client, use e.g.:

```bash
./build/codex --data-dir=./data-1 --listen-addrs=/ip4/127.0.0.1/tcp/8081 --api-port=8001 --nat=none --disc-port=8091 --log-level=TRACE
```

To run the integration test, use `codex_integration` tag and narrow the scope using `-run Integration`:

```bash
CODEX_API_PORT=8001 go test -v -tags=codex_integration ./protocol/communities -run Integration -timeout 15s
```

This will run all integration tests, including `CodexClient` integration tests.

To make sure that the test is actually run and not cached, use `count` option:

```bash
CODEX_API_PORT=8001 go test -v -tags=codex_integration ./protocol/communities -run Integration -timeout 15s -count 1
```

To be more specific and only run the tests related to, e.g. index downloader or archive
downloader you can use:

```bash
CODEX_API_PORT=8001 go test -v -tags=codex_integration ./protocol/communities -run CodexIndexDownloaderIntegration -timeout 15s -count 1

CODEX_API_PORT=8001 go test -v -tags=codex_integration ./protocol/communities -run CodexArchiveDownloaderIntegration -timeout 15s -count 1
```

and then, if you prefer to use `gotestsum`:

```bash
CODEX_API_PORT=8001 gotestsum --packages="./protocol/communities" -f standard-verbose --rerun-fails -- -tags=codex_integration -run CodexIndexDownloaderIntegration -v -count 1

CODEX_API_PORT=8001 gotestsum --packages="./protocol/communities" -f standard-verbose --rerun-fails -- -tags=codex_integration -run CodexArchiveDownloaderIntegration -v -count 1
```

or to run all integration tests (including `CodexClient` integration tests):

```bash
CODEX_API_PORT=8001 gotestsum --packages="./protocol/communities" -f standard-verbose --rerun-fails -- -tags=codex_integration -v -count 1 -run Integration
```

I prefer to be more selective when running integration tests.
### Main integration test

This is about step 3 above: "Codex" version of `protocol/communities_messenger_token_permissions_test.go`.

The test we are particularly interested in - `TestImportDecryptedArchiveMessages` - first creates a community and sets up the corresponding permissions. Then the community owner sends a message to the community and then immediately retrieves it so that it is now recorded in the DB.

After that it prepares archive parameters: `startDate`, `endDate`, `partition`, and community `topics`. All those will be passed to `CreateHistoryArchiveTorrentFromDB` - our entry point to creating history archive torrent.

```go
// 1.1. Create community
community, chat := s.createCommunity()
// ...
// 1.2. Setup permissions
// ...
// 2. Owner: Send a message A
messageText1 := RandomLettersString(10)
message1 := s.sendChatMessage(s.owner, chat.ID, messageText1)

// 2.2. Retrieve own message (to make it stored in the archive later)
_, err = s.owner.RetrieveAll()
s.Require().NoError(err)

// 3. Owner: Create community archive
const partition = 2 * time.Minute
messageDate := time.UnixMilli(int64(message1.Timestamp))
startDate := messageDate.Add(-time.Minute)
endDate := messageDate.Add(time.Minute)
topic := messagingtypes.BytesToContentTopic(messaging.ToContentTopic(chat.ID))
communityCommonTopic := messagingtypes.BytesToContentTopic(messaging.ToContentTopic(community.UniversalChatID()))
topics := []messagingtypes.ContentTopic{topic, communityCommonTopic}

torrentConfig := params.TorrentConfig{
	Enabled:    true,
	DataDir:    os.TempDir() + "/archivedata",
	TorrentDir: os.TempDir() + "/torrents",
	Port:       0,
}

// Share archive directory between all users
s.owner.archiveManager.SetTorrentConfig(&torrentConfig)
s.bob.archiveManager.SetTorrentConfig(&torrentConfig)
s.owner.config.messengerSignalsHandler = &MessengerSignalsHandlerMock{}
s.bob.config.messengerSignalsHandler = &MessengerSignalsHandlerMock{}
```

Finally we call the `CreateHistoryArchiveTorrentFromDB`:

```go
archiveIDs, err := s.owner.archiveManager.CreateHistoryArchiveTorrentFromDB(community.ID(), topics, startDate, endDate, partition, community.Encrypted())
s.Require().NoError(err)
s.Require().Len(archiveIDs, 1)
```

Notice, there is one archive expected.

The `CreateHistoryArchiveTorrentFromDB` is called directly here, in a way bypassing the torrent seeding: in normal flow `CreateHistoryArchiveTorrentFromDB` is called in `CreateAndSeedHistoryArchive` which immediately after creating the archive, calls `SeedHistoryArchiveTorrent`.  `CreateHistoryArchiveTorrentFromDB` calls `createHistoryArchiveTorrent` - which is central to the archive creating.

TBC...
