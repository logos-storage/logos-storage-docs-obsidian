- requirements sources:
	- Codex Roadmap (from Corey):
		- pages/Codex Notes.md (https://github.com/logos-co/petty-notes/blob/master/pages/Codex%20Notes.md#a-proposed-piecemeal-codex-deployment)
		-  HackMD version with some comments:: https://hackmd.io/uLOqdVq3Q1ypeBRkKDd9-A
	- What Codex is and what Codex isn't from Dmitriy: https://hackmd.io/N1QGeyjfSWSK7dpFyD1VCA
	- Initial draft for off chain proof verification: https://hackmd.io/@dryajov/rJtll1-Eee
	- Meeting with Jacek (transcript): https://app.fireflies.ai/live/01K070SBAZK764PGQEJ0BS4W62?ref=live_chat
	- Important doc about proofing system
	- From Leo: https://hackmd.io/tRQJrafhTquuJnBK6iqULQ?view - empty and seems not to be used by anyone currently.
	- [What Codex is and what Codex isn't](https://hackmd.io/N1QGeyjfSWSK7dpFyD1VCA) from Dmitriy
	- Initial draft for off chain proof verification: https://hackmd.io/@dryajov/rJtll1-Eee
	- Meeting with Jacek (transcript): https://app.fireflies.ai/live/01K070SBAZK764PGQEJ0BS4W62?ref=live_chat
	- Important doc about proofing system
	- Chrys:
		- Some initial observations:
			- some technical notes for the altruistic mode, sharing them with Giuliano, so we can see the key differences for starters and discuss possible solutions:
				- Slot Management:
					Current: Smart contract coordinates slot assignment via economic auction
					Altruistic: Slot assignments are coordinated via DHT and gossip-based distributed consensus algorithm.
				- Availability Verification:
					Current: ZK proofs posted to blockchain with gas costs
					Altruistic: Peers exchange lightweight heartbeat messages via gossip to signal availability.
				- Repair Triggering:
					Current: Smart contract detects failed proofs and triggers marketplace
					Altruistic: Peers track slot availability through gossip. When data loss is detected, a repair request is broadcast to the network.
				- Repair Execution:
					Current: Economic incentives (collateral/payment) drive replacement storage provider
					Altruistic: Community volunteers reconstruct missing data via erasure coding using the same distributed algorithm, coordinated peer-to-peer.
				- So all coordination moves from on-chain marketplace mechanisms to P2P protocols, while preserving the same underlying durability guarantees through erasure coding.
			- some other questions are raising:
				1. Do nodes gossip every proof or sample/rotate them?
				2. How do you handle nodes with different views of "dataset health"?
				3. What's the verification computational overhead vs. current ZK approach?
				4. How do you coordinate repair when nodes disagree on availability?

OFAC regulations prohibit U.S. persons and entities, including those in the Web3 space, from engaging in transactions with individuals, entities, or jurisdictions on the Specially Designated Nationals (SDN) List.

From Balazs:

> so there is one situation when i can see the "0 durability" to still be useful: small communities which are self-incentivized to store their very own data

Reading recommendations from Jacek:

- GNUNet
- Swarm Book

[An Altruistic Mode for Codex](https://hackmd.io/vuWTutZiSUalVZp5YRcImQ) - new working document from Giuliano about Altruistic mode.

[Waku-Codex Use Cases - Refinement](https://hackmd.io/wI78LHO-SN6qTm6u7zLajQ)