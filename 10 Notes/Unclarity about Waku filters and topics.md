> Since we created this document we gained a bit more understanding of how topics and filters work in status-go and waku: please check [[Filters, Topics, Channels, and Chat IDs in status-go and waku]].


This is the definition of the `ChatFilter` type:

```go
type ChatFilter struct {
	chatID       string
	filterID     string
	identity     string
	pubsubTopic  string
	contentTopic ContentTopic
	discovery    bool
	negotiated   bool
	listen       bool
	ephemeral    bool
	priority     uint64
}
```

For each community, we can have a number of filters. This is how we get them.

```go
func (m *ArchiveManager) GetCommunityChatsFilters(communityID types.HexBytes) (messagingtypes.ChatFilters, error) {
	chatIDs, err := m.persistence.GetCommunityChatIDs(communityID)
	if err != nil {
		return nil, err
	}

	filters := messagingtypes.ChatFilters{}
	for _, cid := range chatIDs {
		filter := m.messaging.ChatFilterByChatID(cid)
		if filter != nil {
			filters = append(filters, filter)
		}
	}
	return filters, nil
}
```

Perhaps simplifying too much, a *filter* is basically a reference to a waku pubsub channel where the messages can be posted/received: all messages for all chats in that community. This seems to be related to [[Universal Topic Optimization in Waku (AI)]].

What is associated with a filter is a `contentTopic` and the filters are used to make sure we later get all relevant community messages. But here we get a lot of strange inconsistencies. First, if there suppose to be a single universal topic for the community, why do we still have multiple filters:

```go
filters, err := m.archiveManager.GetCommunityChatsFilters(c.ID())
if err != nil {
	m.logger.Error("failed to get community chats filters for community", zap.Error(err))
	continue
}

if len(filters) == 0 {
	m.logger.Debug("no filters or chats for this community starting interval", zap.String("id", c.IDString()))
	go m.archiveManager.StartHistoryArchiveTasksInterval(c, messageArchiveInterval)
	continue
}
```

The why the universal filter is only included later, and never mapped to the corresponding topics?

```go
topics := []messagingtypes.ContentTopic{}

for _, filter := range filters {
	topics = append(topics, filter.ContentTopic())
}

filter := m.messaging.ChatFilterByChatID(c.UniversalChatID())
if filter != nil {
	filters = append(filters, filter)
}
```

It is kind of crucial, because the topics are effectively used to get the messages in [GetWakuMessagesByFilterTopic](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/manager_archive_file.go#L125) (check the body of this function [here](https://github.com/status-im/status-go/blob/6322f22783585474803cfc8a6f0a914757d763b5/protocol/communities/persistence.go#L967-L1000)).
