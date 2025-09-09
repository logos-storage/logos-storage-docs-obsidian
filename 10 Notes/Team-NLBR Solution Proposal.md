The `TorrentConfig` type provides the configuration for the BitTorrent-based History Archive management functionality:

```go
type TorrentConfig struct {
	// Enabled set to true enables Community History Archive protocol
	Enabled bool
	// Port number which the BitTorrent client will listen to for conntections
	Port int
	// DataDir is the file system folder Status should use for message archive torrent data.
	DataDir string
	// TorrentDir is the file system folder Status should use for storing torrent metadata files.
	TorrentDir string
}
```

The `DataDir` is where the History Archives for the controlled communities are stored. Then, `TorrentDir` is where the corresponding community torrent files are preserved.

In the `DataDir` folder, for each community there is a folder (named after community id) in which the history archive for that community is stored:

```bash
DataDir/
├── {communityID}/
│   ├── index          # Archive index file (metadata)
│   └── data           # Archive data file (actual messages)
└── 
```

There is one-to-one relationship between the community folder and the corresponding *torrent* file (BitTorrent metainfo):

```bash
TorrentDir/
├── {communityID}.torrent    # Torrent metadata file
└── 
```

## When Archives are created

The function somehow central to the Archive creation is [InitHistoryArchiveTasks](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/messenger_communities.go#L3783). This function is called in a number of situations, e.g. in [Messenger.Start](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/messenger.go#L562), [Messenger.EditCommunity](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/messenger_communities.go#L2807), [Messenger.ImportCommunity](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/messenger_communities.go#L2865), [Messenger.EnableCommunityHistoryArchiveProtocol](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/messenger_communities.go#L4136).

In `InitHistoryArchiveTasks`, for each community with `HistoryArchiveSupportEnabled` option set to `true`:

- if community torrent file already exists: call [ArchiveManager.SeedHistoryArchiveTorrent](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L408) - see also [[What is Seeding (AI)]] and [[When are magnetlink messages sent]].
- determine if new archives need to be created based on the last archive end date and call [CreateAndSeedHistoryArchive](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L314)
- starts periodic archive creation task by calling [StartHistoryArchiveTasksInterval](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L323), which will in turn call [CreateAndSeedHistoryArchive](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L314).

From `CreateAndSeedHistoryArchive`, via chain of calls, we arrive at [createHistoryArchiveTorrent](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive_file.go#L55), which is key to understand how archives are created and to our proposal.

## Archive Creation

Archives are about archiving messages. Thus, we first need to find the messages relevant to the given (chat) community. This happens through *filters* and connected to them `topics`. It is probably enough to say, that there is some [[Unclarity about Waku filters and topics]], but for this discussion, it should be enough to assume, that we trust to correctly retrieve the community messages. `topics` are provided to the `createHistoryArchiveTorrent`, which is where the archives are built. 

Recall that for each community, status-go uses two files: `index` metadata file, and the `data`.
The `data` file stores *protobuf*-encoded *archives*. Each archive describes a period of time given by `From` and `To` attributes (both Unix timestamps casted to `uint64`), which together with `ContentTopic` form the `Metadata` part of an archive:

```go
type WakuMessageArchiveMetadata struct {
	From uint64
	To uint64
	ContentTopic [][]byte
}
```

> For clarity, we skip `protobuf`-specific fields and annotations.

In `createHistoryArchiveTorrent`, the messages are retrieved using [GetWakuMessagesByFilterTopic](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/persistence.go#L967). Then, the messages are bundled into chunks, where each chunk is max `30MB` big as given by the `maxArchiveSizeInBytes` constant. Messages bigger than `maxArchiveSizeInBytes` will not be archived.

Now, for each message chunk, an instance of [WakuMessageArchive](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/protobuf/communities.pb.go#L2152) (`wakuMessageArchive`) is created using [createWakuMessageArchive](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive_file.go#L343).  `WakuMessageArchive` has the following definition:

```go
type WakuMessageArchive struct {
	Metadata *WakuMessageArchiveMetadata
	Messages []*WakuMessage
}
```

> again we strip `protobuf` attributes for clarity.

We see that the `Metadata` attribute of the `WakuMessageArchive` type is set to the `WakuMessageArchiveMetadata` defined above. For reference only, `WakuMessage` has the following definition:

```go
type WakuMessage struct {
	Sig          []byte
	Timestamp    uint64
	Topic        []byte
	Payload      []byte
	Padding      []byte
	Hash         []byte
	ThirdPartyId string
}
```

The `WakuMessageArchive` is then encoded and encrypted, resulting in the final `encodedArchive`. The `rawSize := len(encodedArchive)` is then padded if necessary so that the archive size is aligned to the BitTorrent piece length (which is set to `100KiB`). The `encodedArchive` together with the padding information is then added to `encodedArchives` (`[]*EncodedArchiveData`). Finally, the resulting `size` and `padding` together with the current `offset` in the existing `data` file and the `Metadata` are used to create the corresponding archive index entry that later will be serialized to the `index` file:

```go
wakuMessageArchiveIndexMetadata := &protobuf.WakuMessageArchiveIndexMetadata{
	Metadata: wakuMessageArchive.Metadata,
	Offset:   offset,
	Size:     uint64(size),
	Padding:  uint64(padding),
}
```

The archive index entry is encoded, and its hash is used as a key in the archive index map:

```go
wakuMessageArchiveIndexMetadataBytes, err := proto.Marshal(
	wakuMessageArchiveIndexMetadata
)

archiveID := crypto.Keccak256Hash(wakuMessageArchiveIndexMetadataBytes).String()
wakuMessageArchiveIndex[archiveID] = wakuMessageArchiveIndexMetadata
```

> `wakuMessageArchiveIndex` is earlier initialized to contain existing archive index entries from the current `index` file. Here we are basically appending new archive meta to the archive index data structure.

We repeat the whole process for each message chunk in the given time period, adding more period if needed (recall, each period is 7 days long). 

After that we have a list of new archives (in `encodedArchives`) and a new archive index entries. We are ready to be encoded and serialized to the corresponding `data` (by appending) and `index` files.

Finally, the corresponding torrent file is (re)created, the `HistoryArchivesCreatedSignal` is emitted, and the last message archive end date is recorded in the persistence.

The diagram below shows the relationships between the datatypes described above:

![[team-nl-br-design-1.svg]]

And then in the following diagram we show how the `index` and `data` files are populated, the corresponding torrent file and the magnet link:

![[team-nl-br-design-2.svg]]

## Archive Distribution and Download

All the nodes that want to restore the message history, first need to retrieve the `index` file. Here, the selective download of the selected files from the torrent is used. After having the index files, the nodes can find out which periods they need to retrieve. Using the `offset`, `size`, and `padding`, they use BitTorrent library to selectively fetch only the torrent pieces that they need. In our Codex integration proposal, we suggest taking advantage of Codex CIDs to formally decouple archive index from archive data. 

## Proposed Integration with Codex

First we propose changing the `WakuMessageArchiveIndexMetadata` type in the following direction. Instead of the `offset`, `size`, and `padding`, we suggest to refer to an archive by a Codex CID. Thus, instead of:

```go
type WakuMessageArchiveIndexMetadata struct {
	Metadata *WakuMessageArchiveMetadata
	Offset   uint64
	Size     uint64
	Padding  uint64
}
```

we would have something like:

```go
type WakuMessageArchiveIndexMetadata struct {
	Metadata *WakuMessageArchiveMetadata
	Cid CodexCid
}
```

We then upload the resulting `index` to Codex under its own `index` CID. Instead of the magnet link, the community owner only publishes this `index` CID.

In order to receive the historical messages for the given period (given by `from` and `to` in the `WakuMessageArchiveMetadata`), the receiving node first acquires the `index` using the `index` CID. For each entry in the `index` that the node has interest in, the node then downloads the corresponding archive directly using the `Cid` from this `index` entry.

The diagram below shows the relationship between the new `index` identified by a Codex CID that uses individual CIDs to refer to each individual archive:

![[team-nl-br-design-3.svg]]

### Advantages

- clean and elegant solution - easier to maintain the archive(s) and the index,
- no dependency on the internals of the low level protocol used (like `padding`, `pieceLength`) - just nice and clean CIDs,
- reusing existing Codex protocol, no need to extend,
- Codex takes care for storage: no more `index` and `data` files: thus more reliable and less error prone.

### Disadvantages

- Because each archive receives its own CID which will to be announced on DHT. If this is considered problem, we may apply bundling, or using block ranges and publish the whole `data` under its own CID. Although less elegant, it still nicely decouples `index` from the `data`, but in this case we may need to expose an API to retrieve specific block index under given `treeCid`.

## Deployment and Codex Library

In the first prototype, we suggest to use Codex API in order to validate the idea and discover potential design flows early. After successful PoC, or already in parallel, we suggest building a Codex protocol library (stripped down from EC and marketplace), which will then be used to create GO bindings for the status-go integration. The same library should than also be used in the new Codex client.

Creating the Codex library was not only long requested by IFT, but it also bring opportunity to rethink the system interfaces and work towards more modular, "plugable" design. In its first instance Codex library could be made of just the block-exchange protocol, discovery module (DHT), and *RepoStore* (block storage) - each of those could potentially be also separated into separate sub-libraries. By providing bindings for various programming languages, we can better stimulate community clients, our original Codex client being one of them. The illustration below shows a high-level overview of the composition and use of the Codex library.

![[team-nl-br-design-4.svg]]

## Changes required in the status-go client

From the numerous code fragments presented above, we can already imagine the works that have to be done in status-go code base. As discussed above the general entry is the [InitHistoryArchiveTasks](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/messenger_communities.go#L3783), which will bring us to most of the other relevant changes, most importantly [CreateAndSeedHistoryArchive](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L314) and [createHistoryArchiveTorrent](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive_file.go#L55). We expect most of the changes to be performed around [protocol/communities/manager_archive.go](https://github.com/status-im/status-go/blob/develop/protocol/communities/manager_archive.go) and [protocol/communities/manager_archive_file.go](https://github.com/status-im/status-go/blob/develop/protocol/communities/manager_archive_file.go).

## Long Term Durability Support

The current proposal builds on Codex and it will naturally scale towards adding stronger durability requirements with Codex Marketplace (and Erasure Coding). We consider this a long term path. In a mid-term, we consider increasing the level of durability by applying some of the element already captured in Ben's [Constellations](https://github.com/benbierens/constellations)

- 1 unchanging ID per community
- Taking care of CID dissemination
- Rough health metrics
- Owner/admin controls
- Useful for more projects than Status

