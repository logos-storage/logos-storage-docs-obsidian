Magnetlink messages are sent when a community's control node (the community owner) finishes seeding history archives. Here's the complete flow:

### 1. **Triggering Event: Archive Seeding Completion**

Magnetlink messages are sent when a `HistoryArchivesSeedingSignal` is triggered. This happens in two scenarios:

1. **After Creating New Archives**: In [SeedHistoryArchiveTorrent](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L408) around line 438, when the control node finishes creating and starts seeding new history archives.
    
2. **After Downloading Archives**: In [DownloadHistoryArchivesByMagnetlink](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L486) around line 645, when archives are successfully downloaded and seeding begins.
### 2. **Message Dispatch Logic**

The actual sending happens in `handleCommunitiesHistoryArchivesSubscription` at lines 246-259:

```go
if sub.HistoryArchivesSeedingSignal != nil {
    m.config.messengerSignalsHandler.HistoryArchivesSeeding(
	    sub.HistoryArchivesSeedingSignal.CommunityID
	)
    c, err := m.communitiesManager.GetByIDString(
	    sub.HistoryArchivesSeedingSignal.CommunityID
	)
    if err != nil {
        m.logger.Debug(
	        "failed to retrieve community by id string",
	        zap.Error(err)
	    )
    }
    if c.IsControlNode() {
        err := m.dispatchMagnetlinkMessage(
	        sub.HistoryArchivesSeedingSignal.CommunityID
	    )
        if err != nil {
            m.logger.Debug(
	            "failed to dispatch magnetlink message",
	            zap.Error(err)
	        )
        }
    }
}
```

### 3. **Key Conditions**

- **Only Control Nodes**: Only the community owner can send magnetlink messages
- **After Seeding**: Messages are only sent after archives are successfully seeded and available for download

### 4. **Message Creation and Sending**

The `dispatchMagnetlinkMessage` function (lines 4093-4138):

1. **Gets the magnetlink**: Calls `m.archiveManager.GetHistoryArchiveMagnetlink(community.ID())` to generate the magnetlink from the torrent file
2. **Creates the message**: Builds a `CommunityMessageArchiveMagnetlink` protobuf message with current timestamp and magnetlink URI
3. **Sends publicly**: Broadcasts the message to the community's magnetlink channel using `m.messaging.SendPublic()`
4. **Updates clocks**: Updates both the community description and magnetlink message clocks

### 5. **Message Content**

The magnetlink message contains:

- **Clock**: Current timestamp
- **MagnetUri**: The BitTorrent magnetlink for downloading the archives
- **Message Type**: `COMMUNITY_MESSAGE_ARCHIVE_MAGNETLINK`

### Summary

Magnetlink messages are sent **automatically by community control nodes whenever they finish seeding new history archives**. This ensures that community members are immediately notified when new archive data becomes available for download via BitTorrent, enabling efficient peer-to-peer distribution of community message history.
