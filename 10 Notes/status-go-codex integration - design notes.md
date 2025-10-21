---
related-to:
  - "[[Team-NLBR Solution Proposal]]"
  - "[[status-go publishing magnet links]]"
  - "[[status-go processing magnet links]]"
  - "[[status-go-codex integration - design notes]]"
  - "[[Creating History Archives - InitHistoryArchiveTasks]]"
  - "[[testing codex-status-go integration]]"
---
## Codex for History Archives

As indicated in the [[Team-NLBR Solution Proposal]], the central entry point to the history management is [InitHistoryArchiveTasks](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/messenger_communities.go#L3783). `InitHistoryArchiveTasks` is called from **two main places**:
- During `Messenger.Start()` (startup)
- When enabling archive protocol

In [[Creating History Archives - InitHistoryArchiveTasks]] we find the complete initialization flow:

```
System Startup
    ↓
Messenger.Start()
    ↓
Wait for Store Node Availability
    ↓
InitHistoryArchiveTasks(controlledCommunities) 
    │
    ├─ For each community owner controls:
    │   ├─ Check if archive support enabled
    │   ├─ Seed existing torrents (if available)
    |       ├─ CreateAndSeedHistoryArchive
    │   ├─ Get community topics and sync missed messages  
    │   ├─ Check when last archive was created
    │   └─ Based on last archive timing:
    │       ├─ No archives → StartHistoryArchiveTasksInterval() immediately
    │       ├─ Recent archive → Seed + delayed CreateAndSeedHistoryArchive followed by StartHistoryArchiveTasksInterval() 
    │       └─ Old archive → Create new archive + CreateAndSeedHistoryArchive + StartHistoryArchiveTasksInterval()
    │
    └─ Each StartHistoryArchiveTasksInterval():
        ├─ Runs as background goroutine
        ├─ Creates ticker with 7-day interval
        ├─ Every 7 days: CreateAndSeedHistoryArchive()
        ├─ After seeding: publishes HistoryArchivesSeedingSignal  
        ├─ Signal triggers: dispatchMagnetlinkMessage()
        └─ Magnetlink sent to all community members via Waku
```

We will be going step by step through this flow and apply the changes (where we need to diverge, we will...).

### BitTorrent - with or without

In the first pass we do not delete the BitTorrent related code, but rather try to add Codex extensions next to it - this way I hope it will be easier to move things around without being too destructive from the beginning.

### Seed existing torrents (if available)

This step is only needed for torrents. Codex has its own persistence and will start seeding immediately after it starts.

### CreateAndSeedHistoryArchive

The first function that asks for attention is `CreateAndSeedHistoryArchive`. It is from `ArchiveService` interface.

```go
func (m *ArchiveManager) CreateAndSeedHistoryArchive(communityID types.HexBytes, topics []messagingtypes.ContentTopic, startDate time.Time, endDate time.Time, partition time.Duration, encrypt bool) error {
	m.UnseedHistoryArchiveTorrent(communityID)
	_, err := m.ArchiveFileManager.CreateHistoryArchiveTorrentFromDB(communityID, topics, startDate, endDate, partition, encrypt)
	if err != nil {
		return err
	}
	return m.SeedHistoryArchiveTorrent(communityID)
}
```

It calls `CreateHistoryArchiveTorrentFromDB`, which then calls `createHistoryArchiveTorrent`:

```go
func (m *ArchiveFileManager) CreateHistoryArchiveTorrentFromDB(communityID types.HexBytes, topics []messagingtypes.ContentTopic, startDate time.Time, endDate time.Time, partition time.Duration, encrypt bool) ([]string, error) {
	return m.createHistoryArchiveTorrent(communityID, make([]*messagingtypes.ReceivedMessage, 0), topics, startDate, endDate, partition, encrypt)
}
```

`createHistoryArchiveTorrent` (`ArchiveFileManager`) is where the work is done.

#### Protobuf messages

Here we list all the Protobuf messages that are relevant to message archives:

```protobuf
message CommunityMessageArchiveMagnetlink {
  uint64 clock = 1;
  string magnet_uri = 2;
}

message WakuMessage {
  bytes sig = 1;
  uint64 timestamp = 2;
  bytes topic = 3;
  bytes payload = 4;
  bytes padding = 5;
  bytes hash = 6;
  string thirdPartyId = 7;
}

message WakuMessageArchiveMetadata {
  uint32 version = 1;
  uint64 from = 2;
  uint64 to = 3;
  repeated bytes contentTopic = 4;
}

message WakuMessageArchive {
  uint32 version = 1;
  WakuMessageArchiveMetadata metadata = 2;
  repeated WakuMessage messages = 3;
}

message WakuMessageArchiveIndexMetadata {
  uint32 version = 1;
  WakuMessageArchiveMetadata metadata = 2;
  uint64 offset = 3;
  uint64 size = 4;
  uint64 padding = 5;
}

message WakuMessageArchiveIndex {
  map<string, WakuMessageArchiveIndexMetadata> archives = 1;
}
```

All in `protocol/protobuf/communities.proto`. There is one more, not directly related, but for some reason it contains a `magnet_url` field (to be checked later):

```protobuf
message CommunityRequestToJoinResponse {
  uint64 clock = 1;
  CommunityDescription community = 2 [deprecated = true];
  bool accepted = 3;
  bytes grant = 4;
  bytes community_id = 5;
  string magnet_uri = 6;
  bytes protected_topic_private_key = 7;
  Shard shard = 8;
  // CommunityDescription protocol message with owner signature
  bytes community_description_protocol_message = 9;
}
```

We see that most are independent from BitTorrent. The ones that are BitTorrent specific are: 

- `CommunityMessageArchiveMagnetlink`
- `WakuMessageArchiveIndexMetadata`
- `WakuMessageArchiveIndex` (because it depends on `WakuMessageArchiveIndexMetadata`)
- `CommunityRequestToJoinResponse` (because of the `magnet_uri` field)

Now, starting with something simple (in the end we are building PoC here), we know that Codex API operates on CID encoded as `base58btc` strings. In `WakuMessageArchiveIndexMetadata`, `offset`, `size`, and `padding` are relevant to the current BitTorrent-based implementation. For Codex we can use something simpler:

```protobuf
message CodexWakuMessageArchiveIndexMetadata {
  uint32 version = 1;
  WakuMessageArchiveMetadata metadata = 2;
  string cid = 3;
}

message CodexWakuMessageArchiveIndex {
  map<string, CodexWakuMessageArchiveIndexMetadata> archives = 1;
}
```

#### Appending the index file

In a more production version we will not operate on the local file system, yet, here, for simplicity, we will be using a physical index file and a separate file for each archive. For this reason, in the initial implementation, a community owner will not query Codex for the current index file. For this purpose, we could use `http://localhost:8001/api/codex/v1/data/${CID}` API, which returns `404` when the file does not exist in the local store:

```bash
curl -s -D - -o /dev/null "http://localhost:8001/api/codex/v1/data/${CID}"
HTTP/1.1 404 Not Found
Connection: close
Server: nim-presto/0.0.3 (amd64/linux)
Content-Length: 74
Date: Thu, 25 Sep 2025 02:15:07 GMT
Content-Type: text/html; charset=utf-8
```

Instead, for this initial implementation, we will just read it from a local directory. For now, we will reuse BitTorrent configuration. BitTorrent config stores the index file under:

```go
path.Join(m.torrentConfig.DataDir, communityID, "index")
```

For codex, we will store it under:

```go
path.Join(m.torrentConfig.DataDir, "codex", communityID, "index")
```

In a similar way, the individual archive to be uploaded we will use:

```go
path.Join(m.torrentConfig.DataDir, "codex", communityID, "data")
```

This data file is temporary and will be overwritten for each new archive created. With Codex, we do not have to append, thus, we do not need the previous data file anymore. We just use file now, because it may be easier to start it this way.

Now, just for convenience, let's recall the original data structures involved:

![[team-nl-br-design-1.svg]]

The data structures using with BitTorrent are:

```go
wakuMessageArchiveIndexProto := &protobuf.WakuMessageArchiveIndex{}
wakuMessageArchiveIndex := make(map[string]*protobuf.WakuMessageArchiveIndexMetadata)
```

The original BitTorrent index, stored in `wakuMessageArchiveIndexProto`, is initially populated using `LoadHistoryArchiveIndexFromFile` function. After that `wakuMessageArchiveIndex` is used as temporary storage so that we can conveniently extend it with new entries and serialize it to protobuf afterwords. We use the contents of `wakuMessageArchiveIndexProto` to set it up:

```go
for hash, metadata := range wakuMessageArchiveIndexProto.Archives {
	offset = offset + metadata.Size
	wakuMessageArchiveIndex[hash] = metadata
}
```

For the codex extension we proceed in the analogous way:

![[replacing-bittorrent-with-codex-in-status-go-1.svg]]

![[replacing bittorrent with codex in status-go-2.svg]]

```go
codexWakuMessageArchiveIndexProto := &protobuf.CodexWakuMessageArchiveIndex{}
	codexWakuMessageArchiveIndex := make(map[string]*protobuf.CodexWakuMessageArchiveIndexMetadata)
```

and then:

```go
for hash, metadata := range codexWakuMessageArchiveIndexProto.Archives {
	codexWakuMessageArchiveIndex[hash] = metadata
}
```

Having those variables in place and initialized correctly, we enter the loop and start creating archives one by one.

Basically, we proceed in the same way as with BitTorrent - the `WakuMessageArchive` type does not change.

At some point, we arrive at:

```go
wakuMessageArchiveIndexMetadata := &protobuf.WakuMessageArchiveIndexMetadata{
	Metadata: wakuMessageArchive.Metadata,
	Offset:   offset,
	Size:     uint64(size),
	Padding:  uint64(padding),
}
```

For Codex extension, we do not have `offset`, `size`, and `padding` any more as this is something that Codex will take care - but this is the moment we need to call into Codex, to upload the archive and get the corresponding CID back so that we can properly initialize the corresponding index entry:

```go
client := NewCodexClient("localhost", "8080") // make this configurable
cid, err := client.UploadArchive(encodedArchive)
if err != nil {
		m.logger.Error("failed to upload to codex", zap.Error(err))
		return codexArchiveIDs, err
}

m.logger.Debug("uploaded to codex", zap.String("cid", cid))

codexWakuMessageArchiveIndexMetadata := &protobuf.CodexWakuMessageArchiveIndexMetadata{
		Metadata: wakuMessageArchive.Metadata,
		Cid:      cid,
}

codexWakuMessageArchiveIndexMetadataBytes, err := proto.Marshal(codexWakuMessageArchiveIndexMetadata)
if err != nil {
	return codexArchiveIDs, err
}

codexArchiveID := crypto.Keccak256Hash(codexWakuMessageArchiveIndexMetadataBytes).String()
codexArchiveIDs = append(codexArchiveIDs, codexArchiveID)
codexWakuMessageArchiveIndex[codexArchiveID] = codexWakuMessageArchiveIndexMetadata
```

where `CodexClient` is a helper that encapsulates uploading arbitrary data to a Codex client via `/api/codex/v1/data` API. The corresponding `curl` call would be similar to:

```bash
curl -X POST \
  http://localhost:${PORT}/api/codex/v1/data \
  -H 'Content-Type: application/octet-stream' \
  -H 'Content-Disposition: filename="archive-data.bin"' \
  -w '\n' \
  -T archive-data.bin
zDvZRwzm22eSYNdLBuNHVi7jSTR2a4n48yy4Ur9qws4vHV6madiz
```

At this stage we have an individual archive uploaded to Codex (it should be save there now) It is already being advertised but nobody is looking for it yet as we did not finish building the Codex-aware index file, which contains CIDs for all the archives.


