---
related-to:
  - "[[Team-NLBR Solution Proposal]]"
  - "[[status-go publishing magnet links]]"
  - "[[status-go processing magnet links]]"
  - "[[status-go-codex integration - design notes]]"
  - "[[Creating History Archives - InitHistoryArchiveTasks]]"
---
See also previous conversation: [[When are magnetlink messages sent]]

Great question! Let me trace where and how magnetlink messages are published to the Waku network. This is the other side of the equation - how the community owners/admins send these MAGNETLINK messages that we just traced receiving. 

Searched codebase for "publish magnetlink CommunityMessageArchiveMagnetlink send", 20 results

Perfect! Now I can show you exactly where and how magnetlink messages are published to the Waku network. Let me trace this step by step:

## **Where Magnetlink Messages are Published to Waku**

### **1. The Key Function: `dispatchMagnetlinkMessage()`** 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#4079-4079), lines 4079 to 4109

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#4109-4109), lines 4109 to 4124

This is the core function! Let me also check what calls this function: 

Searched text for `dispatchMagnetlinkMessage` (`**/*.go`), 4 results

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#250-250), lines 250 to 270

Let me check what this subscription handler is: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#220-220), lines 220 to 250

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#200-200), lines 200 to 220

Now I can see the complete picture! Let me trace the flow and also check what triggers the seeding signal: 

Searched text for `HistoryArchivesSeedingSignal` (`**/*.go`), 20 results

Let me check where the seeding signal is triggered: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager_archive.go#430-430), lines 430 to 440

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager_archive.go#420-420), lines 420 to 435

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager_archive.go#400-400), lines 400 to 420

Now let me check where `SeedHistoryArchiveTorrent` is called: 

Searched text for `SeedHistoryArchiveTorrent` (`**/*.go`), 20 results

Perfect! Now I have the complete picture. Let me also check where the seeding happens from archive creation: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager_archive.go#310-310), lines 310 to 325

## **Complete Magnetlink Publication Flow**

Here's the complete flow of where and how magnetlink messages are published to Waku:

### **1. Archive Creation and Seeding Triggers**

**A. Periodic Archive Creation (Community Owner):**
```
StartHistoryArchiveTasksInterval() [periodic scheduler]
    ↓
CreateAndSeedHistoryArchive()
    ↓
CreateHistoryArchiveTorrentFromDB() [creates .torrent files]
    ↓
SeedHistoryArchiveTorrent() [starts BitTorrent seeding]
    ↓
publisher.publish(HistoryArchivesSeedingSignal)
```

**B. Manual Archive Creation:**
```
Discord Import or other triggers
    ↓
SeedHistoryArchiveTorrent() [directly]
    ↓
publisher.publish(HistoryArchivesSeedingSignal)
```

**C. Archive Download Completion:**
```
DownloadHistoryArchivesByMagnetlink() [when downloading completes]
    ↓
publisher.publish(HistoryArchivesSeedingSignal) [line 642]
```

### **2. The Publishing Pipeline**

```
SeedHistoryArchiveTorrent()
    ↓
publisher.publish(HistoryArchivesSeedingSignal) [internal event]
    ↓
handleCommunitiesHistoryArchivesSubscription() [event handler]
    ↓
IF community.IsControlNode():
    dispatchMagnetlinkMessage(communityID)
    ↓
    Create CommunityMessageArchiveMagnetlink protobuf
    ↓
    messaging.SendPublic(context, chatID, rawMessage)
    ↓
    [WAKU NETWORK]
```

### **3. Key Publication Details**

**The Message Structure:**
```go
magnetLinkMessage := &protobuf.CommunityMessageArchiveMagnetlink{
    Clock:     m.getTimesource().GetCurrentTime(),
    MagnetUri: magnetlink,  // BitTorrent magnetlink
}

rawMessage := messagingtypes.RawMessage{
    LocalChatID:          chatID,                    // community.MagnetlinkMessageChannelID()
    Sender:               community.PrivateKey(),    // Signed by community owner
    Payload:              encodedMessage,
    MessageType:          protobuf.ApplicationMetadataMessage_COMMUNITY_MESSAGE_ARCHIVE_MAGNETLINK,
    SkipGroupMessageWrap: true,                     // Direct message, no encryption wrapper
    PubsubTopic:          community.PubsubTopic(),  // Community's pubsub topic
    Priority:             &messagingtypes.LowPriority,
}
```

**Where it's Published:**
- **Topic**: Community's pubsub topic (`community.PubsubTopic()`)
- **Chat ID**: `community.MagnetlinkMessageChannelID()` (special channel for magnetlinks)
- **Sender**: Community owner's private key
- **Network**: Public Waku network via `messaging.SendPublic()`

### **4. Who Can Publish Magnetlinks?**

Only **community control nodes** (owners) can publish magnetlink messages:
```go
if c.IsControlNode() {
    err := m.dispatchMagnetlinkMessage(sub.HistoryArchivesSeedingSignal.CommunityID)
}
```

### **5. When are Magnetlinks Published?**

1. **After creating new archives** (periodic archive creation)
2. **After seeding existing archives** (on startup/reboot)
3. **After downloading and re-seeding archives** (when community owners download from other peers)
4. **After Discord imports** (when historical data is imported)

### **6. The Network Flow**

```
Community Owner Node:
   Archive Creation → Seeding → HistoryArchivesSeedingSignal
                                           ↓
                          dispatchMagnetlinkMessage()
                                           ↓
                          messaging.SendPublic() → [WAKU NETWORK]
                                                          ↓
                                                   [All Community Members]
                                                          ↓
                                                  RetrieveAll() receives messages
                                                          ↓
                                                  handleRetrievedMessages()
                                                          ↓
                                                  HandleHistoryArchiveMagnetlinkMessage()
                                                          ↓
                                                  downloadAndImportHistoryArchives()
```

### **7. Complete Publication Locations Summary**

**Primary Publication Point:**
- `dispatchMagnetlinkMessage()` in messenger_communities.go
- Called when `HistoryArchivesSeedingSignal` is received
- Only for community control nodes
- Publishes to community's pubsub topic

**Network Layer:**
- `messaging.SendPublic()` → `sendCommunity()` → `dispatchCommunityMessage()` → `transport.SendCommunityMessage()`
- Eventually reaches Waku network via `transport.api.Post()`

**The magnetlink messages flow from community owners to all community members via the Waku network**, triggering automatic archive downloads when members receive them through their normal message processing loop!
