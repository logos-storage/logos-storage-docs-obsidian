
**Paper available at:** https://arxiv.org/abs/2205.14927

The paper presents a passive measurement study of the IPFS network. By _passive measurement_ the authors mean that they simply operate nodes in the IPFS network, monitor the traffic, and draw conclusions based on that.

**Mesurement setup.** Authors conduct five measurements over different $1$-day and $3$-day periods, using both ipfs-go and hydra-booster nodes. They increase the maximum and minimum connection limits so connection trimming is reduced. During measurements, measurement peers periodically record the PIDs of all known peers as well as their agent version, supported protocols, and multiaddresses.

Authors show that passive measurements can actually capture more PIDs than active measurements (e.g. crawling the DHT) as passive measurement nodes also become hubs for NATted peers when running in DHT server mode. Authors show that they can capture almost 3 times as many PIDs as existing active crawling approaches, though it is unclear if this is a fair comparison -- the passive measurement hoards PIDs for peers over a longer measurement horizon, whereas the  crawler takes a snapshot over a short horizon and stops.

Regardless, one interesting point they make is that **two measurement nodes (or a two-headed hydra) with strategically placed keys should be sufficient to cover almost the whole network**.

**High number of simultaneous connections.** One aspect that caught my eye is the very large number of simultaneous connections that nodes are apparently handling. I am used to seeing p2p node connections in the vicinity of hundreds, or maybe thousands, but those nodes handle tens of thousands of connections. I wonder if something fundamentally changed about how efficient connection handling is, if those numbers are counting multiplexed connections as separate connections, or if those nodes are simply beefy. 

Looking at the estimates they provide for network size, however, it would seem that some of these nodes are sometimes connected to almost $70\%$ of the network, which seems a bit crazy.

**Connection churn.** Authors state that connections to measurement nodes last from a few minutes to $1h$ "in general". Increasing the thresholds and measuring "medians-of-averages" per peer, however, yields median connection durations of $3h$.  It is hard to say if those correspond to peer session lengths though because of connection trimming and the nature of passive measurements.

**PID stability.** Network size measurements seem to indicate that peers constantly switch their PIDs as the number grows steadily. When permanent departure are discounted, the curve stabilizes, indicating that nodes are likely using multiple PIDs (or new PIDs every time).

**Network size.** Authors attempt to count peers by counting IP addresses instead, but note that this might not be reliable as ISP-level NATs can add noise to this. The grouping brings the initial 65k peers down to 47k.

**Core network.** Classifying peers by connection length can reveal the percentage of stable peers, despite the limitations due to connection trimming. They find that over $53\%$ of peers remain connected for less than $1h$, and around $16\%$ remain connected for over 24h.

**Public/NATted ratios.** An interesting side node is that about $85\%$ of the DHT nodes with long connections operate in client mode, making the NATted population about 6 times bigger than the public population in this sample.

## Nuggets

* IPFS PIDs are disposable for all intents and purposes. Peers often don't reuse them;
* the IPFS network had about 48k peers, 10k of which were stably present ($20\%$);
* because of PID aliasing and the limitations of passive measurement with noisy connection trimming, it's hard to actually conclude much else from this paper.

