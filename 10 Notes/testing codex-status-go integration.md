---
related-to:
  - "[[status-go-codex integration - design notes]]"
---
In [[Running Unit Tests for status-go]] we provide general notes on running unit tests in the status-go project. And then we have a similar note about functional tests in [[Running functional tests in status-go]].

Also, to learn the history archive creation/upload and download/processing flows (recorded AI conversation with some edits), please check:

- archive creation/upload: [[When are magnetlink messages sent]]
- archive download/processing: [[status-go processing magnet links]]

To grasp the concept of topics and filters - check [[Filters, Topics, Channels, and Chat IDs in status-go and waku]].

In that last document I am including a link to an excalidraw diagram that can be helpful - for convenience: [https://link.excalidraw.com/readonly/vSon9uiUhYJWrwXiKAsi](https://link.excalidraw.com/readonly/vSon9uiUhYJWrwXiKAsi)

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

### Environment variables to run unit tests

After Codex library (`libcodex`) has been added to the project the build system depends on it. Thus, to run the tests directly using `go test` or `gotestsum` command you need to make sure that the following environment variables are set:

```bash
export LIBS_DIR="$(realpath ./libs)"
export CGO_CFLAGS=-I$LIBS_DIR
export CGO_LDFLAGS="-L$LIBS_DIR -lcodex -Wl,-rpath,$LIBS_DIR"
```

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

The test we are particularly interested in is `TestImportDecryptedArchiveMessages`.

This test produces lots of output - with lot's warnings and errors - so looking at the log to judge the success would be a challenge. Yet, the test passes:

```bash
❯ gotestsum --packages="./protocol" -f testname -- -run "TestMessengerCommunitiesTokenPermissionsSuite/TestImportDecryptedArchiveMessages" -count 1 -tags "gowaku_no_rln gowaku_skip_migrations"
PASS protocol.TestMessengerCommunitiesTokenPermissionsSuite/TestImportDecryptedArchiveMessages (1.88s)
PASS protocol.TestMessengerCommunitiesTokenPermissionsSuite (1.88s)
PASS protocol

DONE 2 tests in 1.900s
```

If you want to take a look at the logs you can use the more verbose version of the above command:

```bash
❯ gotestsum --packages="./protocol" -f standard-verbose -- -run "TestMessengerCommunitiesTokenPermissionsSuite/TestImportDecryptedArchiveMessages" -v -count 1 -tags "gowaku_no_rln gowaku_skip_migrations"
```

and you can use `tee` to redirect all the output to a file:

```bash
❯ gotestsum --packages="./protocol" -f standard-verbose -- -run "TestMessengerCommunitiesTokenPermissionsSuite/TestImportDecryptedArchiveMessages" -v -count 1 -tags "gowaku_no_rln gowaku_skip_migrations" | tee "test_1.log"
```

The test first creates a community and sets up the corresponding permissions. Then the community owner sends a message to the community and then immediately retrieves it so that it is now recorded in the DB.

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

The "Codex" version of the `CreateHistoryArchiveTorrentFromDB` is `CreateHistoryArchiveCodexFromDB` which will call `createHistoryArchiveCodex` - this is where archives are created and uploaded to Codex.

Another function that this test "touches" is `LoadHistoryArchiveIndexFromFile`, for which the "Codex" version is `CodexLoadHistoryArchiveIndexFromFile`.

Thus, this test focuses on an important cut of the whole end-to-end flow and in our case, where we use Codex, it also indirectly tests seeding and retrieving the archives from the network.

### Other places we can consider to test

The integration test described above does not cover actual publishing of the generated archives over waku channel. This normally happens in `CreateAndSeedHistoryArchive`:

```
CreateAndSeedHistoryArchive
 |- CreateHistoryArchiveTorrentFromDB
 |- SeedHistoryArchiveTorrent
 |- CreateHistoryArchiveCodexFromDB
 |- publish: HistoryArchiveSeedingSignal
```

We see that we seed the index file and the archives for both torrent and Codex and when at least one publishing method succeeds, we do:

```go
m.publisher.publish(&Subscription{
	HistoryArchivesSeedingSignal: &signal.HistoryArchivesSeedingSignal{
		CommunityID: communityID.String(),
		MagnetLink:  archiveTorrentCreatedSuccessfully, // true if torrent created successfully
		IndexCid:    archiveCodexCreatedSuccessfully,   // true if codex created successfully
	},
})
```

This signal is subsequently received in `handleCommunitiesHistoryArchivesSubscription`, where we find:

```go
if c.IsControlNode() {
	if sub.HistoryArchivesSeedingSignal.MagnetLink {
		err := m.dispatchMagnetlinkMessage(sub.HistoryArchivesSeedingSignal.CommunityID)
		if err != nil {
			m.logger.Debug("failed to dispatch magnetlink message", zap.Error(err))
		}
	}
	if sub.HistoryArchivesSeedingSignal.IndexCid {
		err := m.dispatchIndexCidMessage(sub.HistoryArchivesSeedingSignal.CommunityID)
		if err != nil {
			m.logger.Debug("failed to dispatch index cid message", zap.Error(err))
		}
	}
}
```

The `dispatchMagnetlinkMessage` and `dispatchIndexCidMessage` is where dispatching is happening. For Codex the MessageType used is `protobuf.ApplicationMetadataMessage_COMMUNITY_MESSAGE_ARCHIVE_INDEX_CID`.

The message is sent as follows:

```go
chatID := community.MagnetlinkMessageChannelID()
rawMessage := messagingtypes.RawMessage{
	LocalChatID:          chatID,
	Sender:               community.PrivateKey(),
	Payload:              encodedMessage,
	MessageType:          protobuf.ApplicationMetadataMessage_COMMUNITY_MESSAGE_ARCHIVE_INDEX_CID,
	SkipGroupMessageWrap: true,
	PubsubTopic:          community.PubsubTopic(),
	Priority:             &messagingtypes.LowPriority,
}

_, err = m.messaging.SendPublic(context.Background(), chatID, rawMessage)
if err != nil {
	return err
}

err = m.communitiesManager.UpdateCommunityDescriptionIndexCidMessageClock(community.ID(), indexCidMessage.Clock)
if err != nil {
	return err
}
return m.communitiesManager.UpdateIndexCidMessageClock(community.ID(), indexCidMessage.Clock)
```

Here notice the call to `UpdateCommunityDescriptionIndexCidMessageClock`. As you can see, the clocks are also recorded in the community description. Community description is sent over waku to other community members periodically (every 5mins) or on some events. This how it is sent in `publishOrg` in `protocol/messenger_communities.go`:

```go
rawMessage := messagingtypes.RawMessage{
	Payload: payload,
	Sender:  org.PrivateKey(),
	// we don't want to wrap in an encryption layer message
	SkipEncryptionLayer: true,
	CommunityID:         org.ID(),
	MessageType:         protobuf.ApplicationMetadataMessage_COMMUNITY_DESCRIPTION,
	PubsubTopic:         org.PubsubTopic(), // TODO: confirm if it should be sent in community pubsub topic
	Priority:            &messagingtypes.HighPriority,
}
if org.Encrypted() {
	members := org.GetMemberPubkeys()
	if err != nil {
		return err
	}
	rawMessage.CommunityKeyExMsgType = messagingtypes.KeyExMsgRekey
	// This should be the one that it was used to encrypt this community
	rawMessage.HashRatchetGroupID = org.ID()
	rawMessage.Recipients = members
}
messageID, err := m.messaging.SendPublic(context.Background(), org.IDString(), rawMessage)
```

When community members receive the community description, they compare the clocks in the community description with the most recent clocks of the most recent magnet link or index Cid. IF the clocks in the community description are newer (more recent), they update the local copies, so that when a new magnet link or index Cid message arrives, they know to ignore outdated messages.

To read more, check: [[History Archives and Community Description]].

This naturally brought us to the reception of the magnet links/index Cid (see also [[status-go processing magnet links]] and [[status-go publishing magnet links]]).

Going from Waku and layers of status-go, the accumulated messages are periodically collected using `RetrieveAll` functions, which passes the message to `handleRetrievedMessages` for processing.

For each message, `dispatchToHandler` is called (in it in generated file `message_handler.go` generated with `go generate ./cmd/generae_handlers/`) where are magnet links/index Cid message are forwarded to their respective handlers: `handleCommunityMessageArchiveMagnetlinkProtobuf` and `handleCommunityMessageArchiveIndexCidProtobuf`. In the end they end up in `HandleHistoryArchiveMagnetlinkMessage` and `HandleHistoryArchiveIndexCidMessage` respectively. At the end, they trigger async processing in go routines calling `downloadAndImportHistoryArchives` and `downloadAndImportCodexHistoryArchives`. Just after the respective go routines are created, the clock are updated with `m.communitiesManager.UpdateMagnetlinkMessageClock(id, clock)` and `m.communitiesManager.UpdateIndexCidMessageClock(id, clock)`.

But before even starting go routine, we check the distribution preference with `GetArchiveDistributionPreference` and the last seen index Cid `m.communitiesManager.GetLastSeenIndexCid(id)` (it will be updated after downloading the archives but before processing them in `downloadAndImportCodexHistoryArchives`) and the corresponding clock `GetIndexCidMessageClock`, to make sure we are not processing some outdated archives.

We can see that the above "integration test", in case of Codex, by calling `RetrieveAll` it effectively triggers archive download from Codex, yet it does not cover the dissemination of the indexCid - the test basically assumes that the index file has been stored, thus, if we want to cover more, we need to go beyond that test.

Perhaps, to cover the whole flow, it is best to build status-desktop with our status-go library and test it from there.
