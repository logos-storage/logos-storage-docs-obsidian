marcinczenko: can you remind me how `ArchiveIndexCidClock` from the community description is used? Can you summarize how community description messages are sent and received and how they relate to magent links/indexCid updates - I remembered that community description had some impact on processing magnet links. I just to remember the details...

GitHub Copilot: I'll help you understand how `ArchiveIndexCidClock` is used and how it relates to community description messages and index CID updates.

Let me search for relevant code to give you a complete picture. 

Searched text for `ArchiveIndexCidClock`, 2 results

Searched text for `ArchiveMagnetlinkClock`, 2 results

Searched text for `HandleCommunityDescriptionMessage`, 12 results

Now let me look at the specific section where the clock comparison happens: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager.go#2310-2310), lines 2310 to 2360

Now let me check how these clocks are updated from the persistence layer and how magnetlink/indexCid messages are handled: 

Searched text for `UpdateCommunityDescriptionIndexCidMessageClock`, 2 results

Searched text for `UpdateCommunityDescriptionMagnetlinkMessageClock`, 2 results

Searched codebase for "handle archive magnetlink index CID message torrent community", 14 results

Now let me look at the index CID related code: 

Searched text for `HandleIndexCidMessage`, no results

Searched text for `dispatchIndexCidMessage`, 2 results

Searched text for `CommunityMessageArchiveIndexCid`, 9 results

Now let me look at these handler functions: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#3785-3785), lines 3785 to 3825

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#4145-4145), lines 4145 to 4205

Now let me check the HandleHistoryArchiveIndexCidMessage: 

Searched text for `HandleHistoryArchiveIndexCidMessage`, 2 results

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#1344-1344), lines 1344 to 1414

Perfect! Now let me check how the persistence saves this and look at the protobuf definition: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/protobuf/communities.proto#220-220), lines 220 to 270

Searched text for `SaveCommunityArchiveInfo`, 2 results

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/persistence.go#1023-1023), lines 1023 to 1083

Perfect! Now I have a complete picture. Let me provide you with a comprehensive summary:

## Summary: How `ArchiveIndexCidClock` and Community Description Messages Work

### **Community Description Clocks for Archives**

The community description contains two clock fields for tracking archive distribution:
1. **`ArchiveMagnetlinkClock`** - tracks the clock of the last magnetlink (torrent) message  
2. **`ArchiveIndexCidClock`** - tracks the clock of the last index CID (Codex) message

These clocks are stored in the **community description protobuf** itself and are propagated when the community description is updated and distributed.

---

### **How Community Description Messages Are Sent**

1. **Control node creates/updates community** → Community description is updated with current state
2. **Community description is marshaled** → Converted to protobuf format
3. **Wrapped in ApplicationMetadataMessage** → Signed and wrapped
4. **Published to community channels** → Sent to all members via waku

The community description includes:
- All community metadata (name, description, members, etc.)
- Token permissions
- **Archive clocks**: `ArchiveMagnetlinkClock` and `ArchiveIndexCidClock`

---

### **How Community Description Messages Are Received**

When a node receives a community description message:

**In `handleCommunityDescriptionMessageCommon()` (line 2295):**

```go
// 1. Update the community with the new description
changes, err := community.UpdateCommunityDescription(description, payload, newControlNode)

// 2. Check if archive info exists in local DB
hasCommunityArchiveInfo, err := m.persistence.HasCommunityArchiveInfo(community.ID())

// 3. Extract clocks from the received community description
cdMagnetlinkClock := community.config.CommunityDescription.ArchiveMagnetlinkClock
cdIndexCidClock := community.config.CommunityDescription.ArchiveIndexCidClock

// 4. If no archive info exists, save it with the clocks from CD
if !hasCommunityArchiveInfo {
    err = m.persistence.SaveCommunityArchiveInfo(community.ID(), cdMagnetlinkClock, 0, cdIndexCidClock)
} else {
    // 5. If archive info exists, compare clocks and update if CD has newer clock
    
    // For magnetlink:
    magnetlinkClock, err := m.persistence.GetMagnetlinkMessageClock(community.ID())
    if cdMagnetlinkClock > magnetlinkClock {
        err = m.persistence.UpdateMagnetlinkMessageClock(community.ID(), cdMagnetlinkClock)
    }
    
    // For index CID:
    indexCidClock, err := m.persistence.GetIndexCidMessageClock(community.ID())
    if cdIndexCidClock > indexCidClock {
        err = m.persistence.UpdateIndexCidMessageClock(community.ID(), cdIndexCidClock)
    }
}
```

---

### **The Key Insight: Community Description Clock Comparison**

The **community description acts as a checkpoint** for archive distribution state. When nodes receive a community description:

- **They compare the CD's archive clocks** with their local archive info clocks
- **If CD has newer clocks**, they update their local tracking
- This ensures that even if a node **missed** the actual magnetlink/indexCid messages, they'll know there's a newer archive available when they receive the next community description

---

### **How Magnetlink/IndexCid Messages Work**

**When control node dispatches archive messages:**

1. **Control node seeds archive** → Creates torrent/uploads to Codex
2. **Dispatches message** (magnetlink or indexCid) → Sent to community
3. **Updates CD clock** → Updates `ArchiveMagnetlinkClock` or `ArchiveIndexCidClock` in community description
4. **Updates local tracking** → Also updates local persistence tables

**When member receives archive message:**

```go
// In HandleHistoryArchiveIndexCidMessage (line 1344):

// 1. Get the last clock from LOCAL tracking table
lastIndexCidClock, err := m.communitiesManager.GetIndexCidMessageClock(id)
lastMagnetlinkClock, err := m.communitiesManager.GetMagnetlinkMessageClock(id)

// 2. Compare with incoming message clock
// 3. If incoming clock >= lastClock, process it (download archives)
// 4. Update local tracking clocks
```

---

### **Why This Design?**

This dual-tracking system (CD clocks + local tracking) provides:

1. **Resilience**: If a node misses the actual archive message, the next community description will let them know there's a newer archive
2. **Synchronization**: New members get the latest archive clock immediately when they join (via CD)
3. **Deduplication**: Prevents re-downloading the same archive multiple times
4. **Preference support**: Can compare clocks from both methods (torrent vs Codex) to support distribution preferences

---

### **Database Storage**

All tracked in `communities_archive_info` table:
- `magnetlink_clock` - last seen magnetlink message clock
- `index_cid_clock` - last seen index CID message clock  
- `last_magnetlink_uri` - actual magnetlink string
- `last_index_cid` - actual CID string

The community description clocks act as a "high water mark" that gets propagated with every CD update, while the local tracking tables record what archive messages were actually processed.

marcinczenko: ok, so it looks like the clocks in community description prevent from downloading and processing outdated archives?

Can you also show me:

(1) where the control node opdates ArchiveMagnetlinkClock or ArchiveIndexCidClock in community description
(2) when and where community description are sent (show me where it is in code as well)

GitHub Copilot: Great question! Yes, exactly - the clocks in the community description act as a "high water mark" to prevent processing outdated archives. Let me show you the code for both parts:

## (1) Where Control Node Updates Archive Clocks in Community Description 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#4081-4081), lines 4081 to 4131

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#250-250), lines 250 to 290

Now let me find where the community description clock is actually updated: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#4130-4130), lines 4130 to 4160

Perfect! Now let me see where `UpdateCommunityDescriptionMagnetlinkMessageClock` and `UpdateCommunityDescriptionIndexCidMessageClock` actually update the CD: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager.go#3696-3696), lines 3696 to 3726

Excellent! Now let me find where `SaveCommunity` triggers the community description to be published:

## (2) When and Where Community Descriptions Are Sent 

Searched text for `func (m *Manager) SaveCommunity`, 4 results

Searched text for `func (m *Manager) saveAndPublish`, 2 results

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager.go#5102-5102), lines 5102 to 5162

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager.go#4604-4604), lines 4604 to 4644

Now let me find the `publish` function to see how it actually sends the community description: 

Searched text for `func (m *Manager) publish(`, 1 result

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager.go#747-747), lines 747 to 767

Now let me find where the subscription is consumed and the actual message is sent: 

Searched text for `handleCommunitiesSubscription`, 3 results

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#306-306), lines 306 to 406

Perfect! Now let me find the `publishOrg` function: 

Searched text for `func (m *Messenger) publishOrg`, 1 result

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#115-115), lines 115 to 195

Perfect! Now I have all the information. Let me provide you with a comprehensive answer:

---

## Summary: How Archive Clocks Are Updated and Community Descriptions Are Sent

### (1) Where Control Node Updates Archive Clocks in Community Description

**The Flow:**

1. **Archive is seeded** → Archive manager detects seeding is complete
2. **Signal is published** → `HistoryArchivesSeedingSignal` is sent via subscription
3. **Control node dispatches archive messages** → Sends magnetlink/indexCid messages
4. **Control node updates CD clocks** → Updates `ArchiveMagnetlinkClock` or `ArchiveIndexCidClock`

**The Code Path:**

```
protocol/messenger_communities.go:250-270 (handleCommunitiesHistoryArchivesSubscription)
└─> When HistoryArchivesSeedingSignal received and IsControlNode():
    ├─> dispatchMagnetlinkMessage() (line 4099)
    │   └─> UpdateCommunityDescriptionMagnetlinkMessageClock() (line 4138)
    │       └─> manager.go:3696 - Sets community.config.CommunityDescription.ArchiveMagnetlinkClock
    │           └─> SaveCommunity() - Saves to DB
    │
    └─> dispatchIndexCidMessage() (line 4145) 
        └─> UpdateCommunityDescriptionIndexCidMessageClock() (line 4183)
            └─> manager.go:3708 - Sets community.config.CommunityDescription.ArchiveIndexCidClock
                └─> SaveCommunity() - Saves to DB
```

**Key Code Locations:**

**In `messenger_communities.go:250-270`:**
```go
if c.IsControlNode() {
    if sub.HistoryArchivesSeedingSignal.MagnetLink {
        err := m.dispatchMagnetlinkMessage(sub.HistoryArchivesSeedingSignal.CommunityID)
    }
    if sub.HistoryArchivesSeedingSignal.IndexCid {
        err := m.dispatchIndexCidMessage(sub.HistoryArchivesSeedingSignal.CommunityID)
    }
}
```

**In `messenger_communities.go:4138-4142`:**
```go
// After sending magnetlink message:
err = m.communitiesManager.UpdateCommunityDescriptionMagnetlinkMessageClock(community.ID(), magnetLinkMessage.Clock)
```

**In `manager.go:3696-3705`:**
```go
func (m *Manager) UpdateCommunityDescriptionMagnetlinkMessageClock(communityID types.HexBytes, clock uint64) error {
    community, err := m.GetByIDString(communityID.String())
    community.config.CommunityDescription.ArchiveMagnetlinkClock = clock
    return m.SaveCommunity(community)  // ← Saves to DB
}
```

**Important:** Note that `SaveCommunity()` **only saves to the database** - it does NOT automatically publish the community description! The CD will be published later through the periodic check or when other changes trigger a publish.

---

### (2) When and Where Community Descriptions Are Sent

**There are TWO main ways community descriptions are published:**

#### **A. Event-Driven Publishing (Immediate)**

When changes happen (like updating clocks, editing community, accepting members), the code calls:

**`saveAndPublish()` → `manager.go:4608-4638`**
```go
func (m *Manager) saveAndPublish(community *Community) error {
    err := m.SaveCommunity(community)  // Save to DB
    if err != nil {
        return err
    }
    
    if community.IsControlNode() {
        m.publish(&Subscription{Community: community})  // ← Publish event
        return nil
    }
    // ... handle admin events
}
```

**`publish()` → `manager.go:747-759`**
```go
func (m *Manager) publish(subscription *Subscription) {
    for _, s := range m.subscriptions {
        s <- subscription  // ← Send to subscription channel
    }
}
```

#### **B. Subscription Handler (Actual Network Send)**

**`handleCommunitiesSubscription()` → `messenger_communities.go:307-406`**

This goroutine listens to the subscription channel:

```go
func (m *Messenger) handleCommunitiesSubscription(c chan *communities.Subscription) {
    // Checks every 5 minutes
    ticker := time.NewTicker(5 * time.Minute)
    
    go func() {
        for {
            select {
            case sub := <-c:  // ← Receives from subscription channel
                if sub.Community != nil {
                    publishOrgAndDistributeEncryptionKeys(community)
                }
            case <-ticker.C:  // ← Periodic check every 5 minutes
                // ... republish if needed
            }
        }
    }()
}
```

The `publishOrgAndDistributeEncryptionKeys` function then calls:

**`publishOrg()` → `messenger_communities.go:115-159`**
```go
func (m *Messenger) publishOrg(org *communities.Community, shouldRekey bool) error {
    payload, err := org.MarshaledDescription()  // ← Marshal community description
    
    rawMessage := messagingtypes.RawMessage{
        Payload:             payload,
        Sender:              org.PrivateKey(),
        SkipEncryptionLayer: true,
        MessageType:         protobuf.ApplicationMetadataMessage_COMMUNITY_DESCRIPTION,
        PubsubTopic:         org.PubsubTopic(),
        Priority:            &messagingtypes.HighPriority,
    }
    
    messageID, err := m.messaging.SendPublic(context.Background(), org.IDString(), rawMessage)
    // ← Actually sends to the network via Waku
    return err
}
```

---

### **The Complete Flow:**

```
1. Control Node Seeds Archive
   └─> HistoryArchivesSeedingSignal published

2. dispatchMagnetlinkMessage() or dispatchIndexCidMessage()
   ├─> Sends actual magnetlink/indexCid message to network
   └─> UpdateCommunityDescriptionMagnetlinkMessageClock()
       └─> Updates community.config.CommunityDescription.ArchiveMagnetlinkClock
           └─> SaveCommunity() - saves to DB only

3. Later (when CD is published for any reason):
   └─> saveAndPublish() called OR periodic check triggers
       └─> publish(&Subscription{Community: community})
           └─> handleCommunitiesSubscription receives event
               └─> publishOrg()
                   └─> MarshaledDescription() - includes updated clocks
                       └─> SendPublic() - sends to Waku network

4. Members receive Community Description
   └─> HandleCommunityDescriptionMessage()
       └─> handleCommunityDescriptionMessageCommon()
           └─> Compares CD clocks with local tracking
               └─> Updates local tracking if CD has newer clocks
```

---

### **Key Insights:**

1. **Archive clocks are updated in CD immediately** when magnetlink/indexCid messages are dispatched
2. **CD is NOT immediately published** - it waits for the next publish event or periodic check
3. **CD includes the updated clocks** whenever it's eventually published
4. **This design ensures** that even if members miss the actual magnetlink/indexCid message, they'll get the updated clock in the next CD update
5. **The clocks prevent reprocessing** - members won't download the same archive twice because they compare incoming message clocks against both the CD clocks and their local tracking

This is why you can miss an archive message but still know there's a newer archive available - the CD acts as a "checkpoint" that gets propagated with every community update!