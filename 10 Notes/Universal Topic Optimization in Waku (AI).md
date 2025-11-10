> Since we created this document we gained a bit more understanding of how topics and filters work in status-go and waku: please check [[Filters, Topics, Channels, and Chat IDs in status-go and waku]].

There is [a comment in the code base](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/community.go#L1584-L1589):

```go
// Using Member updates channelID as chatID to act as a universal content-topic 
// for all chats in the community as explained here 
// https://forum.vac.dev/t/status-communities-review-and-proposed-usage-of-waku-content-topics/335
```

See: [https://forum.vac.dev/t/status-communities-review-and-proposed-usage-of-waku-content-topics/335](https://forum.vac.dev/t/status-communities-review-and-proposed-usage-of-waku-content-topics/335)

This comment refers to a **universal topic optimization** that Status implemented to improve efficiency in the Waku messaging protocol. Let me explain how this relates to Waku:

### What is a ContentTopic in Waku?

In Waku, a **ContentTopic** is like a messaging channel identifier - it's a 4-byte value that tells Waku which messages are intended for which application features. Think of it as the "address" where specific types of messages should be delivered.

From the code I found, here's how ContentTopic works:

```go
// From messaging/waku/common/topic.go
func (t TopicType) ContentTopic() string {
    enc := hexutil.Encode(t[:])
    return "/waku/1/" + enc + "/rfc26"
}
```

This creates a topic like `/waku/1/0x12345678/rfc26` where `0x12345678` is the 4-byte topic.

### The Universal Topic Optimization

Originally, you might expect each community chat to have its own unique ContentTopic:
- `#general` → ContentTopic `0x12345678`  
- `#random` → ContentTopic `0x87654321`
- `#dev` → ContentTopic `0xabcdef12`

But Status implemented a **universal topic optimization** where all chats in a community share the **same ContentTopic**. Here's how:

```go
// From protocol/communities/community.go lines 1584-1588
func (o *Community) UniversalChatID() string {
    // Using Member updates channelID as chatID to act as a universal content-topic 
    // for all chats in the community as explained here 
    // https://forum.vac.dev/t/status-communities-review-and-proposed-usage-of-waku-content-topics/335
    return o.MemberUpdateChannelID()
}

func (o *Community) MemberUpdateChannelID() string {
    return o.IDString() + "-memberUpdate"
}
```

So instead of separate topics, **all community chats** use the same ContentTopic: `{communityID}-memberUpdate`.

### How This Works with Filters

When you join a community, Status creates **one Filter** (subscription) that receives messages for **all channels** in that community:

```go
// From messenger_community_chat_test.go
universalChatFilter := s.m.messaging.ChatFilterByChatID(community.UniversalChatID())
```

This single filter subscribes to the universal ContentTopic, and **all messages** from all channels in the community flow through this one subscription.

### Benefits of This Optimization

1. **Fewer Network Subscriptions**: Instead of subscribing to N different ContentTopics (one per channel), you subscribe to just 1
2. **Reduced Network Overhead**: Fewer pubsub subscriptions mean less network management
3. **Simplified Filter Management**: The FiltersManager only needs to track one filter per community instead of one per channel
4. **Better Message Delivery**: All community messages come through the same reliable channel

### How Messages Are Distinguished

Since all messages use the same ContentTopic, how does Status know which channel a message belongs to? The **message payload** contains the actual destination channel information. The universal topic is just for **transport optimization** - the application logic still correctly routes messages to the right channels.

### Relation to Waku Protocol

This optimization is specifically about how Status uses Waku's **pubsub topics and content filtering**:

- **PubsubTopic**: The "physical" network topic (like a network shard)
- **ContentTopic**: The "logical" application channel (like an app feature)
- **Filter**: The subscription that tells Waku "I want messages from this ContentTopic"

By using one ContentTopic for all community channels, Status reduces the load on Waku's **content filtering system** while maintaining the logical separation of channels at the application layer.

This is a clever optimization that maintains user experience (separate channels) while improving network efficiency (shared transport).