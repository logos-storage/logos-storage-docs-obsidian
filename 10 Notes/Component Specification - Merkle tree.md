# Merkle tree specification

## Purpose and Scope

The purpose of this component is to deal with Merkle trees (and Merkle trees only; except that certain arithmetic hashes constructed via the sponge construction use the same encoding standards as below).

We use Merkle trees (and Merkle tree roots) for:

- content addressing (via the Merkle root hash)
- data authenticity (via a Merkle path from a block to the root)
- remote auditing (via Merkle proofs of pieces)

Merkle trees can be implemented in quite a few different ways, and if naively implemented, can be also attacked in several ways.

Some possible attacks:

- data encoding attacks
- padding attacks
- using a different layer instead of the original data

These all can create root hash collisions for example.

Hence, we specify a concrete implementation, which should be safe from these attacks.

Storing Merkle trees on disc is out of scope here (but should be straightforward, as serialization of trees should be included in the component).

## Vocabulary

A Merkle tree, built on a hash function `H`, produces a Merkle root of type `T` ("Target type"). This is usually the same type as the output of the hash function (we will assume this below). Some examples:

- SHA1: `T` is 160 bits
- SHA256: `T` is 256 bits
- Keccak (SHA3): `T` can be one of 224, 256, 384 or 512 bits
- Poseidon: `T` is one or more finite field element(s) (based on the field size) 
- Monolith: `T` is 4 Goldilocks field elements

The hash function `H` can also have different types `S` ("Source type") of inputs. For example:

- SHA1 / SHA256 / SHA3: `S` is an arbitrary sequence of bits
- some less-conforming implementation of these could take a sequence of bytes instead (but that's often enough in practice)
- binary compression function: `S` is a pair of `T`-s
- Poseidon: `S` is a sequence of finite field elements
- Poseidon compression function: `S` is at most `t-k` field elements, where `k` field elements should be approximately 256 bits (in our case `t=3`, `k=1` for BN254 field; or `t=12`, `k=4` for the Goldilocks field; or `t=24`, `k=8` for a ~32 bit field)
- as an alternative, the "Jive strategy" for binary compression can eliminate the "minus `k`" requirement (you can compress `t` into `t/2`)
- A naive Merkle tree implementation could for example accept only a power-of-two sized sequence of `T`

Notation: Let's denote a sequence of `T`-s by `[T]`; and an array of `T`-s of length `l` by `T[l]`.

## Interfaces

We usually need at least two types of Merkle tree APIs:

- one which takes a sequence `S = [T]` of length `n` as input, and produces an output (Merkle root) of type `T`
- and one which takes a sequence of bytes (or even bits, but in practice we probably only need bytes): `S = [byte]`

We can decompose the latter into the composition of a `encodeBytes` function and the former (it's safer this way, because there are a lot of subtle details here).

| Interface        | Description                | Input                   | Output                  |
|------------------|-----------------------------|-------------------------|-------------------------|
| computeTree()   | computes the full Merkle tree | sequence of `T`-s | a MerkleTree[T] data structure (a binary tree) |
| computeRoot()   | computes the Merkle root of a sequence of `T`-s | sequence of `T`-s | a single `T` |
| extractPath() | computes a Merkle path | MerkleTree[T] and a leaf index | MerklePath[T] 
| checkMerkleProof() | checks the validity of a Merkle path proof | root hash (a `T`) and MerklePath[T] | a bool (ok or not)
| encodeBytesInjective()| converts a sequence of bytes into a sequence of `T`-s, injectively | seqences of bytes | sequence of `T`-s
| serializeToBytes() | serializes a sequence of `T`-s into bytes | sequence of `T`-s | sequence of bytes |
| deserializeFromBytes() | deserializes a sequence of `T`-s from bytes | sequence of bytes | sequence of `T`-s, or error |
| serializeTree() | serializes the Merkle tree data structure (to be stored on disk) | MerkleTree[T] | sequence of bytes |
| deserializeTree() | deserializes the Merkle tree data structure (to be load from disk) | sequence of bytes | error or MerkleTree[T] | 

## Functional Requirements

- works correctly
- parametrized by the hash function
- easy to add new hash functions

## Non-Functional Requirements

- is safe from theoretical attacks
- fast
- streaming interface to handle larger data than fits into memory (optional; may be needed in the future)
- optional: multithreading support
 
## Internal Behavior

There are two main parts: the tree construction and the encoding of bytes into`T`-s.

### Tree construction

We want to avoid three kind of attacks:

- padding attacks
- layer abusing attacks

Hence, instead of using a single compression functions, we use a _keyed compression function_, which is keyed by two bits:

- whether the new parent node is an even or odd node (that is, has 2 or 1 children; alternatively, whether we are compressing 2 or 1 nodes)
- whether it's the bottom (by which I mean the widest, initial) layer or not

This information is converted to a number `0 <= key < 4` by the following algorithm:

    data LayerFlag  
      = BottomLayer   -- ^ it's the bottom (initial, widest) layer
      | OtherLayer    -- ^ it's not the bottom layer 
    
    data NodeParity
      = EvenNode      -- ^ it has 2 children
      | OddNode       -- ^ it has 1 child
    
    -- | Key based on the node type: 
    -- 
    -- > bit0 := 1 if bottom layer, 0 otherwise
    -- > bit1 := 1 if odd, 0 if even
    --
    nodeKey :: LayerFlag -> NodeParity -> Int
    nodeKey OtherLayer  EvenNode = 0x00
    nodeKey BottomLayer EvenNode = 0x01
    nodeKey OtherLayer  OddNode  = 0x02
    nodeKey BottomLayer OddNode  = 0x03

This number is used to key the compression function (essentially, we will 4 completely different compression functions).

When the hash function is a finite field sponge based, like Poseidon2 or Monolith, we use the following construction: We apply the permutation function to `(x,y,key)`, and take the first component of the result.

When the hash function is something like SHA256, we do the following: `SHA256(key|x|y)` (here `key` is encoded as a byte).

Remark: Since standard SHA256 includes padding, adding a key at the beginning doesn't result in extra computation (it's always two internal hash calls). However, a faster (twice as fast) alternative would be to choose 4 different random-looking initialization vectors, and not do padding. This would be a non-standard SHA256 invocation.

Finally, we proceed from the initial sequence in layers: Take the previous sequence, apply the keyed compression function for each consecutive pairs `(x,y) : (T,T)` with the correct key: based on whether this was the initial (bottom) layer, and whether it's a singleton "pair" `x : T`, in which case it's also padded with a zero to `(x,0)`.

Note: If the input was a singleton list `[x]`, we still apply one layer, so in that case the root will be `compress[key=3](x,0)`.

### Encoding and (de)serialization from/to bytes

This has to be done very carefully to avoid potential attacks.

Note: This is a rather special situtation, in that encoding and serialization are **NOT THE INVERSE OF EACH OTHER**. The reason for this is that they have different purposes: In case of encoding from bytes to `T`-s, it MUST BE injective to avoid trivial collision attacks; while when serializing from `T`-s to bytes, it needs to be invertible (so that we can load back what stored in disk; in this sense this is really 1+2 = 3 algorithms).

The two can coincide when `T` is just a byte sequence like in SHA256, but not when `T` consists of prime field elements.

Remark: We use the same encoding of sequence of bytes to sequence of `T`-s for the sponge hash construction, when applicable.

#### Encoding into a single T

For any `T = Target[H]`, fix a size `M` and an injective encoding `byte[M] -> T`. For SHA256 etc, this will be standard encoding (big-endian; `M=32`).

For the BN254 field (`T` is 1 field element), we will have `M=31`, and the 31 bytes interpreted as a _little-endian_ integer modulo `p`.

For the Goldilocks field, we have some choices: We can have `M=4*7=28`, as a single field element can encode 7 bytes but not 8. Or, if we want to be more efficient, we can still achieve `M=31` by storing 62 bits in each field elements. For this some convention needs to be chosen; our implementation is the following:

    #define MASK 0x3fffffffffffffffULL

    // NOTE: we assume a little-endian architecture here
    void goldilocks_convert_31_bytes_to_4_field_elements(const uint8_t *ptr, uint64_t *felts) {
      const uint64_t *q0  = (const uint64_t*)(ptr   );
      const uint64_t *q7  = (const uint64_t*)(ptr+ 7);
      const uint64_t *q15 = (const uint64_t*)(ptr+15);
      const uint64_t *q23 = (const uint64_t*)(ptr+23);
    
      felts[0] =  (q0 [0]) & MASK;
      felts[1] = ((q7 [0]) >> 6) | ((uint64_t)(ptr[15] & 0x0f) << 58);
      felts[2] = ((q15[0]) >> 4) | ((uint64_t)(ptr[23] & 0x03) << 60); 
      felts[3] = ((q23[0]) >> 2);
    }

This simply chunks the 31 bytes = 248 bits into 62 bits chunks, and interprets them as little endian 62 bit integers.

#### Encoding from a sequence of bytes

First, we pad the _byte sequence_ with the `10*` padding strategy to a multiple of `M` bytes. 

This means that we _always_ add a `0x01` byte, and then as many `0x00` bytes as required for the length to be divisible by `M`. If the input was `l` bytes, then the padded sequence will have `M*(floor(l/M)+1)` bytes.

Note: the `10*` padding strategy is an invertible operation, which will ensure that there is no collision between sequences of different length.

This padded byte sequence we then chunk to pieces of `M` bytes (so there will be `floor(l/M)+1` chunks), and we apply the above fixed `byte[M] -> T` for each chunk, resulting in the same number of `T`-s.

Remark: We don't pad the sequence of `T`-s when constructing the Merkle tree (as the tree construction ensures that different lengths will result in different root hashes). However, when **using the sponge construction,** we need to further pad the sequence of `T`-s to be a multiple of the sponge rate; there again we apply the `10*` strategy, but there the `1` and `0` are finite field elements.

#### Serializing / Deserializing

When using SHA256 or similar, this is trivial (use the standard, big-endian encoding).

When `T` consists of prime field elements, simply take the smallest number of bytes the field fits in (usually 256, 64 or 32 bits, that is 32, 8 or 4 bytes), and encode as a little-endian integer (mod the prime). 

This is obvious to invert.

#### Tree serialization

Just add enough metadata that the size of each layer is known, then you can simply concatenate the layers, and serialize like as above. This metadata can be as small as the size of the initial layer, that is, a single integer.

### Reference implementations:

- in Haskell: https://github.com/codex-storage/codex-storage-proofs-circuits/blob/master/reference/haskell/src/Poseidon2/Merkle.hs
- in Nim: https://github.com/codex-storage/codex-storage-proofs-circuits/blob/master/reference/nim/proof_input/src/merkle.nim
 
## Dependencies

- hash function implementations, for example:
    - `bearssl` (for SHA256)
    - `nim-poseidon2` (which should be renamed to `nim-poseidon2-bn254`)
    - `nim-goldilocks-hash`

## Data Models

- `H`, the set of supported hash functions, is an enumeration
- `S := Source[H]` and `T := Target[H]`
- `MerklePath[H]` is a record, consisting of 
     - `path`: a sequence of `T`-s
     - `index`: a linear index (int)
     - `leaf`: the leaf we prove (a `T`)
     - `size`: the number of elements from which the tree was created 
- `MerkleTree[H]`: a binary tree of `T`-s; alternatively a sequence of sequences of `T`-s

