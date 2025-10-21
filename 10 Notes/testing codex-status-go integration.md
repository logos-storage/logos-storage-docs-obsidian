---
related-to:
  - "[[status-go-codex integration - design notes]]"
---

There is one test in status-go that has slightly more end-to-end nature. It is from the `protocol` package:

```
protocol/communities_messenger_token_permissions_test.go
```

I will be creating an updated version of this test **AFTER** testing lower levels of the stack.

The plan is as follows:

1. More isolated tests of the CodexClient abstraction. There is a separate small utility project, where CodexClient can be exercised against the Codex client. I thought it may be easier this way to test the integration with the Codex library. The project repo url is: [codex-storage/go-codex-client](https://github.com/codex-storage/go-codex-client). Most of the tests from this project will be ported to the working branch where the main integration work takes place: `status-go-codex-integraion` in the [status-im/status-go](https://github.com/status-im/status-go) repo.
2. Tests of `protocol/communities/codex_index_downloader.go` and `protocol/communities/codex_archive_downloader.go`.
3. The "Codex" version of the above mentioned "integration" test.

After that we should be ready for the cluster testing. If needed, we can also try to run status-desktop locally.

### Some early notes on the "integration" test

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


### Isolated tests of the CodexClient abstraction

> The text in this section is basically a copy of README from [codex-storage/go-codex-client](https://github.com/codex-storage/go-codex-client).

We will be running codex client, and then use a small testing utility to check if the low level abstraction - CodexClient - correctly uploads and downloads the content.
### Running CodexClient

I often remove some logging noise, by slightly changing the build params in `build.nims`:

```nim
task codex, "build codex binary":
  buildBinary "codex",
    # params = "-d:chronicles_runtime_filtering -d:chronicles_log_level=TRACE"
    params =
      "-d:chronicles_runtime_filtering -d:chronicles_log_level=TRACE -d:chronicles_enabled_topics:restapi:TRACE,node:TRACE"
```

You see a slightly more selective `params` in the `codex` task.

To run the client I use the following command:

```bash
./build/codex --data-dir=./data-1 --listen-addrs=/ip4/127.0.0.1/tcp/8081 --api-port=8001 --nat=none --disc-port=8091 --log-level=TRACE
```

### Building codex-upload and codex-download utilities

Use the following command to build the `codex-upload` and `codex-download` utilities:

```bash
go build -o bin/codex-upload ./cmd/upload
go build -o bin/codex-download ./cmd/download
```
### Uploading content to Codex

Now, using the `codex-upload` utility, we can upload the content to Codex as follows:

```bash
~/code/local/go-codex-client
❯ ./bin/codex-upload -file test-data.bin -host localhost -port 8001
Uploading test-data.bin (43 bytes) to Codex at localhost:8001...
✅ Upload successful!
CID: zDvZRwzm8K7bcyPeBXcZzWD7AWc4VqNuseduDr3VsuYA1yXej49V
```

### Downloading content from Codex

Now, having the content uploaded to Codex - let's get it back using the `codex-download` utility:

```bash
~/code/local/go-codex-client
❯ ./bin/codex-download -cid zDvZRwzm8K7bcyPeBXcZzWD7AWc4VqNuseduDr3VsuYA1yXej49V -file output.bin -host localhost -port 8001
Downloading CID zDvZRwzm8K7bcyPeBXcZzWD7AWc4VqNuseduDr3VsuYA1yXej49V from Codex at localhost:8001...
✅ Download successful!
Saved to: output.bin
```

You can easily compare that the downloaded content matches the original using:

```bash
~/code/local/go-codex-client
❯ openssl sha256 test-data.bin
SHA2-256(test-data.bin)= c74ce73165c288348b168baffc477b6db38af3c629b42a7725c35d99d400d992

~/code/local/go-codex-client
❯ openssl sha256 output.bin
SHA2-256(output.bin)= c74ce73165c288348b168baffc477b6db38af3c629b42a7725c35d99d400d992
```

### Running tests

There are a couple of basic tests, including one integration test.

To run the unit tests:

```bash
❯ go test -v ./communities
=== RUN   TestUpload_Success
--- PASS: TestUpload_Success (0.00s)
=== RUN   TestDownload_Success
--- PASS: TestDownload_Success (0.00s)
=== RUN   TestDownloadWithContext_Cancel
--- PASS: TestDownloadWithContext_Cancel (0.04s)
PASS
ok  	go-codex-client/communities	0.044s
```

To run the integration test, use `integration` tag and narrow the scope using `-run Integration`:

```bash
go test -v -tags=integration ./communities -run Integration -timeout 15s
```

To make sure that the test is actually run and not cached, use `count` option:

```bash
go test -v -tags=integration ./communities -run Integration -timeout 15s -count 1
```

