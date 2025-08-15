## Rationale

The Codex Manifest provides the description of the metadata uploaded to the Codex network. It is in many ways similar to the BitTorrent metainfo file (see [BEP3](http://bittorrent.org/beps/bep_0003.html) from [BitTorrent Enhancement Proposals (BEPs)](https://www.bittorrent.org/beps/bep_0000.html)) also known as `.torrent` files. While the BitTorrent metainfo files are generally distributed out-of-band, Codex Manifest receives its own [[Content Identifier (CID)]] that is announced on the Codex DHT (see also [[Codex DHT - Component specification]]).

The intended use of the Codex Manifest is indeed easier to grasp by comparing it to the BitTorrent metainfo file.

### From BitTorrent metainfo to Codex Manifest

> To keep the comparison easier to follow, when referring to *content*, we focus on a single file and version 1 of the BitTorrent protocol. 

When the user wants to upload (seed) the content the BitTorrent network, a BitTorrent client chunks the content into *pieces*. For each piece, a hash is computed and included in the `pieces` attribute of the `info` dictionary in the BitTorrent metainfo file. 

![[BitTorrent-metainfo.svg]]
The `infohash` - a `sha-1` hash of the *b-encoded* `info` dictionary - is used in the BitTorrent protocol to uniquely identify the request content.

In Codex, instead of hashes of individual pieces, we create a Merkle Tree computed over the blocks in the dataset. We then include the CID of the *root* of this Merkle Tree as `treeCid` attribute in the Codex Manifest file.

![[Codex-manifest.svg]]

> Version 2 of the BitTorrent protocol also uses Merkle Trees and includes the root of the tree in the `info` dictionary for each file.

The resulting `Manifest` is encoded and the corresponding CID - *Manifest CID* - is then returned to the user in [Multibase](https://github.com/multiformats/multibase) `base58btc` encoding (official string representation of [CID version 1](https://docs.ipfs.tech/concepts/content-addressing/#version-1-v1)). 

Because in Codex, Manifest CID is announced on the DHT, the nodes storing the corresponding Manifest block can be found. From the resolved manifest, the nodes storing relevant blocks can be identified using the `treeCid` attribute from the manifest. The `treeCid` in Codex is this similar to the `infoHash` from BitTorrent. In version 2 of the BitTorrent protocol, `infoHash` is also announced on the BitTorrent DHT, but a torrent file or the so-called *magnet link* (also introduced later) has to be distributed out-of-band.

From this rationale we almost immediately see the most important use case for the Codex Manifest in general and the Codex Manifest CID in particular is the ability to uniquely identify the content and be able to retrieve that content from any single Codex client. This and other functional requirements will be the subject of the next section.

## Functional Requirements

The Codex client should enable the user to achieve the following use cases.

- Lists manifest CIDs stored locally in node.
- Upload a file in a streaming manner. Once finished, the file can be retrieved from any node in the network using the returned manifest CID. The file name and the *MIME type* (if can be determined) should be recorded in the Codex Manifest.  
- Download a file from the local node in a streaming manner. If the file is not available locally, an error message should be returned.
- Delete manifest CID from the local node.
- Given its manifest CID, trigger downloading a file from the network to the local node if it's yet available locally. Download is performed in background and the operation can finish before download is completed.
- Given its manifest CID, download a file from the network in a streaming manner. If the file is not available locally, it will be retrieved from the network in the best effort manner. This operation does not have associated timeout and may take a long time to finish depending on the availability of the nodes keeping the relevant blocks. The user can interrupt the operation at any time.
- Given a Codex manifest CID, retrieve the corresponding Codex manifest from the local node if stored locally, otherwise, download it it from the network.
- For each requirement listed above, a compliant Codex client must provide the corresponding API.

We document the required API on the [api.codex.storage](https://api.codex.storage/#tag/Data) page.
## Non-functional Requirements

As we already saw in the previous section, using the Codex Manifest CID, the user should be able to use any compliant Codex client to download the content identified by Codex Manifest CID. In this section we focus on the non-functional requirements which guarantee interoperability between compliant Codex clients.

In the [[#Rationale]] we already introduced the concept of a [[Content Identifier (CID)]]. CIDs are central to the Codex protocol and they relay on [[Multiformats]], which in turn relay on the predefined set of [[Multicodec|multicodecs]] to uniquely identify described format. The code of a multicodec is a unsigned integer encoded as `unsigned varint` as defined by [multiformats/unsigned-varint](https://github.com/multiformats/unsigned-varint). It is then used as a prefix to identify the data that follows.
For human readability, where appropriate and non-ambiguous, we can refer to various multicodecs by their symbolic names. For instance, a muliticodec code for a SHA-256 [multihash](https://github.com/multiformats/multihash) is `0x12` and its symbolic name is `sha2-256`. In this specification we often refer to various multicodecs through a tuple containing the descriptive name and the corresponding hex value, e.g.: `(sha2-256, 0x12)`. There is a canonical table of multicodecs at [table.csv](https://github.com/multiformats/multicodec/blob/master/table.csv). Codex specific multicodecs are currently defined in [nim-libp2p](https://github.com/vacp2p/nim-libp2p/blob/multihash-poseidon2/libp2p/multicodec.nim).

### Codex Manifest Attributes

In this section we describe the Codex Manifest Attributes that each compliant client must observe to guarantee interoperability.
#### treeCid

The `treeCid` is the CID of the root of the [[Codex Tree]], which is a form of a Merkle Tree corresponding to the dataset described by the manifest. Its multicodec is `(codex-root, 0xCD03)`.

#### datasetSize

Unsigned integer. indicating the size of the original dataset.

#### blockSize

Unsigned integer. The size of the block for the given dataset. The default block size used in Codex is `64KiB`.

#### codec

Multicodec used for the CIDs of the dataset blocks. Codex currently uses `(codex-block, 0xCD02)`.

#### hcodec

Multicodec used for computing of the multihash used in blocks CIDs. Currently in Codex we use `(sha2-256, 0x12)`. The same multicodec is used in the manifest CID, yet, based on what currently can be found in code, `hcodec` attribute applies to the dataset blocks only. This makes sense as the `codec` attribute mentioned above also applies only to the CIDs of the dataset blocks. 

#### version

The version of CID used for the dataset blocks. It is currently [CID version 1](https://docs.ipfs.tech/concepts/content-addressing/#version-1-v1).

#### filename

Optional. When provided, it can be used by the client as a file name while downloading the content.

#### mimetype

Optional. When provided, it can be used by the client to set the `Content-Type` of the downloaded content.

### Codex Manifest CID

Codex Manifest CID uses `(codex-manifest, 0xCD01)` multicodec and `(sha2-256, 0x12)` as the multicodec for the multihash used in the manifest CID.

### Codex Manifest Encoding

Codex Manifest attributes are encoded using [Protocol Buffers](https://protobuf.dev/) (`Proto3`) with the following encoding:

```protobuf
Message Header {
  optional bytes treeCid = 1;        # cid (root) of the tree
  optional uint32 blockSize = 2;     # size of a single block
  optional uint64 datasetSize = 3;   # size of the dataset
  optional uint32 codec = 4;         # Dataset codec
  optional uint32 hcodec  = 5        # Multihash codec
  optional uint32 version = 6;       # Cid version
  optional string filename = 8;      # original filename
  optional string mimetype = 9;      # original mimetype
}

Message CodexManifest {
  optional Header header = 1;
}
```

We see that in the header, there is a gap now - we miss field index `7` in the definition above. This is because in the current implementation, at index `7` we have `optional ErasureInfo erasure = 7; # erasure coding info`, which is not used in the "altruistic" mode.

The current implementation is using `Proto3` version of the Protocol Buffers. Important to emphasize here is the use of the `optional` keyword for each single field. The reason for that is the so-called _Explicit Presence_. In `Proto3`, if a *singular* field is **not** marked as *optional*, the decoding side cannot check if the field was explicitly set to a default value or it was missing. If the field is marked `optional` you *should* be able to check if it was explicitly set - how you do that varies by language and even by protobuf implementation within the language. For more information about this topic, please refer to [Recommend proto3 issue](https://github.com/libp2p/specs/issues/465) and [Application note: Field presence](https://github.com/protocolbuffers/protobuf/blob/main/docs/field_presence.md).

With this insights, we could simplify the Protocol Buffers message for the new altruistic mode to simply be:

```protobuf
Message CodexManifest {
  optional bytes treeCid = 1;        # cid (root) of the tree
  optional uint32 blockSize = 2;     # size of a single block
  optional uint64 datasetSize = 3;   # size of the dataset
  optional uint32 codec = 4;         # Dataset codec
  optional uint32 hcodec  = 5        # Multihash codec
  optional uint32 version = 6;       # Cid version
  optional string filename = 7;      # original filename
  optional string mimetype = 8;      # original mimetype
}
```
