# Proving Module Specification

## 1. Purpose and Scope

### Purpose/Motivation
In decentralized storage networks, such as Codex one of the main challenges is ensuring durability and availablity of the data stored by storage providers (SP). To achieve durability, random sampling (along with erasure coding) is used to provide probabilistic guarantees while touching only a tiny fraction of the stored data per challenge. 

The primary purpose of the proving module is to provide a succinct, publicly verifiable way to check that an SP still holds the data it committed to. It samples cells from the stored slot, and turns those samples and Merkle paths into a small Groth16 proof that ties back to the published dataset root. The marketplace contract verifies this proof on-chain and uses the result to manage incentives e.g. payments and slashing. 

### Scope
The scope of this specification document is limited to the proving module which consists of the following functionalities:

- Checks for storage proof requests.
- Samples cells from a slot in the stored dataset and constructs Merkle proofs.
- Generates zero-knowledge proofs for randomly selected cells in the stored slots.
- Submits proofs to verifier in the network (the on-chain marketplace smart contract).

The Proving module relies on `blockStore` for storage and `SlotsBuilder` to build initial commitments to the stored data. Additionally, this document doesn't specify the incentives involved (collateral and slashing), which is handled by the marketplace logic.

### Terminology

| Term | Description |
|------|-------------|
| **Storage Client (SC)** | A node that participates in Codex to buy storage. |
| **Storage Provider (SP)** | A node that participates in Codex by selling disk space to other nodes. |
| **Dataset** | A set of fixed-size slots provided by (possibly different) SCs. |
| **Cell** | Smallest circuit sampling unit (e.g., 2 KiB), its bytes are packed into field elements and hashed. |
| **Block** | Network transfer unit (e.g., 64 KiB) consists of multiple cells, used for transport. |
| **Slot** | The erasure-coded fragment of a dataset stored by a single SP. proof requests are related to slots. |
| **Commitment** | Cryptographic binding (and hiding if needed) to specific data. In Codex this is a Poseidon2 Merkle root (e.g., Dataset Root or Slot Root). It allows anyone to verify proofs against the committed content. |
| **Dataset Root / Slot Root** | Poseidon2 Merkle roots used as public commitments in the circuit. Not the SHA-256 content tree used for CIDs. |
| **Entropy** | Public randomness (e.g., blockhash) used to derive random sample indices. |
| **Witness** | Private zk circuit inputs.|
| **Public Inputs** | Values known to (or shared with) the verifier. |
| **Groth16** | Succinct zk-SNARK proof system used by Codex. |
| **Proof Window** | The time/deadline within which the SP must submit a valid proof. |

## 2. Interfaces

### Component Overview
The Prover module consists of three main components:

1. **Builder**: turns raw bytes into zk-SNARK-friendly commitments.
2. **Sampler**: derives random sample indices from public entropy and slot commitments, and then generates the proof input. 
3. **Prover**: produces succinct ZK proofs for valid proof inputs, and verifies such proofs. 


### Component Interfaces 
Below are the main interfaces for each component. The interfaces below omit getters, setters, and internal functions, instead it focuses on main functions needed.
`T` denotes the Merkle tree type (supports all Merkle tree functionality).
`H` denotes the digest/hash element type (e.g., Poseidon2Hash) used for leaves, paths, and roots.


**Builder interfaces:**

| Interface         | Description                                                                                                                                                         | Input                                                                                                | Output              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------- |
| `new`             | Create a new `SlotsBuilder` instance.                                                                                                                               | `blockStore: BlockStore`, `manifest: Manifest`, `strategy: IndexingStrategyType`, `cellSize: NBytes` | `SlotsBuilder[T,H]` |
| `buildBlockTree`  | Build the block Merkle tree and return the block data and the tree.                                                                                                 | `blkIdx: Natural`, `slotPos: Natural`                                                                | `(seq[byte], T)`    |
| `buildSlotTree`   | Build the slot Merkle tree from the block-tree roots and return the tree. Calls `buildBlockTree` internally.                                                        | `slotIndex: Natural`                                                                                 | `T`                 |
| `buildVerifyTree` | Build the verification (dataset) Merkle tree from slot roots.                                                                                                       | `slotRoots: openArray[H]`                                                                            | `T`                 |
| `buildSlots`      | Build all slot trees (with `buildSlotTree` ) in the dataset and store their proofs in the `BlockStore`. Builds the dataset verification tree via `buildVerifyTree`. | —                                                                                                    | `void`              |

**Sampler interfaces:**

| Interface       | Description                                                                            | Input                                                                    | Output             |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| `new`           | Construct a `DataSampler` for a specific slot index.                                   | `index: Natural`, `blockStore: BlockStore`, `builder: SlotsBuilder[T,H]` | `DataSampler[T,H]` |
| `getSample`     | Retrieve one sampled cell and its Merkle path(s) for a given slot.                     | `cellIdx: int`, `slotTreeCid: Cid`, `slotRoot: H`                        | `Sample[H]`        |
| `getProofInput` | Generate the full proof inputs for the proving circuit (calls `getSample` internally). | `entropy: ProofChallenge`, `nSamples: Natural`                           | `ProofInputs[H]`   |

**Prover interfaces:**

| Interface | Description                                                           | Input                                                            | Output                 |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| `new`     | Construct a `Prover` with a block store and the backend proof system. | `blockStore: BlockStore`, `backend: AnyBackend`, `nSamples: int` | `Prover`               |
| `prove`   | Produce a succinct proof for the given slot and entropy.              | `slotIdx: int`, `manifest: Manifest`, `entropy: ProofChallenge`  | `(proofInputs, proof)` |
| `verify`  | Verify a proof against its public inputs.                             | `proof: AnyProof`, `proofInputs: AnyProofInputs`                 | `bool`                 |

## 3. Functional Requirements

**Data Commitment**
- Build slot commitments: Construct `cell -> block -> slot` Merkle trees for each slot from locally stored bytes using Poseidon2 (cell hashing) and keyed compression. 
- Build dataset commitment: Construct `slot -> dataset` verification tree.  
- Proof material: retrieve cell data (and optionally proofs) from the `BlockStore`.

**Sampling**
- checks for marketplace challenges per slot. 
- Deterministic sampling: Derive `nSamples` cell indices for the `slotIndex` from `(entropy, slotRoot)`. 
- For each sampled cell, obtain/fetch: `cellData` (as field elements) and Merkle paths (all `cell -> block -> slot -> dataset`)
- Generate `ProofInputs` containing the public inputs (`datasetRoot`, `slotIndex`, `entropy`) and private witness (`cellData`, `slotRoot`, `MerklePaths`).

**Proof Generation**
- Given `ProofInputs`, use the configured backend (Groth16 over BN254) to create a succinct Groth16 proof. 
- The circuit enforces the same Merkle layout and Poseidon2 hashing used for commitments

## 4. Non-Functional Requirements

**Performance / Latency**
- End-to-end (sample -> prove -> submit) completes within the on-chain proof window with some safety margin. 
- Small Proof size, e.g. Groth16/BN254 plus public inputs. 
- On-chain verification cost is minimal.
- Support concurrent proving for multiple slots.

**Security & Correctness**
- Soundness and completeness: only accept valid proofs, invalid inputs must not yield accepted proofs. 
- Commitment integrity: proofs are checked against the publicly available Merkle commitments to the stored data.
- Entropy binding: sample indices must be derived from the on-chain entropy and the slot commitment. 

## 5. Internal Behavior

### High-level Overview 
At a high level, the proving module contains three components each with specific roles:

- **Builder**: Constructs the dataset’s Merkle tree commitment from the stored dataset (fetched using `BlockStore` and the `Manifest`). It generates the dataset-level `verificationTree` (`datasetRoot` and `slot -> dataset` paths) and, for each block a Merkle tree with `cell -> block` paths.
- **Sampler** takes a challenge `(slotIndex, entropy, nSamples)` and maps it to cell indices within that slot. For every sampled cell, it fetches the `cellData` and concatenates the necessary Merkle paths: `cell -> block`, `block -> slot`, and `slot -> dataset` (from the `BlockStore`).
- **Prover** takes `ProofInputs` and asks the proving system backend (Groth16) to produce a succinct proof. Verification can be done on-chain or off-chain against the same inputs.

The flow consists of the following steps:
1. Data Commitment
2. Sampling
3. Generating a ZK Proof

### Flow

**1. Data Commitment**
In Codex, a dataset is split into `numSlots` slots which are the ones sampled. Each slot is split into `nCells` fixed-size cells. Since networking operates on blocks, cells are combined to form blocks where each block contains `BLOCKSIZE/CELLSIZE` cells. The following descibes how raw bytes become commitments in Codex (cells -> blocks -> slots -> dataset):

![[data_merkle_commit.png]]

- Cell hashing: 
   - Split each cell’s bytes into chunks (31-byte for BN254), map to field elements (little-endian). Pad the last chunk with `10*`. 
   - Hash the resulting field-element stream with a Poseidon2 sponge.

- Block tree (cell -> block): 
   - A network block in Codex is `64kb` and contains `32` cells of `2kb` each. 
   - Build a Merkle tree of depth 5 over the 32 cell hashes. The root is the block hash.

- Slot tree (block -> slot): 
   - For all blocks in a slot, build a Merkle tree over their block hashes (root of block trees). The number of leaves is expected to be a power of two. The Slot tree root is the public commitment that is sampled. 

- Dataset tree (slot -> dataset):
   - Build a Merkle tree over the slot trees roots to obtain the dataset root (this is different from SHA-256 CID used for content addressing). The dataset root is the public commitment to all slots hosted by a single SP.

**Codex Merkle tree conventions**
Codex extends the standard Merkle tree with a *keyed compression* that depends on (a) whether a node is on the bottom (i.e. leaf layer) and (b) whether a node is odd (has a single child) or even (two children). These two bits are encoded as `{0,1,2,3}` and fed into the hash so tree shape can’t be manipulated.

**Steps in building the Merkle tree (bytes/leaves -> root)**

Cell bytes are split into `31-byte chunks` to fit in BN254, each mapped little-endian into a BN254 field element. `10*` padding is used.

Leaves (cells) are hashed with a Poseidon2 sponge with state size `t=3` and rate `r=2`. The sponge is initialized with IV `(0,0, domSep)` where  
  $domSep := 2^{64} + 256*t + rate$ (a domain-separation constant).
  
When combining two child nodes `x` and `y`, Codex uses the keyed compression:
```
compress(x, y, key) = Poseidon2_permutation(x, y, key)[0]
```
where `key` encodes the two bits:
- **bit 0**: 1 if we’re at the **bottom layer**, else 0  
- **bit 1**: 1 if this is an **odd** node (only one child present), else 0

Special cases:
- **Odd node** with single child `x`: `compress(x, 0, key)` (i.e., the missing sibling is zero). 
- **Singleton tree** (only one element in the tree): still apply **one** compression round. 
- **Merkle Paths** need **only sibling hashes**: left/right direction is inferred from the binary decomposition of the leaf index, so you don’t transmit direction flags.


**2. Sampling**

**Sampling request**
Sampling begins when a proof is requested containing the entropy (also called `ProofChallenge`). A `DataSampler` instance is created for a specific slot and then used to produce `Sample` records (see the `Sample` type in the Data Models section).

The sampler needs:

- `slotIndex`: the index of the slot being proven. This is fixed when the `DataSampler` is constructed. 
- `entropy`: public randomness (e.g., blockhash).
- `nSamples`: the number of cells to sample.


**Derive indices** 
The sampler derives deterministic cell indices from the challenge entropy and the slot commitment:

```
idx = H(entropy || slotRoot || counter) mod nCells
```

where `counter = 1..nSamples` and `H` is the Poseidon2 sponge (rate = 2) with `10*` padding. The result is a sequence of distinct indices in `[0, nCells)`, identical for any honest party given the same `(entropy, slotRoot, nSamples)`.

**Generate per-sample data** 
   - Fetch the `cellData` via the `BlockStore` and `builder`, and fetch the stored `cell -> block`, `block -> slot`, `slot -> dataset` Merkle paths. Note that `cell -> block` can be build on the fly and `slot -> dataset` can be reused for all samples in that slot. 

**Collect Proof Inputs** 
The `DataSampler` collects the `ProofInputs` required for the zk proof system which contains the following: 
- `entropy`: the challenge randomness.
- `datasetRoot`: the root of the dataset Merkle tree. 
- `slotIndex`: the index of the proven slot. 
- `slotRoot`: the Merkle root of the slot tree. 
- `nCellsPerSlot`: total number of cells in the slot.
- `nSlotsPerDataSet`: total number of slots in the dataset.
- `slotProof`: the `slot -> dataset` Merkle path. 
- `samples`: a list where each element is:
  - `cellData`: the sampled cell encoded as field elements. 
  - `merklePaths`: the concatenation `(cell -> block) || (block -> slot)`.

These `ProofInputs` are then passed to the prover to generate the succinct ZK proof.

**3. Generating a ZK proof**
To produce a zk storage proof, Codex uses a pluggable proving backend. In practice we use Groth16 over BN254 (altbn128) with circuits written in Circom. The `Prover` with`ProofInputs` calls the backend to create a succinct proof, and (optionally) verifies it locally before submission. The prover require the following dependencies:

- **Circuits (Circom)**: [codex-storage-proofs-circuits](https://github.com/codex-storage/codex-storage-proofs-circuits)  
  Circom implementations of Codex’s proof circuits (targets Groth16 over BN254). The circuits contain the logic to ensure knowledge of the randomly sampled set of cells (see circuit specification below).

- **Circom to Nim** — [nim-circom-compat](https://github.com/codex-storage/nim-circom-compat)  
  Nim bindings that load compiled Circom artifacts, serialize `ProofInputs`, and expose a small API (prove, verify) that returns/consumes `CircomProof`.

- **FFI backend (Arkworks Groth16)** — [circom-compat-ffi](https://github.com/codex-storage/circom-compat-ffi) 
  Rust library with a C ABI used to run Arkworks Groth16 proving and verification on BN254.

**ZK Circuit Specification**

**Circuit parameters (compile-time constants)**
```
MAXDEPTH     # max depth of slot tree (block -> slot)
MAXSLOTS     # max number of slots in dataset (slot -> dataset)
CELLSIZE     # cell size in bytes (e.g., 2048)
BLOCKSIZE    # block size in bytes (e.g., 65536)
NSAMPLES     # number of sampled cells per challenge (e.g. 100)
```

**Public inputs**
```
datasetRoot  # root of the dataset (slot -> dataset)
slotIndex    # index of the slot being proven
entropy      # public randomness used to derive sample indices
```

**Witness (private inputs)**
```
slotRoot     # root of the slot (block -> slot) tree
slotProof    # Merkle path for slot -> dataset
samples[]:   # one entry per sampled cell:
  cellData     # the sampled cell encoded as field elements
  merklePaths  # (cell -> block) || (block -> slot) Merkle path
```

**Constraints (informal)** 
For each sampled cell, the circuit enforces:
1. **Cell hashing:** recompute the cell digest from `cellData` using the Poseidon2 sponge (rate=2, `10*` padding). 
2. **Cell -> Block:** verify inclusion of the cell digest in the block tree using the provided `cell -> block` path.
3. **Block -> Slot:** verify inclusion of the block digest in the slot tree using the `block -> slot` path. 
4. **Slot -> Dataset:** verify inclusion of `slotRoot` in dataset tree using `slotProof`. 
5. **Sampling indices:** recompute the required sample indices from `(entropy, slotRoot, NSAMPLES)` and check that the supplied samples correspond exactly to those indices.


**Output (proof)**
- **Groth16 proof** over BN254: the tuple $(A \in \mathbb{G}_1,\; B \in \mathbb{G}_2,\; C \in \mathbb{G}_1)$, referred to in code as `CircomProof`.
  
**Verification**
- The verifier (on-chain or off-chain) checks the `proof` against the `public inputs` using the circuit’s `verifying key` (derived from the `CRS` generated at setup). 
- On EVM chains, verification leverages BN254 precompiles.


## 6. Dependencies
The proving module relies on the components and libraries below.

- **Marketplace / Storage Contracts**: request/proof events.
- **BlockStore**: Content-addressed store used by the proving module to read raw block bytes and store/fetch Merkle proofs (paths).
- **Manifest**: Dataset metadata and commitment references (CIDs) required to construct trees.
- **Merkle Tree and Hash Function**: 
    - Codex Safe Merkle tree implementation.
    - Poseidon2 sponge for cell hashing.
    - Poseidon2 keyed 2-to-1 compression for Merkle tree layers.
- **Nim bindings for Circom**: 
    - [nim-circom-compat](https://github.com/codex-storage/nim-circom-compat)
    - [Arkworks Groth16 FFI](https://github.com/codex-storage/circom-compat-ffi)
- **Groth16 Circuits**: Groth16 circuits witten in [codex-storage-proofs-circuits](https://github.com/codex-storage/codex-storage-proofs-circuits).


## 7. Data Models
### Builder 
```Nim
SlotsBuilder*[T, H] = ref object of RootObj
  store: BlockStore
  manifest: Manifest # current manifest
  strategy: IndexingStrategy # indexing strategy
  cellSize: NBytes # cell size
  numSlotBlocks: Natural
    # number of blocks per slot (should yield a power of two number of cells)
  slotRoots: seq[H] # roots of the slots
  emptyBlock: seq[byte] # empty block
  verifiableTree: ?T # verification tree (dataset tree)
  emptyDigestTree: T # empty digest tree for empty blocks
```
### Sampler 
```Nim
DataSampler*[T, H] = ref object of RootObj
  index: Natural
  blockStore: BlockStore
  builder: SlotsBuilder[T, H]
```
### Prover
```Nim
Prover* = ref object of RootObj
    backend: AnyBackend
    store: BlockStore
    nSamples: int
```
### Sample
```Nim
  Sample*[H] = object
    cellData*: seq[H]
    merklePaths*: seq[H]
```
### Public Input
```Nim
  PublicInputs*[H] = object
    slotIndex*: int
    datasetRoot*: H
    entropy*: H
```
### Proof Input
```Nim
  ProofInputs*[H] = object
    entropy*: H
    datasetRoot*: H
    slotIndex*: Natural
    slotRoot*: H
    nCellsPerSlot*: Natural
    nSlotsPerDataSet*: Natural
    slotProof*: seq[H]
    samples*: seq[Sample[H]]
```
### Proof
```rust
pub struct Proof {
    pub a: G1,
    pub b: G2,
    pub c: G1,
}
```