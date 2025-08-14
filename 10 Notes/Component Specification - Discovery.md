# Codex DHT - Component specification
## 1. Purpose and Scope
### What the component does.
The Codex DHT is a modified clone of the DiscV5 DHT. The upstream library is https://github.com/status-im/nim-eth/tree/master/eth/p2p/discoveryv5 which is based on Ethereum's discv5 specification: https://github.com/ethereum/devp2p/blob/master/discv5/discv5.md. It has been modified in order to store Codex's signed-peer-record (SPR) entries, as well as content identifiers (CID) for each host. This allows users of the Codex DHT to publish their connection information formatted as an SPR, as well as information regarding the datasets they are storing. CIDs are converted into NodeId values, which are used as keys in the DHT. The value of each DHT entry is a variable sized array of SPRs.
The Codex DHT is limited to DHT specific operations: publishing and looking up of DHT records. DHT records will automatically expire and disappear from the network. It is the responsibility of the user to periodically re-publish relevant records.

## 2. Interfaces
| Interface | Description | Input | Output |
|-----------|-------------|-------|--------|
| `newProtocol` | Creates new instance of the Codex DHT | Private key, connection information, bootstrap node records, configuration options. | New Codex DHT instance object. |
| `open` | First initialization step. | - | - |
| `start` | Second initialization step. | - | - |
| `closeWait` | Decommissioning step. Blocks until network resources are closed. | - | - |
| `updateRecord` | Sets a new SPR as the local node's record. | SPR, which can be constructed from a private key, peerId, and an array of multiaddresses. | - |
| `removeProvidersLocal` | Removes an SPR from the local instance of the Codex DHT. | PeerId of the record to be removed. | - |
| `addProvider` | Adds the SPR of the local node to a new or existing DHT entry. | NodeId to be added to, which can be constructed from address information or CID. | - |
| `getProviders` | Looks up the DHT entries for a NodeId. | NodeId (again, from address or CID). | An array of SPRs. |
| `resolve` | Looks up a peer record given a NodeId. | NodeId. | PeerRecord if found. Contains PeerId, sequence-number, and an array of multiaddresses. |

## 3. Functional requirements
List of features or behaviors the component must provide.
### General
- The component provides logging information.
- The component raises exceptions in case of errors.
- The component returns nullable or optional values where appropriate.
### Network maintenance
- The component requires bootstrap node information at initialization.
- The component requires connection information describing its own network accessability at initialization.
- The component enables the user to update its own network accessability information during operation.
- The component uses the bootstrap node information to contact other nodes in the network.
- When contacting other nodes, the component will:
  - Provide its own connection information
  - Query other nodes for their connection information
  - Maintain a list of other nodes adhering to the following constraints:
    - The entries of nodes in this list will contain:
      - Connection information
      - Timing information
      - Reliability information
    - When the number of entries in the list is too small as defined by configuration parameters, the component will actively query other nodes for previously undiscovered connection information.
    - When the number of entries in the list is too large as defined by configuration parameters, the component will remove the least relevant entries as determined by entry information.
    - The component will perform a random lookup every 5 minutes.
### Publishing records
 - The component enables the user to publish DHT records containing its own connection information for a given NodeId.
   - The component will contact other nodes in the network to disseminate new and updated records.
### Querying records
 - The component enables the user to query DHT records for a given NodeId.
   - The component will contact other nodes in the network to perform queries.

## 4. Non-Functional Requirements
Performance, security, scalability, reliability, etc.
### Performance
 - The component will respond to messages from other nodes within 1 second.
 - The component will respond to user interaction within 1 second.
 - The component will produce a timeout when other nodes do not respond to its messages within 1 second.
### Security
 - The component will disregard unsigned records.
 - The component will verify record signatures.
 - The component will sign its records before transmitting them.
### Scalability
 - The component will discard stale records as defined by configuration parameters.
 - The component will deprioritize the distribution of connection information for nodes in the network that appear unresponsive.
 - When performing queries, the component will prioritize communication with other nodes most likely to contain the desired records.

## 5. Internal Behavior
Description of algorithms, workflows, or state machines.
Include diagrams if needed.

### Distances, routing-tables, storage, and retrieval
See: https://github.com/libp2p/specs/tree/master/kad-dht

### Message flows
| Message | Cause | Payload | Response |
|---------|-------|---------|----------|
| PingMessage | Periodic node evaluation. | Sequence number. | PongMessage |
| PongMessage | Ping message | Sequence number, ip address, port. | Administration is updated. |
| FindNodeMessage | Component is attempting to locate another node. | Array of distances. | NodesMessage |
| NodesMessage | FindNodeMessage | Array of SPRs | Administration is update and open queries may be resolved. |
| TalkReqMessage | Used internally to query available protocols. | Array of protocol ids. | TalkRespMessage |
| TalkRespMessage | TalkReqMessage | Supported protocols ids. | User application may now communicate via new protocol |
| AddProviderMessage | Component is attempting to add a new provider record. | NodeId and SPR. | Records are updated. |
| GetProvidersMessage | Component is attempting to look up a record. | NodeId | ProvidersMessage is records are found. |
| ProvidersMessage | GetProvidersMessage | Array of SPRs | Administration is update and open queries may be resolved. |
| FindNodeFastMessage | Used internally for fast-lookups. | NodeId | NodesMessage |

## 6. Dependencies
| Dependency | Implementation |
|------------|----------------|
| libp2p | nim-libp2p >= 1.5.0 & < 2.0.0 |
| storage | nim-datastore >= 0.2.0 & < 0.3.0 |
| cryptography | secp256k1 >= 0.6.0 & < 0.7.0, nimcrypto >= 0.6.2 & < 0.7.0, bearssl >= 0.2.5 & < 0.3.0, |
| debugging | metrics >= 0.1.0 & < 0.2.0, chronicles >= 0.10.2 & < 0.11.0 |
| core | nim >= 2.0.14 & < 3.0.0, protobuf_serialization >= 0.3.0 & < 0.4.0, chronos >= 4.0.3 & < 4.1.0, stew >= 0.2.0 & < 0.3.0, stint >= 0.8.1 & < 0.9.0, questionable >= 0.10.15 & < 0.11.0 |

## 7. Data Models
Data structures, schemas, or classes used or produced.

### Nodes and stats
```
  Stats* = object
    rttMin*: float #millisec
    rttAvg*: float #millisec
    bwAvg*: float #bps
    bwMax*: float #bps
```

```
  Node* = ref object
    id*: NodeId
    pubkey*: PublicKey
    address*: Option[Address]
    record*: SignedPeerRecord
    seen*: float ## Indicates if there was at least one successful
    ## request-response with this node, or if the nde was verified
    ## through the underlying transport mechanisms. After first contact
    ## it tracks how reliable is the communication with the node.
    stats*: Stats # traffic measurements and statistics
```

### Protocol and configuration
```
  DiscoveryConfig* = object
    tableIpLimits*: TableIpLimits
    bitsPerHop*: int
```

```
  Protocol* = ref object
    localNode*: Node
    privateKey: PrivateKey
    transport*: Transport[Protocol] # exported for tests
    routingTable*: RoutingTable
    awaitedMessages: Table[(NodeId, RequestId), Future[Option[Message]]]
    refreshLoop: Future[void]
    revalidateLoop: Future[void]
    ipMajorityLoop: Future[void]
    debugPrintLoop: Future[void]
    lastLookup: chronos.Moment
    bootstrapRecords*: seq[SignedPeerRecord]
    ipVote: IpVote
    enrAutoUpdate: bool
    talkProtocols*: Table[seq[byte], TalkProtocol] # TODO: Table is a bit of
    rng*: ref HmacDrbgContext
    providers: ProvidersManager
```

### Distance calculation
```
  DistanceProc* = proc(a, b: NodeId): NodeId {.raises: [Defect], gcsafe, noSideEffect.}
  LogDistanceProc* = proc(a, b: NodeId): uint16 {.raises: [Defect], gcsafe, noSideEffect.}
  IdAtDistanceProc* = proc (id: NodeId, dist: uint16): NodeId {.raises: [Defect], gcsafe, noSideEffect.}

  DistanceCalculator* = object
    calculateDistance*: DistanceProc
    calculateLogDistance*: LogDistanceProc
    calculateIdAtDistance*: IdAtDistanceProc
```

### Routing table
```
  IpLimits* = object
    limit*: uint
    ips: Table[IpAddress, uint]

  RoutingTable* = object
    localNode*: Node
    buckets*: seq[KBucket]
    bitsPerHop: int ## This value indicates how many bits (at minimum) you get
    ## closer to finding your target per query. Practically, it tells you also
    ## how often your "not in range" branch will split off. Setting this to 1
    ## is the basic, non accelerated version, which will never split off the
    ## not in range branch and which will result in log base2 n hops per lookup.
    ## Setting it higher will increase the amount of splitting on a not in range
    ## branch (thus holding more nodes with a better keyspace coverage) and this
    ## will result in an improvement of log base(2^b) n hops per lookup.
    ipLimits: IpLimits ## IP limits for total routing table: all buckets and
    ## replacement caches.
    distanceCalculator: DistanceCalculator
    rng: ref HmacDrbgContext

  KBucket = ref object
    istart, iend: NodeId ## Range of NodeIds this KBucket covers. This is not a
    ## simple logarithmic distance as buckets can be split over a prefix that
    ## does not cover the `localNode` id.
    nodes*: seq[Node] ## Node entries of the KBucket. Sorted according to last
    ## time seen. First entry (head) is considered the most recently seen node
    ## and the last entry (tail) is considered the least recently seen node.
    ## Here "seen" means a successful request-response. This can also not have
    ## occured yet.
    replacementCache: seq[Node] ## Nodes that could not be added to the `nodes`
    ## seq as it is full and without stale nodes. This is practically a small
    ## LRU cache.
    ipLimits: IpLimits ## IP limits for bucket: node entries and replacement
    ## cache entries combined.

  ## The routing table IP limits are applied on both the total table, and on the
  ## individual buckets. In each case, the active node entries, but also the
  ## entries waiting in the replacement cache are accounted for. This way, the
  ## replacement cache can't get filled with nodes that then can't be added due
  ## to the limits that apply.
  ##
  ## As entries are not verified (=contacted) immediately before or on entry, it
  ## is possible that a malicious node could fill (poison) the routing table or
  ## a specific bucket with SPRs with IPs it does not control. The effect of
  ## this would be that a node that actually owns the IP could have a difficult
  ## time getting its SPR distrubuted in the DHT and as a consequence would
  ## not be reached from the outside as much (or at all). However, that node can
  ## still search and find nodes to connect to. So it would practically be a
  ## similar situation as a node that is not reachable behind the NAT because
  ## port mapping is not set up properly.
  ## There is the possiblity to set the IP limit on verified (=contacted) nodes
  ## only, but that would allow for lookups to be done on a higher set of nodes
  ## owned by the same identity. This is a worse alternative.
  ## Next, doing lookups only on verified nodes would slow down discovery start
  ## up.
  TableIpLimits* = object
    tableIpLimit*: uint
    bucketIpLimit*: uint

  NodeStatus* = enum
    Added
    LocalNode
    Existing
    IpLimitReached
    ReplacementAdded
    ReplacementExisting
    NoAddress
```
