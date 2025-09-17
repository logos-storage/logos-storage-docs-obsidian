At a higher level, Block Exchange Module is responsible for sending and receiving blocks related to the given content. Formally a block is described as a tuple consisting of the sequence of bytes and the corresponding CID. Or, using a pseudo-language: `(seq[byte], CID)`.

When uploading the content to the network, the following steps are taken:

1. The content is chunked into fixed size blocks. The default block size is `64KiB`. The last block will be padded with `0`s.
2. For each chunk, the corresponding `CID` is created, using `(codex-block, 0xCD02)` as a [[Multicodec]] and `(sha2-256, 0x12)` as [[Mutihash]].
3. The resulting block, `(seq[byte], CID)` becomes the input to the Block Exchange Module `putBlock` operation.

When downloading the content from the network:

1. Given the Codex Manifest CID, the corresponding Codex Manifest is retrieved. Using manifest attributes - `datasetSize` and `blockSize`, the number of blocks - $blockCount$ is computed as $\lceil datasetSize/blockSize \rceil$.
2. For each $blockIndex \in [0 .. blockCount]$, a $BlockAddress$ is defined as a tuple $(treeCid, blockIndex)$ where $treeCid$ is an attribute in the Codex Manifest. $BlockAddress$ is the input of the Block Exchange Module `requestBlock` operation.

The `putBlock` and `requestBlock` operations defined above, define the external interface of the Block Exchange Module. The Block Exchange Module directly interacts with other modules, mainly [[Discovery Module]] and the [[Repo Store]], used for the node discovery and local storage respectively.

## Functional Requirements

Before defining the operational model of the Block Exchange Module, which describes *how* the exchange module achieves its goals, let's the find the functional requirements that define *what* the exchange module is expected to achieve.

1. Given $BlockAddress = (treeCid, blockIndex)$, retrieve the corresponding block from the network. In the operational model, we will see that the exchange module will attempt $3000$ retires, waiting $500ms$ in each iteration for the block to be delivered. Thus, from the declarative perspective, here, we can claim that exchange module should deliver the block withing $3000 \times 500ms = 1500s = 25min$, or fail otherwise.
2. When uploading content $C$, for each block $b \in C$, store $b$ in [[Repo Store]] and (1) announce the block *presence* to the peers signaling interest in $b$, (2) deliver $b$ to the peers that earlier requested $b$. Include Merkle Proof in the delivery if $b$ is not Codex Manifest block.

## Operational Model

In this section we focus more how the exchange module operates to deliver on the [[#Functional Requirements]].

In the image below, we provide a high level description of the exchange module operational model. A more detailed discussion follows.

![[BlockExchangeProtocol.svg]]

> The image above has SVG format which allows a high resolution local rendering. You can also access online version at: https://link.excalidraw.com/readonly/GLtqSUDCiRe38gDb2MOX.

