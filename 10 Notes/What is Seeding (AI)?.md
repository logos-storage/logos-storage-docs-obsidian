Seeding is the BitTorrent process where a node that has complete archive files makes them available for other peers to download. In Status-go, this happens when:

1. **Community control nodes** create new history archives
2. **Any node** successfully downloads archives from other peers

## When Does Seeding Happen?

### 1. **After Creating New Archives (Control Nodes Only)**

In `SeedHistoryArchiveTorrent`, community control nodes seed archives after creating them:

```go
func (m *ArchiveManager) SeedHistoryArchiveTorrent(communityID types.HexBytes) error {
	m.UnseedHistoryArchiveTorrent(communityID)

	id := communityID.String()
	torrentFile := torrentFile(m.torrentConfig.TorrentDir, id)

	metaInfo, err := metainfo.LoadFromFile(torrentFile)
	if err != nil {
		return err
	}

	info, err := metaInfo.UnmarshalInfo()
	if err != nil {
		return err
	}

	hash := metaInfo.HashInfoBytes()
	m.torrentTasks[id] = hash

	if err != nil {
		return err
	}

	torrent, err := m.torrentClient.AddTorrent(metaInfo)
	if err != nil {
		return err
	}

	torrent.DownloadAll()

	m.publisher.publish(&Subscription{
		HistoryArchivesSeedingSignal: &signal.HistoryArchivesSeedingSignal{
			CommunityID: communityID.String(),
		},
	})

	magnetLink := metaInfo.Magnet(nil, &info).String()

	m.logger.Debug("seeding torrent", zap.String("id", id), zap.String("magnetLink", magnetLink))
	return nil
}
```

This happens when:

- **Periodic archiving**: Control nodes regularly create archives of community message history
- **Manual archiving**: When explicitly triggered through `InitHistoryArchiveTasks`

### 2. **After Downloading Archives Successfully**

In [DownloadHistoryArchivesByMagnetlink](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive.go#L486) around line 644, seeding starts after successful downloads:

```go
// After downloading all archives
m.publisher.publish(&Subscription{
    HistoryArchivesSeedingSignal: &signal.HistoryArchivesSeedingSignal{
        CommunityID: communityID.String(),
    },
})
```

This happens when:

- **Regular members** download archives via magnetlinks
- **New community members** download historical messages
- **Nodes re-downloading** updated archives

### 3. **Seeding Signal Processing**

When seeding starts, it triggers magnetlink message distribution in `handleCommunitiesHistoryArchivesSubscription`:

```go
if sub.HistoryArchivesSeedingSignal != nil {
    // Signal UI that seeding started
    m.config.messengerSignalsHandler.HistoryArchivesSeeding(
	    sub.HistoryArchivesSeedingSignal.CommunityID
    )
    
    // Get community info
    c, err := m.communitiesManager.GetByIDString(
		sub.HistoryArchivesSeedingSignal.CommunityID
	)    
    // Only control nodes send magnetlink messages
    if c.IsControlNode() {
        err := m.dispatchMagnetlinkMessage(
	        sub.HistoryArchivesSeedingSignal.CommunityID
	    )
        // This broadcasts the magnetlink to community members
    }
}
```

## Seeding Lifecycle

### **Start Seeding**

1. Archives are created or downloaded successfully
2. `HistoryArchivesSeedingSignal` is published
3. BitTorrent client starts serving the files
4. Control nodes broadcast magnetlink messages

### **Continue Seeding**

- Files remain available as long as the node is online
- Other peers can download from multiple seeders simultaneously
- BitTorrent automatically manages upload bandwidth

### **Stop Seeding**

In `UnseedHistoryArchiveTorrent`:

```go
func (m *ArchiveManager) UnseedHistoryArchiveTorrent(communityID types.HexBytes) {
    // Remove torrent from client
    torrent := m.torrentClient.Torrent(infoHash)
    if torrent != nil {
        torrent.Drop()
    }
    
    // Publish unseeding signal
    m.publisher.publish(&Subscription{
        HistoryArchivesUnseededSignal: &signal.HistoryArchivesUnseededSignal{
            CommunityID: communityID.String(),
        },
    })
}
```

This happens when:

- **New archives replace old ones**: When fresher magnetlinks are received
- **Community leaves**: When a user leaves a community
- **Manual stop**: When archiving is disabled

## Key Points

- **Only control nodes send magnetlinks**, but **any node can seed** after downloading
- **Seeding is automatic** - happens immediately after successful archive creation or download
- **Multiple seeders improve availability** - BitTorrent's distributed nature means more seeders = better download speeds
- **Seeding triggers UI notifications** via `SendHistoryArchivesSeedin`.

This distributed seeding model ensures that community history archives remain available even if the original control node goes offline, making the system resilient and scalable.
