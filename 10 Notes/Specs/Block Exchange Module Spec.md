# Codex Block Exchange Specification

The Block Exchange (BE) is a core component of Codex and is responsible for peer-to-peer content distribution. It handles the sending and receiving of blocks across the network, enabling efficient data sharing between Codex nodes.

## Overview

The Codex Block Exchange defines both an internal service and a protocol through which Codex nodes can refer to, and provide data blocks to one another. Blocks are uniquely identifiable by means of an _address_, and represent fixed-length chunks of arbitrary data. 

Whenver a peer $A$ wishes to obtain a block, it registers its unique address with the BE, and the BE will then be in charge of procuring it; i.e, of finding a peers that has block, if any, and then downloading it. The BE will also accept requests from peers connected to $A$ which might want blocks that $A$ have, and provide them.

**Discovery separation.** Throughout this document we assume that if $A$ wants a block $b$ with id $\text{id}(b)$, then $A$ has the means to locate and connect to peers which either:

1. have $b$;
2. are reasonably expected to obtain $b$ in the future.

In practical implementations, the BE will typically require the support of an underlying _discovery service_, e.g., the [Codex DHT](), to look up such peers, but this is beyond the scope of this document.

### Block Format

Blocks in Codex can be of two different types:

* **standalone blocks** are self-contained pieces of data addressed by a content ID made from the SHA256 hash of the contents of the block;
* **dataset blocks**, instead, are part of an ordered set (a dataset) and can be _additionally_ addressed by a `(datasetCID, index)` tuple which indexes the block within that dataset. `datasetCID`, here, represents the root of a Merkle tree computed over all the blocks in the dataset. In other words, a dataset block can be addressed both as a standalone block (by a CID computed over the contents of the block), or as an index within an ordered set identified by a Merkle root.

Formally, we can defined a block as tuple consisting of raw data and its content identifier: `(data: seq[byte], cid: Cid)`, where standalone blocks are addressed by `cid`, and dataset blocks can be addressed either by `cid` or a `(datasetCID, index)` tuple.

**Creating blocks.** Blocks in Codex have default size of 64 KiB. Blocks within a dataset must be all of the same size. If a dataset does not contain enough data to fill its last block, it MUST be padded with zeroes.

**Multicodec/Multihash.** The libp2p multicodec for a block CID is `codex-block` (0xCD02), while the multihash is `sha2-256` (0x12).

### Service Interface

The BE service allows a peer to register block addresses with the underlying service for retrieval. It exposes a two primitives for that:

```python
async def requestBlock(address: BlockAddress) -> Block:
   pass

async def cancelRequest(address: BlockAddress) -> bool:
    pass
```

`requestBlock` registers a block for retrieval and can be awaited on, whereas `cancelRequest` cancels a previously registered request.

## Dependencies

In practice, the BE relies on other modules and services:

- **Discovery Module**: DHT-based peer discovery for content
- **Local Store (Repo Store)**: Persistent block storage
- **Advertiser**: Announces block availability to the DHT
- **Network Layer**: libp2p-based peer connections and message transport

## Protocol Identifier

The Block Exchange Protocol uses the following libp2p protocol identifier:

```
/codex/blockexc/1.0.0
```

## Connection Model

The protocol operates over libp2p streams. When a node wants to communicate with a peer:

1. The initiating node dials the peer using the protocol identifier
2. A bidirectional stream is established
3. Both sides can send and receive messages on this stream
4. Messages are encoded using Protocol Buffers
5. The stream remains open for the duration of the exchange session
6. Peers track active connections in a peer context store

The protocol handles peer lifecycle events:
- **Peer Joined**: When a peer connects, it is added to the active peer set
- **Peer Departed**: When a peer disconnects gracefully, its context is cleaned up
- **Peer Dropped**: When a peer connection fails, it is removed from the active set

## Message Format

All messages exchanged between peers use Protocol Buffers encoding.

### Message Structure

```protobuf
message Message {
  Wantlist wantlist = 1;
  repeated BlockDelivery payload = 3;
  repeated BlockPresence blockPresences = 4;
  int32 pendingBytes = 5;
  AccountMessage account = 6;
  StateChannelUpdate payment = 7;
}
```

**Field Descriptions:**

- `wantlist`: Requests for blocks (presence checks or full block requests)
- `payload`: Block deliveries being sent to the peer
- `blockPresences`: Block presence information (have/don't have)
- `pendingBytes`: Number of bytes currently pending delivery to this peer
- `account`: Ethereum account information for receiving payments
- `payment`: Nitro state channel update for micropayments

### Block Addressing

Codex uses a block addressing scheme that supports both simple content-addressed blocks and blocks within Merkle tree structures.

```protobuf
message BlockAddress {
  bool leaf = 1;
  bytes treeCid = 2;    // Present when leaf = true
  uint64 index = 3;     // Present when leaf = true
  bytes cid = 4;        // Present when leaf = false
}
```

**Addressing Modes:**

- **Simple Block** (`leaf = false`): Direct CID reference to a standalone content block
- **Tree Block** (`leaf = true`): Reference to a block within a Merkle tree by tree CID and index. The tree may represent either an erasure-coded dataset or a regular uploaded file organized in a tree structure

### WantList

The WantList allows a peer to request blocks or check for block availability.

```protobuf
message Wantlist {
  enum WantType {
    wantBlock = 0;
    wantHave = 1;
  }

  message Entry {
    BlockAddress address = 1;
    int32 priority = 2;
    bool cancel = 3;
    WantType wantType = 4;
    bool sendDontHave = 5;
  }

  repeated Entry entries = 1;
  bool full = 2;
}
```

**Field Descriptions:**

- **Entry.address**: The block being requested
- **Entry.priority**: Request priority (currently always 0)
- **Entry.cancel**: If true, cancels a previous want for this block
- **Entry.wantType**:
  - `wantHave (1)`: Only check if peer has the block
  - `wantBlock (0)`: Request full block data
- **Entry.sendDontHave**: If true, peer should respond even if it doesn't have the block
- **full**: If true, this WantList replaces all previous wants; if false, it's a delta update

**Delta WantList Updates:**

The protocol supports efficient delta updates where only changes to the WantList are transmitted:
- New blocks are added to the peer's want list
- Cancelled blocks are removed from the peer's want list
- Delta updates use `full = false`
- Full replacements use `full = true`

### Block Delivery

Block deliveries contain the actual block data with Merkle proofs for tree blocks.

```protobuf
message BlockDelivery {
  bytes cid = 1;
  bytes data = 2;
  BlockAddress address = 3;
  bytes proof = 4;  // Present only when address.leaf = true
}
```

**Field Descriptions:**

- `cid`: Content identifier of the block
- `data`: Raw block data (up to 100 MiB)
- `address`: The address that was requested
- `proof`: Merkle proof (CodexProof) verifying block correctness (required for tree blocks)

**Merkle Proof Verification:**

When delivering tree blocks (`address.leaf = true`):
- The delivery must include a Merkle proof (CodexProof)
- The proof verifies that the block at the given index is correctly part of the Merkle tree identified by the tree CID
- This applies to all tree-structured data, whether erasure-coded or not
- Recipients must verify the proof before accepting the block
- Invalid proofs result in block rejection

### Block Presence

Block presence messages indicate whether a peer has specific blocks.

```protobuf
enum BlockPresenceType {
  presenceHave = 0;
  presenceDontHave = 1;
}

message BlockPresence {
  BlockAddress address = 1;
  BlockPresenceType type = 2;
  bytes price = 3;
}
```

**Field Descriptions:**

- `address`: The block address being referenced
- `type`: Whether the peer has the block or not
- `price`: Price (UInt256 format)

### Payment Messages

Payment-related messages for micropayments using Nitro state channels.

```protobuf
message AccountMessage {
  bytes address = 1;  // Ethereum address to which payments should be made
}

message StateChannelUpdate {
  bytes update = 1;   // Signed Nitro state, serialized as JSON
}
```

**Field Descriptions:**

- `AccountMessage.address`: Ethereum address for receiving payments
- `StateChannelUpdate.update`: Nitro state channel update containing payment information
