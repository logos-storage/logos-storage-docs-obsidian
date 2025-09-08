Durability hinges on making a _quantifiable_ assumption about how likely it is that a storage provider will hold on to the data it has been assigned to, and is currently helping maintain. 

Data enters our system as _files_; i.e., named byte strings of variable size. Let $\mathcal{C}$ be the set of all such possible files. Let $N$ be the set of all nodes in our network, across its existence. We assume time to be a real-valued, positive-or-zero value $t \in \mathbb{R}_{\geq 0}$, with $t = 0$ marking the inception of the system.

To make this discussion simpler, we can assume that:
1. any file $C \in \mathcal{C}$ enters our system by being initially replicated onto a set of nodes $S_{C} \subseteq N$;
2. there is no repair.

One way of quantifying durability for $C$, then, is by attempting to assign a probability density function $f_{q}^{C}(t)$ to each node $q \in S_{C}$, such that $F_{q}^{C}(t)$ represents the probability that $q$ _has dropped $C$ by time $t$_. To simplify notation, we will omit $C$ and write those simply as $f_q(t)$ and $F_q(t)$. 

Assuming that these probabilities are independent across nodes, we can compute the cumulative probability for $C$ being lost by time $t$ as:

$$
\begin{equation}
    P_{\text{loss}}(t) = \prod_{q \in S_C} F_q(t)
\end{equation}\tag{1}
$$

**Optimization of loss.** Our "number of nines" for $C$ at time $t$ is given by $1 - P_{\text{loss}}(t)$. It should be clear, then, that a storage system should always try to build (or induce) an $S_C$ which minimizes such loss. This involves making assumptions about $F_q$ which can be pure assumptions, or the result of measurement.

**Repair.** Eq. $(1)$ makes the simplifying assumption of no repair, and it does not hold when repair is in place as $S_{C}$ could "grow back" as a result of repair actions. The fundamental fact that durability hinges on the assumptions built into $f_q(t)$, however, would not change -- we would simply need to add an additional set of assumptions as to what we believe the probabilities of finding new nodes to replace the failed one are.

**Cryptoeconomical durability.** For old Codex, our analysis of durability[^codex_24] took into consideration hardware faults only, and used exponentially-distributed $f_q$ calibrated on data taken from studies of faults in data center hard drives.[^schroeder_07]

This is a fair assumption if we also assume that slashing costs are enough to eliminate data loss from both churn[^churn-footnote] -- as slashing functions as an uptime incentive -- and arbitrary provider choice, as no provider would rationally decide to deliberately drop data and inflict monetary loss upon itself. But this again assumes that the token holds enough value to make slashing hurt: if that last assumption does not hold, then the durability numbers become meaningless.

A more honest approach would be to model this loss-of-value event; i.e., define $F^{\text{value}}_q(t)$ as the probability that the Codex tokens loses enough value by time $t$ such that:

1. $q$ is operating at loss;
2. the slashing cost for $q$, should it drop $C$, is lower than the loss it would incur if it honored the storage contract to conclusion.

In such case, it would be reasonable to expect that $q$ would drop the data. If we now name the probability of data loss happening due to hardware faults as $F^{\text{hdw}}_q(t)$, the new aggregate loss probability (assuming $F^{\text{hdw}}$ and $F^{\text{value}}$ are independent) then becomes:

$$
\begin{equation}
    P_{\text{loss}}(t) = \prod_{q \in S_C} \left(F^{\text{hdw}}_q(t) + 
    \ F^{\text{value}}_q(t) - F^{\text{hdw}}_q(t)F^{\text{value}}_q(t)\right) 
\end{equation} \tag{2}
$$

$F^{\text{value}}$ is unfortunately much harder to eastimate than $F^{\text{hdw}}$, so we simply never did that. It should be clear that it is an integral part of durability, and a blind spot in our model. What about altruistic Codex? What can we say about it?

## The Stable Intrinsic Interest Model

In altruism there is no cryptoeconomic incentive mechanism, so $F^{\text{value}}$ is not a part of our model, and we are free from having to estimate it. As to what comes in its place, there are a few different assumptions we can make here, and they all result in different outcomes for durability, as well as potentially different designs for our system. One  assumption which we would like to discuss here is what we refer to as the _Stable Intrinsic Interest_ (SII) model.

In SII, we assume the existence of a set $W_q \subseteq \mathcal{C}$ which expresses node's $q$ _interests_, and we assume that $q$:
1. is only willing store files in $W_q$;
2. is willing to store such data forever; i.e., interest is stable.

This is roughly equivalent to stating that, based on interest, the probability that a node drops data by time $t$:

$$
\begin{equation}
F_q^{\text{sii}}(t) = \begin{cases}
  0, & \text{if}\ C \in W_q \\
  1, & \text{otherwise}
\end{cases}
\end{equation}\tag{3}
$$

This means that, under SII, $F_{q}(t)$ reduces to:

$$
\begin{equation}
F_q(t) = \begin{cases}
    F^{\text{hdw}}(t), & \text{if}\ C \in W_q \\
    1, & \text{otherwise}
\end{cases}
\end{equation}\tag{4}
$$

One of the appeals of SII is its simplicity: we do not have to estimate anything else to compute our durability numbers. Indeed, it reduces precisely to the same analysis we did for old Codex, which is one of the reasons I do not like calling it "low durability".

**Maximal durability in SII.** Eq. $(1)$ and (4) taken together mean that we want:

1. an $S_C$ that is as big as possible, as $P_{\text{loss}}$ is monotonically nonincreasing on $|S_C|$;
2. nodes $q$ such that $C \in W_q$, as other nodes will not positively impact durability.

Those are both obvious and intuitive statements, but they also have a somewhat less clear implication. Namely, that node $q$ will likely need to _know_ what the content of $C$ is before it can decide whether or not it is interested in it. Blindly offering content on the network for replication, therefore, is unlikely to be a successful strategy under SII.

**Communities instead of files.** Instead of modeling $W_q$ as a subset of $\mathcal{C}$, one could instead imagine that nodes form _communities_, and that $W_q$ represents the set of communities a node participates in. This is likely an assumption we will be making for Codex.

## Altruism and Churn

In cryptoeconomic durability, nodes must remain running so they can reply to remote audit requests that come in at random instants in time. Since bringing one's node down is a gamble that could result in _slashing_, this curbs churn.

Under altruistic models like SII, these incentives no longer exist. Unless we further assume that operators are intrinsically motivated to keep their nodes running, this means we now need to deal with churn.

The cautionary tale for the cost of active repair under churn is provided in Blake and Rodrigues classical paper.[^blake_03] How much of a problem this turns out to be in practice largely depends on how we envision the system to work.

Blake and Rodrigues' model assumes a constant turnover of new nodes, which might not be realistic. Let $W_C \subseteq N$ represent the set of all nodes, across the network's lifetime, that would be willing to store $C$. We assume $W_C$ to be finite, and likely much smaller than $N$. We also assume that altruistic storage nodes, as much as they might not be always available, will not delete the data they hold on every logoff.

**Replication.** In SII under replication, every repair operation entails:

1. picking a node in $W_C$ that is currently available;
2. getting it to download $C$ and store it.

If we assume nodes do not delete data on logoff, then it should be clear that the number of repair operations is bounded by $W_C$. Once $W_C$ repair operations happen, $C$ should be fully replicated across all nodes in the $W_C$, which is the worst case for active repair.

**Erasure coding.** Erasure coding makes things more complicated as the sets of blocks nodes hold are, perhaps surprisingly, not fungible. Suppose for simplicity that $C = \{b_1, \cdots, b_k\}$ is erasure coded with $k$-out-of-$n$ redundancy into $C_e = \{b_1, \cdots, b_n\}$ blocks such that any $k$ blocks are enough to reconstitute $C$, and such that blocks are spread onto $n$ different nodes.

Every time a block $b_i$, $1 \leq i \leq n$, disappears from the network, we need to ensure that it gets recreated, and this repair operation requires the download of $O(k)$ blocks; i.e., it has the same bandwidth cost as that of restoring a replica. If nodes do not throw that data away (or lose it) after repair, erasure-coding then degenerates into full replication in the worst case (assuming $S_C$ is finite).

If they do throw away the data, then things get even worse as nodes might be selected for repair repeatedly, leading to $O(k)$ bandwidth costs per repair round. This would likely approximate the more pessimistic costs of Blake and Rodrigues.[^blake_03]

Before going about implementing complicated replica tracking and repair mechanisms, therefore, I believe we should carefully consider what sort of network dynamics we should expect, particularly in the absence of uptime incentives.

[^schroeder_07]: B. Schroeder and G. A. Gibson, "Disk Failures in the Real World: What Does an MTTF of 1,000,000 Hours Mean to You?," in Proceedings of the 5th USENIX Conference on File and Storage Technologies (FAST '07), San Jose, CA, USA, 2007
    
[^churn-footnote]: Which are not real "faults" in the sense that nodes might be crash-recover in the real world, but since we cannot distinguish that from real data loss we typically assume that nodes that stop providing heartbeats have lost their replica or erasure-coded partition permanently.

[^codex_24]: Codex Team, "Codex Whitepaper". https://docs.codex.storage/learn/whitepaper

[^blake_03]: C. Blake and R. Rodrigues. 2003. High availability, scalable storage, dynamic peer networks: pick two. In Proceedings of the 9th conference on Hot Topics in Operating Systems - Volume 9 (HOTOS'03). USENIX Association, USA, 1. 

