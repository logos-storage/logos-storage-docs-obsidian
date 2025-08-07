In gathering new requirements for Codex, we have the following inputs we can refer to:

- [An Altruistic Mode for Codex](https://hackmd.io/vuWTutZiSUalVZp5YRcImQ) - new document from Giuliano about Altruistic mode. This is largely work-in-progress
- [Waku-Codex Use Cases - Refinement - HackMD Document](https://hackmd.io/wI78LHO-SN6qTm6u7zLajQ)
- [Express Codex requirements - waku-org/pm/pull/328](https://github.com/waku-org/pm/pull/328)
- [docs(codex): add Codex requirements - status-im/status-desktop/pull/18483](https://github.com/status-im/status-desktop/pull/18483)

Then we have a high level spec format: [https://hackmd.io/@codex-storage/rkbytlbOxg](https://hackmd.io/@codex-storage/rkbytlbOxg) and a reference of how polished spec *may* look like: [https://rfc.vac.dev/waku](https://rfc.vac.dev/waku)

And last but not least, our new board where you can see who is working on which spec currently: [https://github.com/orgs/codex-storage/projects/6/views/1](https://github.com/orgs/codex-storage/projects/6/views/1)

### Other references
Here are other docs I recorded from various meetings:

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
- some early input from Chrys:
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
- from Balazs:
	- so there is one situation when i can see the "0 durability" to still be useful: small communities which are self-incentivized to store their very own data
- Reading recommendations from Jacek:
	- GNUNet
	- Swarm Book
