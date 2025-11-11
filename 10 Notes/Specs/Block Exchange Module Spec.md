# Codex Block Exchange Module Specification

## Introduction

The Block Exchange Module is a core component of Codex responsible for peer-to-peer content distribution. It handles the sending and receiving of blocks across the network, enabling efficient data sharing between Codex nodes.

## Overview

The Codex Block Exchange Protocol is a libp2p-based protocol for exchanging content blocks between Codex nodes.

The protocol enables efficient peer-to-peer content distribution by:
- Advertising block availability to interested peers
- Requesting blocks from peers who have them
- Delivering blocks with Merkle proofs for tree-structured data (both erasure-coded and regular datasets)

### Block Format

In Codex, a block is formally defined as a tuple consisting of raw data and its content identifier: `(data: seq[byte], cid: Cid)`.

**Block Creation:**
- Content is chunked into fixed-size blocks (default: 64 KiB)
- The last block is padded with zeros if necessary
- Each block's CID uses:
  - Multicodec: `codex-block` (0xCD02)
  - Multihash: `sha2-256` (0x12)

**Block Addressing:**
Blocks can be addressed in two ways:
- **Standalone blocks**: Direct CID reference
- **Tree blocks**: Reference by `(treeCid, blockIndex)` for blocks within Merkle tree structures (both regular files and erasure-coded datasets)

### Module Context

The Block Exchange Protocol is the wire protocol used by Codex's Block Exchange Module. The module provides the following public interface:

- `requestBlock(address: BlockAddress): Future[?!Block]` - Request a single block by address
- `requestBlock(cid: Cid): Future[?!Block]` - Request a single block by CID
- `requestBlocks(addresses: seq[BlockAddress]): SafeAsyncIter[Block]` - Request multiple blocks as an async iterator

The module integrates with:
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
