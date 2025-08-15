# Codex - Component specification
## 1. Purpose and Scope
### What the component does.
The Codex component operates the other components in the system to produce the behavior of a Codex node. It responds to user action and signals from other components. It initiates data processing, and data exchange. This document will describe how other components are used, leaving their details to be described in their own documents.

## 2. Interfaces
### Lifecycle
| Interface | Description | Input | Output |
|-----------|-------------|-------|--------|
| `start` | Initialization | - | - |
| `stop` | Decommissioning | - | - |

### Network
| Interface | Description | Input | Output |
|-----------|-------------|-------|--------|
| `findPeer` | Activates discovery module to locate network peer. | PeerId | Peer record |
| `connect` | Activates p2p module to establish direct connection to a network peer. | PeerId, multiaddresses | - |

### Data
> - Whenever data retrieval is started, the local data storage module will be queried first. If it is unable to provide the requested data, the block exchange module may be activated in order to retrieve the data from other Codex nodes in the network.
> - When data is retrieved from the block exchange module, it is automatically stored in the local data storage module.
> - When data is stored in the local data storage module, the discovery module is automatically activated to announce the new data to the network so that other Codex nodes can discover it.

| Interface | Description | Input | Output |
|-----------|-------------|-------|--------|
| `iterateManifests` | Activates store module to iterate all manifests stored locally. | - | Manifests are yielded by callback. |
| `retrieve` | Activates local data storage module or block exchange module to retrieve a single block or entire dataset, depending on whether the data is stored locally, and whether the CID represents a manifest. | CID | Data is yielded as a Stream object. |
| `store` | Receives raw data stream and converts it into blocks. Creates basic manifest for the new blocks. Activates local data storage to store the new dataset. | Stream object from which to read the data, filename and type information. | CID |
| `fetchManifest` | Activates local data storage or block exchange to retrieve a manifest. | CID | Manifest object. |
| `delete` | Activates local data storage to delete a single block or entire dataset, depending on whether the CID represents a manifest. | CID | - |
| `fetchDatasetAsyncTask` | Activates local data storage and block exchange to retrieve a dataset. This operation is performed as a background task. | Manifest object. | - |

### Marketplace
| Interface | Description | Input | Output |
|-----------|-------------|-------|--------|
| `requestStorage` | Activates and applies erasure-coding to the dataset. Activates the slot builder module to construct slots and produce a verifiable manifest. Then activates the purchasing module to create a new on-chain storage-request object. | CID, storage contract duration and expiry times, storage contract durability parameters. | Purchase ID |
| `onStore` | Activated as callback from Sales module when a new storage-request slot is to be stored by the node. Activates local data storage, block exchange, and slot builder modules in order to retrieve or repair a single slot that is part of a verifiable manifest. Data expiration values are adjusted to match the storage-request duration. | Storage-request object, expiry duration, slot index. | - |

## 3. Functional requirements
List of features or behaviors the component must provide.
### General
- The component provides logging information.
- The component returns error objects in case of errors.
- The component returns nullable or optional values where appropriate.
### Network
- The component enables the user to view the current network status information as provided by the p2p module and discovery module.
- The component enables the user to query the discovery module for connection information.
- The component enables the user to engage the p2p module to establish direct connections to other Codex nodes.
### Data operations
- The component provides an overview of datasets currently stored by the local data module.
- The component enables the user to retrieve the raw data of any dataset currently stored by the local data module.
- The component enables the user to retrieve the raw data of any dataset currently stored by any node in the Codex network.
- The component enables the user to store a raw dataset in the local data module.
- The component enables the user to remove datasets from the local data module.
- The component enables the user to fetch data from any node in the Codex network to their own local data module.
### Data availability
- The component will ensure that data stored in the local data module is discoverable by other nodes in the Codex network by using the discovery module.
### Marketplace purchasing
- The component enables the user to create storage-requests on-chain by activating the erasure-coding, slot builder, and purchasing modules.
- The component enables the user to view the status of any previously created storage-request.
### Marketplace sales
- The component enables the user to configure the sales module, such that it can autonomously engage in storage-requests.
- The component provides an overview of the current sales module configuration.
- The component provides an overview of the storage-requests currently active in the sales module.
- The component responds to the callback signal from the sales module, by retrieving or repairing the appropriate part of the storage-request dataset, and configuring the local data storage module to hold that data for the storage-request duration.

## 4. Non-Functional Requirements
Performance, security, scalability, reliability, etc.
- The component will not circumvent the non-functional requirements of the components that it uses.

## 5. Internal Behavior
Description of algorithms, workflows, or state machines.
Include diagrams if needed.

### Data
#### Reading data
- Given a CID
1. Engage local data storage module to check for block presence
1. If present, use local data storage module to read the data
1. Otherwise, use block exchange to retrieve the block from the network
1. When completed, read the data
1. Otherwise, fail with retrieval exception


*** EACH FLOW ***
<!-- 
### Data
> - Whenever data retrieval is started, the local data storage module will be queried first. If it is unable to provide the requested data, the block exchange module may be activated in order to retrieve the data from other Codex nodes in the network.
> - When data is retrieved from the block exchange module, it is automatically stored in the local data storage module.
> - When data is stored in the local data storage module, the discovery module is automatically activated to announce the new data to the network so that other Codex nodes can discover it.

| Interface | Description | Input | Output |
|-----------|-------------|-------|--------|
| `iterateManifests` | Activates store module to iterate all manifests stored locally. | - | Manifests are yielded by callback. |
| `retrieve` | Activates local data storage module or block exchange module to retrieve a single block or entire dataset, depending on whether the data is stored locally, and whether the CID represents a manifest. | CID | Data is yielded as a Stream object. |
| `store` | Receives raw data stream and converts it into blocks. Creates basic manifest for the new blocks. Activates local data storage to store the new dataset. | Stream object from which to read the data, filename and type information. | CID |
| `fetchManifest` | Activates local data storage or block exchange to retrieve a manifest. | CID | Manifest object. |
| `delete` | Activates local data storage to delete a single block or entire dataset, depending on whether the CID represents a manifest. | CID | - |
| `fetchDatasetAsyncTask` | Activates local data storage and block exchange to retrieve a dataset. This operation is performed as a background task. | Manifest object. | - |

### Marketplace
| Interface | Description | Input | Output |
|-----------|-------------|-------|--------|
| `requestStorage` | Activates and applies erasure-coding to the dataset. Activates the slot builder module to construct slots and produce a verifiable manifest. Then activates the purchasing module to create a new on-chain storage-request object. | CID, storage contract duration and expiry times, storage contract durability parameters. | Purchase ID |
| `onStore` | Activated as callback from Sales module when a new storage-request slot is to be stored by the node. Activates local data storage, block exchange, and slot builder modules in order to retrieve or repair a single slot that is part of a verifiable manifest. Data expiration values are adjusted to match the storage-request duration. | Storage-request object, expiry duration, slot index. | - | -->


## 6. Dependencies
| Dependency | Implementation |
|------------|----------------|

## 7. Data Models
Data structures, schemas, or classes used or produced.
