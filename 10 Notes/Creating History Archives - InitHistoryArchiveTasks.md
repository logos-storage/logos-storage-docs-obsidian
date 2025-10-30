---
related-to:
  - "[[Team-NLBR Solution Proposal]]"
  - "[[status-go publishing magnet links]]"
  - "[[status-go processing magnet links]]"
  - "[[status-go-codex integration - design notes]]"
  - "[[Creating History Archives - InitHistoryArchiveTasks]]"
---
## **Connection Flow: `InitHistoryArchiveTasks` → `StartHistoryArchiveTasksInterval`**

### **1. Where `InitHistoryArchiveTasks` is Called** 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger.go#640-640), lines 640 to 655

`InitHistoryArchiveTasks` is called from **two main places**:

**A. During `Messenger.Start()` (startup):**
```go
// In messenger.go Start() method
controlledCommunities, err := m.communitiesManager.Controlled()
if err != nil {
    return nil, err
}

if m.archiveManager.IsReady() {
    go func() {
        // Wait for store node to be available
        select {
        case <-m.ctx.Done():
            return
        case <-m.messaging.OnStorenodeAvailable():
        }
        m.InitHistoryArchiveTasks(controlledCommunities)  // CALLED HERE
    }()
}
```

**B. When enabling archive protocol:**
```go
// In EnableCommunityHistoryArchiveProtocol()
controlledCommunities, err := m.communitiesManager.Controlled()
if err != nil {
    return err
}

if len(controlledCommunities) > 0 {
    go m.InitHistoryArchiveTasks(controlledCommunities)  // CALLED HERE
}
```

### **2. What `InitHistoryArchiveTasks` Does** 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#3770-3770), lines 3770 to 3810

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#3810-3810), lines 3810 to 3840

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#3840-3840), lines 3840 to 3880

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_communities.go#3880-3880), lines 3880 to 3895

### **3. How `StartHistoryArchiveTasksInterval` Works** 

Read [](file:///home/mc2/code/status-im/status-go/protocol/communities/manager_archive.go#320-320), lines 320 to 345

## **Complete Connection Flow**

Here's the detailed connection between `InitHistoryArchiveTasks` and `StartHistoryArchiveTasksInterval`:

### **1. Initialization Chain**

```
Messenger.Start() [startup]
    ↓
Wait for store node availability 
    ↓
InitHistoryArchiveTasks(controlledCommunities)
    ↓
For each controlled community:
    ├─ Check if archive support enabled
    ├─ Seed existing torrents if available  
    ├─ Get community chat filters/topics
    ├─ Request missed messages from store nodes
    ├─ Check last archive timestamp
    └─ Decide archive strategy:
        ├─ Case 1: No archives yet → StartHistoryArchiveTasksInterval()
        ├─ Case 2: Recent archive → Seed + delayed start → StartHistoryArchiveTasksInterval()  
        └─ Case 3: Old archive → Create new + StartHistoryArchiveTasksInterval()
```

### **2. The Three Archive Strategy Cases**

**Case 1: No Previous Archives (`lastArchiveEndDateTimestamp == 0`)**
```go
// No prior messages to be archived, so we just kick off the archive creation loop
// for future archives
go m.archiveManager.StartHistoryArchiveTasksInterval(c, messageArchiveInterval)
```

**Case 2: Recent Archive (`durationSinceLastArchive < messageArchiveInterval`)**
```go
// Last archive is less than `interval` old, wait until `interval` is complete,
// then create archive and kick off archive creation loop for future archives
// Seed current archive in the meantime
err := m.archiveManager.SeedHistoryArchiveTorrent(c.ID())

timeToNextInterval := messageArchiveInterval - durationSinceLastArchive
time.AfterFunc(timeToNextInterval, func() {
    err := m.archiveManager.CreateAndSeedHistoryArchive(c.ID(), topics, lastArchiveEndDate, to.Add(timeToNextInterval), messageArchiveInterval, c.Encrypted())
    go m.archiveManager.StartHistoryArchiveTasksInterval(c, messageArchiveInterval)
})
```

**Case 3: Old Archive (`durationSinceLastArchive >= messageArchiveInterval`)**
```go
// Looks like the last archive was generated more than `interval`
// ago, so lets create a new archive now and then schedule the archive
// creation loop
err := m.archiveManager.CreateAndSeedHistoryArchive(c.ID(), topics, lastArchiveEndDate, to, messageArchiveInterval, c.Encrypted())

go m.archiveManager.StartHistoryArchiveTasksInterval(c, messageArchiveInterval)
```

### **3. What `StartHistoryArchiveTasksInterval` Does**

```go
func (m *ArchiveManager) StartHistoryArchiveTasksInterval(community *Community, interval time.Duration) {
    // 1. Check if already running for this community
    if _, exists := m.historyArchiveTasks.Load(id); exists {
        return  // Already running
    }

    // 2. Set up cancellation and tracking
    cancel := make(chan struct{})
    m.historyArchiveTasks.Store(id, cancel)
    m.historyArchiveTasksWaitGroup.Add(1)

    // 3. Start periodic ticker
    ticker := time.NewTicker(interval)  // Default: 1 hour intervals
    
    // 4. Archive creation loop
    for {
        select {
        case <-ticker.C:
            // Every interval, create and seed new archive
            err = m.CreateAndSeedHistoryArchive(community.ID(), topics, lastArchiveEndDate, to, interval, community.Encrypted())
            
        case <-cancel:
            // Cleanup and exit
            m.UnseedHistoryArchiveTorrent(community.ID())
            m.historyArchiveTasks.Delete(id)
            m.historyArchiveTasksWaitGroup.Done()
            return
        }
    }
}
```

### **4. The Interval Constants** 

Searched text for `messageArchiveInterval` (`**/messenger_communities.go`), 20 results

The default interval is **7 days** (`7 * 24 * time.Hour`).

### **5. Complete Flow Summary**

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

So `InitHistoryArchiveTasks` is the **initialization and setup function** that analyzes each community's archive state and decides how to start the periodic archive creation, while `StartHistoryArchiveTasksInterval` is the **long-running background worker** that actually performs the periodic archive creation every 7 days.

The connection is that `InitHistoryArchiveTasks` **always ends up calling** `StartHistoryArchiveTasksInterval` for each community (either immediately, delayed, or after creating a catch-up archive), making it the entry point that bootstraps the entire periodic archive system.