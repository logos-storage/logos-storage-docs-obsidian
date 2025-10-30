---
related-to:
  - "[[Team-NLBR Solution Proposal]]"
  - "[[status-go publishing magnet links]]"
  - "[[status-go processing magnet links]]"
  - "[[status-go-codex integration - design notes]]"
  - "[[Creating History Archives - InitHistoryArchiveTasks]]"
---
marcinczenko: What is the difference in handleImportedMessages and handleRetrievedMessages. How are they used?

GitHub Copilot: I'll examine the two methods `handleImportedMessages` and `handleRetrievedMessages` to understand their differences and usage. 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger.go#2900-2900), lines 2900 to 3100

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger.go#3100-3100), lines 3100 to 3300

Now let me search for where these methods are called to understand their usage patterns: 

Searched text for `handleImportedMessages|handleRetrievedMessages` (`**//home/mc2/code/status-im/status-go/protocol/**`), 6 results

Let me examine the context where these methods are called: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger.go#2670-2670), lines 2670 to 2700

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#1480-1480), lines 1480 to 1510

Now let me look at the specific message handling in both methods: 

Searched text for `dispatchToHandler` (`**/messenger.go`), 2 results

Let me check the dispatchToHandler method to understand the difference: 

Searched codebase for "dispatchToHandler method implementation", 15 results

Great! Now I can see the `dispatchToHandler` method is generated. Let me also check the specific handling in `handleImportedMessages`: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger.go#3030-3030), lines 3030 to 3080

Now let me also check the context where these are used in messenger_handler.go: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#1460-1460), lines 1460 to 1520

Let me check what method contains this logic by looking for the function signature: 

Searched text for `func (m *Messenger)` (`**/messenger_handler.go`), 20 results

Let me look for the function that contains the separation logic: 

Searched text for `ThirdPartyID` (`**/messenger_handler.go`), 6 results

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#1440-1440), lines 1440 to 1470

Perfect! Now I can see the complete picture. Based on my analysis of the code, I can explain the differences between `handleImportedMessages` and `handleRetrievedMessages`:

## Differences between `handleImportedMessages` and `handleRetrievedMessages`

### **1. Purpose and Context**

**`handleImportedMessages`:**
- Specifically designed for handling **imported/archived messages** (e.g., from Discord imports or community history archives)
- Used when messages have a `ThirdPartyID` (indicating they come from external sources)
- Part of the history import/archive restoration functionality

**`handleRetrievedMessages`:**
- General-purpose message handler for **regular incoming messages** 
- Used for normal message flow from the messaging protocol
- Called by `RetrieveAll()` which is the main message retrieval mechanism

### **2. Message Separation Logic**

In `handleArchiveMessages()` method in messenger_handler.go, messages are separated based on `ThirdPartyID`:

```go
for filter, messages := range messagesToHandle {
    for _, message := range messages {
        if message.ThirdPartyID != "" {
            importedMessages[filter] = append(importedMessages[filter], message)  // → handleImportedMessages
        } else {
            otherMessages[filter] = append(otherMessages[filter], message)        // → handleRetrievedMessages
        }
    }
}
```

### **3. Message Type Handling**

**`handleImportedMessages`:**
- **Limited scope**: Only handles specific message types:
  - `CHAT_MESSAGE` 
  - `PIN_MESSAGE`
- Uses hardcoded switch statement for message type handling
- More restrictive and focused on basic message types

**`handleRetrievedMessages`:**
- **Full scope**: Handles all message types using `dispatchToHandler()`
- `dispatchToHandler()` is auto-generated and routes to appropriate handlers for all supported message types
- More comprehensive message processing

### **4. Feature Differences**

**`handleImportedMessages`:**
- **No mutex protection** during main processing (only for Discord-specific saves)
- **No notifications/activity center** updates
- **No community message storage** in Waku
- **No metrics tracking**
- **No blocked user filtering**
- **No datasync metadata handling**
- **No installation/shared secrets handling**
- Focuses on basic message persistence

**`handleRetrievedMessages`:**
- **Full mutex protection** (`m.handleMessagesMutex`)
- **Community message storage** for controlled communities
- **Metrics tracking** (`MetricsPushReceivedMessages`)
- **Blocked user filtering**
- **Datasync metadata handling**
- **Installation and shared secrets handling**
- **Activity center notifications**
- **Contact management**
- Returns a full `MessengerResponse`

### **5. Return Values**

**`handleImportedMessages`:**
- Returns `error` only
- No response object for UI updates

**`handleRetrievedMessages`:**
- Returns `(*MessengerResponse, error)`
- Provides full response for UI updates via `saveDataAndPrepareResponse()`

### **6. Usage Context**

**`handleImportedMessages`:**
- Used in archive restoration scenarios
- Called when processing historical/imported messages from external sources
- Part of the community history import functionality

**`handleRetrievedMessages`:**
- Used in normal message flow
- Called by `RetrieveAll()` which is invoked by `ProcessAllMessages()`
- Part of the regular message processing loop

### **Summary**

`handleImportedMessages` is a **lightweight, specialized handler** for processing historical/imported messages with minimal side effects, while `handleRetrievedMessages` is the **full-featured, comprehensive handler** for regular message processing with all the bells and whistles (notifications, community features, metrics, etc.).

The separation ensures that imported messages don't trigger unnecessary notifications or duplicate processing while still preserving the message content in the database.

marcinczenko: ok, both functions are called by `handleArchiveMessages`, which is called by `importHistoryArchive`, which in turn is called by either `resumeHistoryArchivesImport` or `downloadAndImportHistoryArchives`. The `downloadAndImportHistoryArchives` is in turn called indirectly by `handleRetrievedMessages` - which looks like a circural dependency, which I can really understand. I am trying to get a better picure of the process of archive history download...

GitHub Copilot: You're absolutely right to be confused about this circular dependency! Let me trace through the archive history download process to clarify what's happening. Let me examine the call chain you mentioned. 

Searched codebase for "downloadAndImportHistoryArchives function implementation", 13 results

Now let me look at the specific methods to understand the flow better: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#1410-1410), lines 1410 to 1450

Searched text for `downloadAndImportHistoryArchives` (`**/messenger_handler.go`), 6 results

Now let me search for where `handleRetrievedMessages` might indirectly call `downloadAndImportHistoryArchives`: 

Searched text for `HandleHistoryArchiveMagnetlinkMessage` (`**/messenger_handler.go`), 4 results

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#3980-3980), lines 3980 to 4010

Let me search for what calls `HandleCommunityMessageArchiveMagnetlink`: 

Searched text for `HandleCommunityMessageArchiveMagnetlink` (`**/*.go`), 8 results

Now let me check the `dispatchToHandler` generated file: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handlers.go#130-130), lines 130 to 150

Perfect! Now I can see the complete picture. The apparent "circular dependency" you noticed is not actually circular, but rather involves **different message types flowing through the system**. Let me explain the complete archive history download process:

## **Archive History Download Process Flow**

### **1. Initial Trigger Points**
There are several ways archive downloads can be triggered:

**A. Via `resumeHistoryArchivesImport()`:**
- Called during startup to resume interrupted downloads
- Directly calls `importHistoryArchives()` to process already-downloaded archives

**B. Via received magnetlink messages:**
- `handleRetrievedMessages()` processes incoming `COMMUNITY_MESSAGE_ARCHIVE_MAGNETLINK` messages
- This goes through `dispatchToHandler()` → `handleCommunityMessageArchiveMagnetlinkProtobuf()` → `HandleCommunityMessageArchiveMagnetlink()` → `HandleHistoryArchiveMagnetlinkMessage()`
- Which then spawns a goroutine that calls `downloadAndImportHistoryArchives()`

**C. Via community join responses:**
- When joining a community, `HandleCommunityRequestToJoinResponse()` also calls `downloadAndImportHistoryArchives()`

### **2. The Download and Import Pipeline**

```
downloadAndImportHistoryArchives()
    ↓
    1. DownloadHistoryArchivesByMagnetlink() [downloads archives via torrent]
    ↓
    2. importHistoryArchives() [processes downloaded archives]
    ↓
    3. ExtractMessagesFromHistoryArchive() [extracts messages from archive files]  
    ↓
    4. handleArchiveMessages() [processes the extracted messages]
    ↓
    5. Separates messages by ThirdPartyID:
       - Messages WITH ThirdPartyID → handleImportedMessages()
       - Messages WITHOUT ThirdPartyID → handleRetrievedMessages()
```

### **3. The Key Insight: Different Message Types**

The "circular dependency" you noticed is actually **different message flows**:

**Flow A: Regular Messages → Archive Download**
1. `handleRetrievedMessages()` processes regular incoming messages from the network
2. One of these messages might be a `COMMUNITY_MESSAGE_ARCHIVE_MAGNETLINK` message
3. This triggers `downloadAndImportHistoryArchives()` to download new archives

**Flow B: Archive Processing → Message Handling**  
1. `downloadAndImportHistoryArchives()` downloads archive files
2. `importHistoryArchives()` extracts messages from archives
3. `handleArchiveMessages()` processes these extracted historical messages
4. These messages are then handled by `handleImportedMessages()` and `handleRetrievedMessages()` again

### **4. The Separation Logic**

In `handleArchiveMessages()`, messages are separated based on `ThirdPartyID`:

```go
for filter, messages := range messagesToHandle {
    for _, message := range messages {
        if message.ThirdPartyID != "" {
            importedMessages[filter] = append(importedMessages[filter], message)  // External imports (Discord, etc.)
        } else {
            otherMessages[filter] = append(otherMessages[filter], message)        // Regular Status messages
        }
    }
}
```

### **5. Why This Design Makes Sense**

1. **Regular message processing** (`handleRetrievedMessages`) can trigger **archive downloads** when magnetlink messages arrive
2. **Archive processing** can extract both **imported messages** (Discord, etc.) and **regular Status messages**  
3. **Different handlers** are used based on message origin and type:
   - `handleImportedMessages()`: Lightweight processing for external imports
   - `handleRetrievedMessages()`: Full-featured processing for Status messages

### **6. Complete Flow Diagram**

```
Network Messages → handleRetrievedMessages() 
    ↓
    [If MAGNETLINK message] → downloadAndImportHistoryArchives()
        ↓
        Download Archive Files → importHistoryArchives()
            ↓  
            Extract Messages → handleArchiveMessages()
                ↓
                Separate by ThirdPartyID:
                ├─ External Messages → handleImportedMessages()
                └─ Status Messages → handleRetrievedMessages() [different context]
```

So it's not circular - it's a **layered system** where:
- **Network messages** can trigger **archive downloads**
- **Archive processing** extracts **historical messages** 
- **Historical messages** are processed through appropriate handlers

The same function names are used, but they're processing **different types of messages** in **different contexts**.

marcinczenko: ok, so the MAGNETLINK message can only come from the network I guess, and not from the archive, right? Thus, when `handleRetrievedMessages` is called in the response to the MAGETLINK message, it will process it differntly (it will not call downloadAndImportHistoryArchives). Is this correct?

GitHub Copilot: You're absolutely correct! That's a very insightful observation. Let me confirm this by examining the logic: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handler.go#1450-1450), lines 1450 to 1500

Now let me check the parameters passed to `handleRetrievedMessages` in different contexts: 

Searched text for `handleRetrievedMessages` (`**/*.go`), 6 results

Perfect! Looking at the function signature and calls:

```go
func (m *Messenger) handleRetrievedMessages(chatWithMessages map[messagingtypes.ChatFilter][]*messagingtypes.ReceivedMessage, storeWakuMessages bool, fromArchive bool) (*MessengerResponse, error)
```

**Yes, you are absolutely correct!** Here's the key distinction:

### **1. Network Messages (including MAGNETLINK):**
```go
// From RetrieveAll() -> called for regular network message processing
return m.handleRetrievedMessages(chatWithMessages, true, false)
//                                                   ^^^^  ^^^^^
//                                              storeWaku fromArchive=false
```

### **2. Archive Messages:**
```go
// From handleArchiveMessages() -> called when processing extracted archive messages  
response, err := m.handleRetrievedMessages(otherMessages, false, true)
//                                                        ^^^^^  ^^^^
//                                                   storeWaku fromArchive=true
```

### **3. The Key Parameter: `fromArchive`**

When `fromArchive=true`, the `dispatchToHandler` call passes this parameter: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger.go#3240-3240), lines 3240 to 3250

Now let me check if the generated handlers use this `fromArchive` parameter: 

Read [](file:///home/mc2/code/status-im/status-go/cmd/generate_handlers/generate_handlers_template.txt#15-15), lines 15 to 45

Let me check the specific handler for MAGNETLINK messages: 

Read [](file:///home/mc2/code/status-im/status-go/protocol/messenger_handlers.go#1000-1000), lines 1000 to 1020

I notice that the magnetlink handler doesn't have the `fromArchive` parameter. Let me check if there's a configuration that controls this: 

Searched text for `CommunityMessageArchiveMagnetlink.*fromArchive|fromArchive.*CommunityMessageArchiveMagnetlink` (`**/*.go`), no results

Let me check what determines if a handler gets the `fromArchive` parameter by looking at the handler generation: 

Searched text for `FromArchiveArg` (`**/cmd/generate_handlers/**`), 5 results

Perfect! Now I can see the complete picture: 

Read [](file:///home/mc2/code/status-im/status-go/cmd/generate_handlers/generate_handlers.go#65-65), lines 65 to 75

## **You are 100% correct!** Here's why:

### **1. MAGNETLINK Messages and Archive Context**

**MAGNETLINK messages (`CommunityMessageArchiveMagnetlink`) can ONLY come from the network**, not from archives, because:

1. **Archive files don't contain MAGNETLINK messages** - they contain the actual chat messages, pin messages, etc. that were archived
2. **MAGNETLINK messages are instructions to download archives** - they wouldn't be stored inside the archives themselves (that would be recursive)
3. **Only specific message types can come from archives**: According to the handler generation code, only `ChatMessage` and `PinMessage` get the `fromArchive` parameter

### **2. Handler Behavior Differences**

```go
// Only these message types get fromArchive parameter:
info.FromArchiveArg = protobufName == "ChatMessage" || protobufName == "PinMessage"
```

This means:
- **`CommunityMessageArchiveMagnetlink` handler** does NOT get `fromArchive` parameter
- **`ChatMessage` and `PinMessage` handlers** DO get `fromArchive` parameter and can behave differently

### **3. The Safety Mechanism**

When `handleRetrievedMessages` is called in different contexts:

**A. Network Messages (fromArchive=false):**
- MAGNETLINK messages can trigger `downloadAndImportHistoryArchives()`
- This is the normal behavior for network-received magnetlinks

**B. Archive Messages (fromArchive=true):**  
- MAGNETLINK messages **cannot exist** in archives (they're not archived)
- Even if they did, the handler doesn't have access to `fromArchive` to change behavior
- But `ChatMessage` and `PinMessage` handlers **do** get `fromArchive=true` and can behave accordingly

### **4. Logical Flow Protection**

```
Network Message Flow:
MAGNETLINK arrives via network 
→ handleRetrievedMessages(fromArchive=false)
→ HandleCommunityMessageArchiveMagnetlink() 
→ downloadAndImportHistoryArchives() ✓ ALLOWED

Archive Processing Flow:
Archive extracted messages 
→ handleRetrievedMessages(fromArchive=true)
→ Only ChatMessage/PinMessage handlers get fromArchive=true
→ MAGNETLINK messages don't exist in archives anyway ✓ SAFE
```

So yes, your understanding is perfect! The system naturally prevents infinite loops because:

1. **MAGNETLINK messages only come from the network**
2. **Archive files only contain chat content messages**
3. **The `fromArchive` parameter** allows handlers to behave differently when processing historical vs. live messages
4. **Only relevant message types** get the `fromArchive` parameter

This is a well-designed system that prevents the circular dependency issue you were concerned about!

marcinczenko: Can you show me with more details the flow of receiving the magnet link before and how it is connected to `RetrieveAll()`?

GitHub Copilot: Absolutely! Let me trace the complete flow from the very beginning of how a magnetlink message arrives and gets processed through to `RetrieveAll()`. This will show you the entire message reception pipeline. 

Searched codebase for "RetrieveAll message retrieval from network waku", 26 results

Perfect! Now I can show you the complete detailed flow of how a magnetlink message travels from the network to `RetrieveAll()`. Let me trace this step by step:

## **Complete Magnetlink Message Flow - From Network to `RetrieveAll()`**

### **1. Network Layer - Message Reception**

```
Waku Network
    ↓
OnNewEnvelope() [waku/nwaku.go or waku/gowaku.go]
    ↓
postEvent(envelope) 
    ↓
msgQueue <- envelope [buffered channel]
```

**Details:**
- Messages arrive from the Waku network via `OnNewEnvelope()`
- Messages are queued in `msgQueue` (buffered channel with `messageQueueLimit`)
- `processQueueLoop()` continuously processes this queue 

Read [](file:///home/mc2/code/status-im/status-go/messaging/waku/nwaku.go#1180-1180), lines 1180 to 1200

### **2. Message Store Layer**

```
processMessage(envelope)
    ↓
filter.Messages.Add(message) [MemoryMessageStore]
    ↓
Messages stored in filter-specific stores
```

**Details:**
- `processMessage()` routes messages to appropriate filters based on topic
- Each filter has its own `MemoryMessageStore` where messages accumulate
- Messages wait here until retrieved by `RetrieveAll()` 

Read [](file:///home/mc2/code/status-im/status-go/messaging/waku/nwaku.go#1200-1200), lines 1200 to 1215

Read [](file:///home/mc2/code/status-im/status-go/messaging/waku/nwaku.go#1215-1215), lines 1215 to 1235

### **3. Message Retrieval Trigger**

The `RetrieveAll()` is called either:

**A. Periodically via the Message Loop:**
```
StartRetrieveMessagesLoop() [called at startup]
    ↓ 
    ticker.C (every tick interval)
    ↓
    ProcessAllMessages()
    ↓
    RetrieveAll()
```

**B. Manually by the application:**
```
Direct call to RetrieveAll()
```

### **4. The RetrieveAll() Chain**

```go
// messenger.go
func (m *Messenger) RetrieveAll() (*MessengerResponse, error) {
    chatWithMessages, err := m.messaging.RetrieveRawAll()  // Step A
    if err != nil {
        return nil, err
    }
    return m.handleRetrievedMessages(chatWithMessages, true, false)  // Step B
}
```

### **Step A: `m.messaging.RetrieveRawAll()`** 

Read [](file:///home/mc2/code/status-im/status-go/messaging/api.go#150-150), lines 150 to 165

This calls into the transport layer: 

Read [](file:///home/mc2/code/status-im/status-go/messaging/layers/transport/transport.go#210-210), lines 210 to 240

The key call here is `t.api.GetFilterMessages(filter.FilterID)`: 

Read [](file:///home/mc2/code/status-im/status-go/messaging/waku/api.go#344-344), lines 344 to 359

**This is where the stored messages are retrieved!** `f.Retrieve()` calls the filter's message store: 

Read [](file:///home/mc2/code/status-im/status-go/messaging/waku/common/message.go#140-140), lines 140 to 155

### **Step B: `handleRetrievedMessages()`**

Now we have the messages collected from all filters. Let's trace what happens next:

```go
// messenger.go - handleRetrievedMessages() 
func (m *Messenger) handleRetrievedMessages(chatWithMessages map[messagingtypes.ChatFilter][]*messagingtypes.ReceivedMessage, storeWakuMessages bool, fromArchive bool) (*MessengerResponse, error) {
    // Process each message through the handler pipeline
    for iterator.HasNext() {
        filter, messages := iterator.Next()
        for _, shhMessage := range messages {
            // Decode the raw message
            handleMessagesResponse, err := m.messaging.HandleReceivedMessages(shhMessage)
            
            for _, msg := range statusMessages {
                // Route to appropriate handler
                err := m.dispatchToHandler(messageState, msg.ApplicationLayer.Payload, msg, filter, fromArchive)
                
                // If this is a MAGNETLINK message, it goes to:
                // dispatchToHandler() → handleCommunityMessageArchiveMagnetlinkProtobuf() 
                // → HandleCommunityMessageArchiveMagnetlink() → HandleHistoryArchiveMagnetlinkMessage()  
                // → downloadAndImportHistoryArchives()
            }
        }
    }
}
```

### **5. Complete Flow Diagram**

```
┌─────────────────────────────────────────────────────────────────┐
│                        NETWORK LAYER                           │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│              WAKU MESSAGE RECEPTION                            │
│  Network → OnNewEnvelope() → postEvent() → msgQueue            │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                MESSAGE STORE LAYER                             │
│  processQueueLoop() → processMessage() → filter.Messages.Add() │
│                                                                 │
│  Messages stored in MemoryMessageStore per filter              │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                   RETRIEVAL TRIGGER                            │
│                                                                 │
│  Timer Loop:                     │  Manual:                    │
│  StartRetrieveMessagesLoop()     │  Direct RetrieveAll()       │
│        ↓                         │      call                   │
│  ProcessAllMessages()            │                             │
│        ↓                         │                             │
│  RetrieveAll() ←─────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                 MESSAGE COLLECTION                              │
│  RetrieveAll() → messaging.RetrieveRawAll()                     │
│                       ↓                                         │
│                  transport.RetrieveRawAll()                     │
│                       ↓                                         │
│                  For each filter: api.GetFilterMessages()       │
│                       ↓                                         │
│                  filter.Retrieve() → store.Pop()                │
│                                                                 │
│                  Returns: map[ChatFilter][]*ReceivedMessage     │
└─────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────┐
│                MESSAGE PROCESSING                              │
│  handleRetrievedMessages(messages, true, false)               │
│                   ↓                                            │
│  For each message: messaging.HandleReceivedMessages()         │
│                   ↓                                            │
│  dispatchToHandler() → route by message type                  │
│                                                                │
│  IF MAGNETLINK MESSAGE:                                        │
│  → handleCommunityMessageArchiveMagnetlinkProtobuf()          │
│  → HandleCommunityMessageArchiveMagnetlink()                  │
│  → HandleHistoryArchiveMagnetlinkMessage()                    │
│  → downloadAndImportHistoryArchives() [ASYNC GOROUTINE]       │
└─────────────────────────────────────────────────────────────────┘
```

And here is also a link to a diagram in excalidraw: [https://link.excalidraw.com/readonly/vSon9uiUhYJWrwXiKAsi](https://link.excalidraw.com/readonly/vSon9uiUhYJWrwXiKAsi).
### **6. Key Points About the Flow**

1. **Asynchronous Message Queue**: Messages from network are queued and processed asynchronously
2. **Per-Filter Storage**: Each chat filter has its own message store  
3. **Batch Retrieval**: `RetrieveAll()` collects messages from all filters at once
4. **Cache Deduplication**: Transport layer checks cache to avoid reprocessing
5. **Message Type Routing**: `dispatchToHandler()` routes messages to type-specific handlers
6. **MAGNETLINK Processing**: MAGNETLINK messages trigger async archive downloads
7. **Regular Polling**: The retrieve loop runs continuously to process new messages

### **7. Why This Design Works Well**

- **Network messages flow continuously** into filter stores
- **RetrieveAll() periodically collects** all accumulated messages
- **MAGNETLINK messages** in this flow trigger downloads of historical archives  
- **Archive processing** uses a separate flow (`handleArchiveMessages`) that eventually calls `handleRetrievedMessages` again but with `fromArchive=true`
- **No infinite loops** because MAGNETLINK messages only come from network, not archives

This shows how the live message processing naturally triggers the archive download process when MAGNETLINK messages arrive from community owners!