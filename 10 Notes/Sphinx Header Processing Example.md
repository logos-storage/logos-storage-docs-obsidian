This is another document from the [[Mix Implementation]] series. In the other two notes:

- [[libp2p MIX Architecture and API]]
- [[Sphinx SURBs implementation in the libp2p MIX protocol]]

you can find a high level overview I created interactively with OpenAI Codex. This note is fully hand-crafted though.

We also have a detailed illustrated example in [[Sphinx Header Processing Infographic]] with the web version available at https://link.excalidraw.com/readonly/6y7DRQlUhkkBMZScEONS.

In this note we are documenting how the [Sphinx](https://cypherpunks.ca/~iang/pubs/Sphinx_Oakland09.pdf) headers are created in our current [MIX Protocol Implementation](https://github.com/vacp2p/nim-libp2p/tree/master/libp2p/protocols/mix) and how they are processed by the mix nodes in the reply path. Where handy, comments about forward processing are also included.

> We are actually focusing on the $\beta$ part of the header here, but I will keep use the word "header" where convenient.

The objective is to have something that illustrates the complex mechanics of maintaining the constant size of the $\beta$ elements (part of the Sphinx header) using the so called _fillers_. It should help those who are working with Sphinx implementation and want to have a reference example to "quickly" visualize how the whole machinery works. As such it can be useful also for those who already know Sphinx very well.

### Notation

To create the examples that are visual and where you can "easily" see things happening, I introduced a couple of custom constructs.

$\mathcal{S}_i$ - the AES-CTR keystream derived from the per-hop shared secret $s_i$.
$\mathcal{S}_i[x,y)$ - subrange of $\mathcal{S}_i$ starting at index $x$ and ending on index $y-1$ (`[x ..< y]` in Nim).
$\{0\}^a$ - a sequence of $0$s of length $a$.

Now, to keep notation compact. Imagine we have a bit sequence of `0` of length $8$: `00000000` and a keystream  $\mathcal{S}_i$. Now imagine _applying_ a subrange of $\mathcal{S}_i$ of the same length $8$ to that bit sequence, e.g.  $\mathcal{S}_i[16,24)$:

$$
\begin{array}{|c|c|c|c|c|c|c|c|}
\hline
0&0&0&0&0&0&0&0
\\
\hline
\hspace{-2em}\oplus\hspace{1.4em}
\mathcal S_i[16] &
\mathcal S_i[17] &
\mathcal S_i[18] &
\mathcal S_i[19] &
\mathcal S_i[20] &
\mathcal S_i[21] &
\mathcal S_i[22] &
\mathcal S_i[23]
\\
\hline
\hspace{-2em}=\hspace{1.2em}
\mathcal S_i[16] &
\mathcal S_i[17] &
\mathcal S_i[18] &
\mathcal S_i[19] &
\mathcal S_i[20] &
\mathcal S_i[21] &
\mathcal S_i[22] &
\mathcal S_i[23]
\\
\hline
\end{array}
$$


The result is a bit stream with the bit value $\mathcal{S}_i[16]$ in the first position and $\mathcal{S}_i[23]$ in the last position. We denote the result of applying a subrange $\mathcal{S}_i[x,y)$ to 0-bit sequence of the same length by $\mathcal{S}^0_i[x,y)$. Obviously $\mathcal{S}^0_i[x,y)\;\oplus\;\mathcal{S}^0_i[x,y) = \{0\}^{y-x}$.

A sequence of XOR operations may be applied to a given bit sequence:

$$
\begin{array}{|c|c|c|c|c|c|c|c|}
\hline
0&1&0&1&1&0&1&0
\\
\hline
\hspace{-2em}\oplus\hspace{1.4em}
\begin{matrix}
\small\mathcal S_0[16] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_0[17] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_0[18] \\
0
\end{matrix} &
\begin{matrix}
\small\mathcal S_0[19] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_0[20] \\
0
\end{matrix} &
\begin{matrix}
\small\mathcal S_0[21] \\
0
\end{matrix} &
\begin{matrix}
\small\mathcal S_0[22] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_0[23] \\
0
\end{matrix}
\\
\hline
\hspace{-2em}\oplus\hspace{1.4em}
\begin{matrix}
\small\mathcal S_1[24] \\
0
\end{matrix} &
\begin{matrix}
\small\mathcal S_1[25] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_1[26] \\
0
\end{matrix} &
\begin{matrix}
\small\mathcal S_1[27] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_1[28] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_1[29] \\
0
\end{matrix} &
\begin{matrix}
\small\mathcal S_1[30] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_1[31] \\
0
\end{matrix}
\\
\hline
\hspace{-2em}\oplus\hspace{1.4em}
\begin{matrix}
\small\mathcal S_3[84] \\
0
\end{matrix} &
\begin{matrix}
\small\mathcal S_3[85] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_3[86] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_3[87] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_3[88] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_3[89] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_3[90] \\
1
\end{matrix} &
\begin{matrix}
\small\mathcal S_3[91] \\
0
\end{matrix}
\\
\hline
\hspace{-2.8em}=\hspace{1.9em}1&0&1&0&1&1&0&0
\\
\hline
\end{array}
$$

We denote this operation as:
$$
\begin{array}{l}
01011010 \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[16,24) \\
\small\;\mathcal{S}_1[24,32) \\
\small\;\mathcal{S}_3[84,91)
\end{matrix}  
\right.  
\end{array}
$$

In particular, if $(A_3\,\Vert\,D_2\,\Vert\,\gamma_3)$ is concatenation of bit sequences $A_3$, $D_2$, and $\gamma_3$, and size of $(A_3\,\Vert\,D_2\,\Vert\,\gamma_3)$, denoted $\vert(A_3\,\Vert\,D_2\,\Vert\,\gamma_3)\vert$, is $l$, then applying a sequence of XOR operations to the sequence $(A_3\,\Vert\,D_2\,\Vert\,\gamma_3)$  will be written as:

$$
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[a,b) \\
\small\;\mathcal{S}_1[c,d) \\
\small\;\mathcal{S}_3[e,f)
\end{matrix}  
\right.  
\end{array}
$$
where $b-a = d-c = f-e = l$. Notice that the result of the following two operations will be the same:

$$
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[a,b) \\
\small\;\mathcal{S}_1[c,d) \\
\small\;\mathcal{S}_3[e,f) \\
\small\;\mathcal{S}_3[e,f)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad = \quad \\
\vphantom{a} \\
\vphantom{a} \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\begin{matrix}
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[a,b) \\
\small\;\mathcal{S}_1[c,d) \\
\end{matrix}
\right.
\vphantom{a} \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\end{array}
$$

Because the two $\mathcal{S}_3[e,f)$ *cancel* each other, to make it more visible, we will write:

$$
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[a,b) \\
\small\;\mathcal{S}_1[c,d) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_3[e,f)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_3[e,f)}
\end{matrix}  
\right.  
\end{array}
$$

### Sphinx Header

The Sphinx Header is defined as $\mathcal{H}=(\alpha,\beta,\gamma)$, where:

- $\alpha$ is a (blinded) public key (group element; $\alpha\in\mathbb{G})$.
- $\beta$ is the (encrypted) routing information
- $\gamma$ is a MAC (message authentication code)

Formal definition of $\alpha$ and $\gamma$ and how they are used in Sphinx can be found in note [Sphinx packet format](https://hackmd.io/kdqHnc2gRhuTS-6fDex2mw). In this document, I want to focus more on $\beta$, by giving an illustrative example of its construction and processing. Special attention will be given to the so called _filler_, which I personally found the most challenging to "see". This document should help in grasping the construction and processing of $\beta$ in a more visual manner.

The intention of this document is, in the first place, to help understanding the [implementation of the current MIX protocol](https://github.com/vacp2p/nim-libp2p/tree/master/libp2p/protocols/mix). Thus, some things will be make bluntly concrete, e.g. sizes, and to find more details about them and about Mix protocol implementation in general, the reader should refer to [[libp2p MIX Architecture and API]] and [[Sphinx SURBs implementation in the libp2p MIX protocol]]. For brevity, in this document I will not repeat what is written there.

The MIX implementation uses the following constants: 

```nim
const
  k* = 16
  r* = 5
  t* = 6
  AlphaSize* = 32
  BetaSize* = ((r * (t + 1)) + 1) * k
  GammaSize* = 16
  HeaderSize* = AlphaSize + BetaSize + GammaSize
  DelaySize* = 2
  AddrSize* = (t * k) - DelaySize
  PacketSize* = 4608
  MessageSize* = PacketSize - HeaderSize - k
  PayloadSize* = MessageSize + k
  SurbSize* = HeaderSize + AddrSize + k
  SurbLenSize* = 1
  SurbIdLen* = k
```

Recall that `k` corresponds to the $\kappa=128$ bits of security from the [MIX Specification](https://lip.logos.co/ift-ts/raw/mix.html#82-cryptographic-primitives) and that `r` is the maximum number of hopes supported and `t*k` ($t\kappa$ in the spec) gives us the size of _combined address and delay width_. The size of $\beta$ - $\vert\beta\vert$ or `BetaSize` - is given by formula  $(r(t+1)+1)\kappa$, which corresponds to `((r * (t + 1)) + 1) * k` in the code snippet above. To decipher this formula let's write it in a bit less compact form:

$$
(r(t+1)+1)\kappa = r(t+1)\kappa + \kappa
$$
$r(t+1)\kappa$ corresponds to the space in bytes needed to hold $r$ combined address and delay blocks $t\kappa$ ($96$ bytes each) and $r$ $\gamma$ blocks ($16$ bytes each) resulting in $r\times112 = 5\times112 = 560$ bytes. Together with extra $\kappa$ bytes - perhaps reserved for future use, or just in case - we arrive at fixed size of $\beta$, $\vert\beta\vert = 576$ bytes.

Knowing $\vert\beta\vert$, we get:

$$
\vert\mathcal{H}\vert = \vert\alpha\vert + \vert\beta\vert + \vert\gamma\vert = 32 + 576 + 16 = 624\;\text{bytes}
$$

But let's focus back at $\beta$. As we will see in a moment, its size - $r(t+1)\kappa=112$ bytes - is crucial. It contains the routing information for each single hop, and at each hop, one such block will be removed and to keep the size of $\beta$ fixed and still indistinguishable for a potential evil observer, we use a so called _filler_. 
### Constructing the filler

What may make construction of the filler hard to understand is that three things: construction of the filler, construction of the $\beta$, and then finally processing of $\beta$ in the forward and the reply path, all must be perfectly aligned. Moreover, because the header (and so also $\beta$) for the very first hop must contain the routing information for all the remaining hops, the header construction needs to happen in the backward direction (starting from the destination address). 

The `filler` is pre-computed before the construction of successive $\beta$-as is even started:

```nim
proc computeFillerStrings(s: seq[seq[byte]]): Result[seq[byte], string] =
  var filler: seq[byte] = @[]

  for i in 1 ..< s.len:
    let
      aes_key = deriveKeyMaterial("aes_key", s[i - 1]).kdf()
      iv = deriveKeyMaterial("iv", s[i - 1]).kdf()

    let
      fillerLength = (t + 1) * k
      zeroPadding = newSeq[byte](fillerLength)

    filler = aes_ctr_start_index(
      aes_key,
      iv,
      filler & zeroPadding,
      (((t + 1) * (r - i)) + t + 2) * k,
    )

  return ok(filler)
```

Let's see how the filler will be created for a 4-hop Mix path.

As we see from the routine above for a 4-hop Mix path we will have 3 iterations (`1 ..< s.len`).

**i = 1**: $(((t+1)(r-i)) + t +2)k = ((6+1)(5-1)+6+2)\times16 = 576$

$$
\begin{matrix}
\mathsf{filler} = \mathcal{S}^0_0[576,688)
\end{matrix}
$$

or to make it more explicit:

$$
\begin{matrix}
\mathsf{filler} \; = \ \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\;\mathcal{S}_0[576,688)  
\end{matrix}  
\right.  
\end{array}
$$

**i = 2**: $(((t+1)(r-i)) + t +2)k  = ((6+1)(5-2)+6+2)\times16 = 464$

$$
\begin{matrix}
\mathsf{filler} \; = \ \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\;\mathcal{S}_1[576,688)  
\end{matrix}  
\right.  
\end{array}
$$

**i = 3**: $(((t+1)(r-i)) + t +2)k = ((6+1)(5-3)+6+2)\times16 = 352$

$$
\begin{matrix}
\mathsf{filler} \; = \ \\
\vphantom{a} \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\vphantom{a} \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\vphantom{a} \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\vphantom{a} \\  
\small\;\mathcal{S}_2[576,688)  
\end{matrix}  
\right.  
\end{array}
$$

### Constructing the header

Now that we have the filler constructed, let's have an example of a step-by-step construction of the header.

Recall, here we will be moving backwards, and the corresponding routine is as follows:

```nim
proc computeBetaGamma(
  s: seq[seq[byte]],
  hops: openArray[Hop],
  delay: openArray[seq[byte]],
  destHop: Hop,
  id: SURBIdentifier,
): Result[tuple[beta: seq[byte], gamma: seq[byte]], string] =
  let sLen = s.len
  var
    beta: seq[byte]
    gamma: seq[byte]

  let filler = computeFillerStrings(s).valueOr:
    return err("Error in filler generation: " & error)

  for i in countdown(sLen - 1, 0):
    let
      beta_aes_key = deriveKeyMaterial("aes_key", s[i]).kdf()
      mac_key = deriveKeyMaterial("mac_key", s[i]).kdf()
      beta_iv = deriveKeyMaterial("iv", s[i]).kdf()

    if i == sLen - 1:
      let destBytes = destHop.serialize()
      let destPadding = destBytes & delay[i] & @id & newSeq[byte](PaddingLength)
      let aes = aes_ctr(beta_aes_key, beta_iv, destPadding)
      beta = aes & filler
    else:
      let betaPrefix =
        beta[0 .. (((r * (t + 1)) - t) * k) - 1]

      let routingInfo = RoutingInfo.init(
        hops[i + 1],
        delay[i],
        gamma,
        betaPrefix,
      )

      let serializedRoutingInfo = routingInfo.serialize()
      beta = aes_ctr(beta_aes_key, beta_iv, serializedRoutingInfo)

    gamma = hmac(mac_key, beta).toSeq()

  return ok((beta: beta, gamma: gamma))
```

We see that the filler is indeed pre-computed before the $\beta$ construction loop even starts.

Also recall, that the same routine is called for both forward and reply paths, the difference is in the routing information for the last hop.

For forward path the `destHop` is the real destination address, encoded as a `Hop` and `id` is set to `default(SURBIdentifier)`, all zero bytes. The forward-path exit uses `destHop` to dial the destination protocol.

For the reply path the `destHop` is an empty `Hop()`, which serializes as zero address bytes. This marks that the terminal return hop is not forwarding to another destination. 'id' for the reply path is set to random nonzero SURB identifier generated by `buildSurbs`. The original sender uses it to find `connCreds`.

In what follows we use the reply path as an example (path length is $4$ as before).

**i = 3**:

As indicated above, instead of $(A_{i+1}\,\Vert\,D_i\,\Vert\,\gamma_{i+1})$ we will have $(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}})$, where space normally used for $\gamma_{i+1}$ is used to store SURB id $\mathcal{id}_{\mathsf{SURB}}$ where $\vert\mathcal{id}_{\mathsf{SURB}}\vert = \vert\gamma\vert = 16$ bytes. Just for reference, for the forward path, the final $\beta$ will be set to $(A_\mathsf{DST}\,\Vert\,\{0\}^{2}\,\Vert\,\{0\}^{16})$, where $A_\mathsf{DST}$ is the address of the destination node.

Now, $\vert(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}})\vert = 112$ bytes. The final routing information is naturally shortest (there are no more hops after it), thus in order to keep size of $\beta$ constant ($576$ bytes), we add some extra padding (`PaddingLength`) and the full filler ($3\times 112 = 336$ bytes). The extra `PaddingLength` is the consequence of the fact, that the size of $\beta$ has been chosen to accommodate max $r=5$ hops, corresponding to $5\times112=560$ bytes plus extra $\kappa=16$ bytes for future use (or for some other reason), giving $576$ in total. Because for 4-hop path, the filler is $3\times 112 = 336$ bytes long `PaddingLength` is:

$$
\begin{aligned}
\mathsf{PaddingLength} 
&= \vert\beta\vert - \vert(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}})\vert - \vert\mathsf{filler}\vert \\
&= 576 - 112 - 336 = 128
\end{aligned}
$$

or in a more generic form:

$$
\mathsf{PaddingLength} = (((t + 1)(r - \mathsf{PathLength})) + 1)k
$$

In our case `PathLength = 4`, thus,

$$
\begin{aligned}
\mathsf{PaddingLength} 
&= (((6 + 1)(5 - 4)) + 1)\times16 \\
&= (7 + 1) \times 16 \\
&= 128
\end{aligned}
$$

Before encryption thus, we have:

$$
\begin{matrix}
\widetilde\beta_3 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\vphantom{a} \\  
\small\;\mathcal{S}_2[576,688)  
\end{matrix}  
\right.  
\end{array}
$$

and after encryption $\widetilde\beta_3\;\oplus\;(\mathcal{S}_3[0,240)\;\Vert\;\{0\}^{3\times 112})$:

$$
\begin{matrix}
\beta_3 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_3[0,240)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\vphantom{a} \\  
\small\;\mathcal{S}_2[576,688)  
\end{matrix}  
\right.  
\end{array}
$$

Notice that in this first iteration only $(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128})$ is encrypted and the filler is used pre-computed.

**i = 2**:

From $\beta_3$, we drop the last filler segment ($112$ bytes) and prepend the routing info:

$$
\begin{matrix}
\widetilde\beta_2 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_3[0,240)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576)  
\end{matrix}  
\right.  
\end{array}
$$

and after encrypting $\widetilde\beta_2\;\oplus\mathcal{S}_2[0,576)$ we get:

$$
\begin{matrix}
\beta_2 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[352,464)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[352,464)}
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[464,576)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[464,576)}
\end{matrix}  
\right.  
\end{array}
$$

which after canceling out the outer filler encryption becomes:

$$
\begin{matrix}
\beta_2 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688)
\end{matrix}  
\right.  
\end{array}
$$

**i = 1**:

Here again, before next level of encryption, we drop the last filler segment ($112$ bytes) from and prepend the routing info to $\beta_2$:

$$
\begin{matrix}
\widetilde\beta_1 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576)
\end{matrix}  
\right.  
\end{array}
$$

and after encrypting $\widetilde\beta_1\;\oplus\mathcal{S}_1[0,576)$:

$$
\begin{matrix}
\beta_1 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\mathcal{S}_1[112,224)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\mathcal{S}_1[224,464)
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[464,576)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[464,576)}
\end{matrix}  
\right.  
\end{array}
$$

which leaves us with:

$$
\begin{matrix}
\beta_1 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\mathcal{S}_1[112,224)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\mathcal{S}_1[224,464)
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_0[576,688)
\end{matrix}  
\right.  
\end{array}
$$

**i = 0**: final construction step.

$$
\begin{matrix}
\widetilde\beta_0 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_1\,\Vert\,D_0\,\Vert\,\gamma_1) \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\mathcal{S}_1[112,224)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\mathcal{S}_1[224,464)
\end{array}
\right.  
\end{array}
$$

which after encryption $\widetilde\beta_0\;\oplus\mathcal{S}_0[0,576)$ gives us:

$$
\begin{matrix}
\beta_0 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_1\,\Vert\,D_0\,\Vert\,\gamma_1) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_0[0,112)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[0,112) \\
\small\;\mathcal{S}_0[112,224)  
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\mathcal{S}_1[112,224) \\
\small\;\mathcal{S}_0[224,336)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\mathcal{S}_1[224,464) \\
\small\;\mathcal{S}_0[336,576)
\end{array}
\right.  
\end{array}
$$

No fillers are left at this last step, thus nothing cancels out.

All those computations are happening in the entry layer of the node that wishes to use the MIX network for anonymous communication. The computed $\beta_0$, together with $\alpha_0$ and $\gamma_0$, will form the header $\mathcal{H}_0=(\alpha_0,\beta_0,\gamma_0)$. Each SURB header will be included in the corresponding SURB packet. All SURBs will be pre-pended to the message forming the actual payload $\delta$, which after onion encryption together with the forward path header will be sent to the first forward path hop. The exit node seeing that the reply is expected will retrieve the reply message from the destination node and send it back using all included SURB packets.

## Processing the header

When processing, at each hop $i$ the node removes its own routing information, i.e. the $(t+1)\kappa=112$ bytes, containing sequence $(A_{i+1}\,\Vert\,D_i\,\Vert\,\gamma_{i+1})$, where $A_{i+1}$ is the address of the next hop, $D_i$ is the delay for the current hop, and $\gamma_{i+1}$ is the MAC of the (encrypted) next $\beta$ (so, $\beta_{i+1}$). The tricky part is that the whole $\beta$ is encrypted and $\beta_{i+1}$ (further encrypted with $\mathcal{S}_{i+1}$) inside of it is missing the last $112$ bytes that were removed during header construction to accommodate the routing information of the **previous** hop (remember we are be going backward during header construction) while keeping the header size constant. We already know that the current node cannot just directly decrypt the whole $\beta_i$, and pad the last $112$ bytes with e.g. $\{0\}^{112}$, because this would leak the information about the message position in the mix path. Instead it makes sure that the last $112$ bytes are random. It achieves this by using its own decryption keystream (derived from its secret $s_i$) it uses to decrypt $\beta_i$. It does so, by appending $\{0\}^{112}$ **before** decrypting its own $\beta_i$. Thus, for all hops except the final one, the received $\beta_i$ is:

$$
\beta_i = ((A_{i+1}\,\Vert\,D_i\,\Vert\,\gamma_{i+1})\;\Vert\;\mathsf{trunc}_{[0,464)}(\beta_{i+1}))\oplus\mathcal{S}_i[0,576)
$$

Or using our special notation:

$$
\begin{matrix}
\beta_i \; = \ \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
(A_{i+1}\,\Vert\,D_i\,\Vert\,\gamma_{i+1}) \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_i[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\vphantom{a}
\end{matrix}
\begin{array}{l}
\mathsf{trunc}(\beta_{i+1}) \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_i[112,576)  
\end{matrix}  
\right.  
\end{array}
$$

Before decrypting $\beta_i$ using $\mathcal{S}_i$, we first append $\{0\}^{112}$ to it. Then we perform XOR operation
using $\mathcal{S}_i[0,688)$:
$$
\begin{matrix}
\mathcal{B}_i \; = \ \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
(A_{i+1}\,\Vert\,D_i\,\Vert\,\gamma_{i+1}) \\
\,\left\vert
\begin{matrix}  
\small\enclose{horizontalstrike}{\mathcal{S}_i[0,112)} \\
\small\enclose{horizontalstrike}{\mathcal{S}_i[0,112)}  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\mathsf{trunc}(\beta_{i+1}) \\
\,\left\vert
\begin{matrix}  
\small\enclose{horizontalstrike}{\mathcal{S}_i[112,576)} \\
\small\enclose{horizontalstrike}{\mathcal{S}_i[112,576)}  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\vphantom{a} \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\;\mathcal{S}_i[576,688)  
\end{matrix}  
\right.  
\end{array}\color{blue}
$$

which is nothing more than $(\beta_i\;\Vert\;\{0\}^{112})\;\oplus\;\mathcal{S}_i[0,688)$:

$$
\begin{matrix}
\mathcal{B}_i \; = \ \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_{i+1}\,\Vert\,D_i\,\Vert\,\gamma_{i+1}) \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\;\Large\Vert\; \\
\vphantom{a}
\end{matrix}
\begin{matrix}
\mathsf{trunc}(\beta_{i+1}) \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\;\Large\Vert\; \\
\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\;\mathcal{S}_i[576,688)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\; = \; \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_{i+1}\,\Vert\,D_i\,\Vert\,\gamma_{i+1}) \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\;\Large\Vert\; \\
\vphantom{a}
\end{matrix}
\begin{matrix}
\beta_{i+1} \\
\small\vphantom{a}
\end{matrix}
$$
$\beta_{i+1}$ above is the $\beta$ that the next hop will receive and its MAC will have to match $\gamma_{i+1}$. The $\{0\}^{112}\;\oplus\;\mathcal{S}_i[576,688)$ in the equation above, is part of the filler, and each hop will reveal another fragment of it. On arriving at the last hop, the whole filler will be reconstructed. For example, for a 4-hop reply path, the $\beta_3$ received by the last Mix node on the path will be:

$$
\beta_3 = ((\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128})\;\oplus\;\mathcal{S}_3[0,240))\;\Vert\;\mathsf{filler}
$$

Also, here, it will be extended and XORed using $\mathcal{S}_3[0,688)$ resulting in:

$$
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128})\;\Vert\;(\mathsf{filler}\;\oplus\;\mathcal{S}_3[240,688))
$$

The filler part will be dropped leaving us with:

$$
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128})
$$

For the forward path the processing will be analogical, the only difference is that instead of $(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128})$ in $\beta_3$ we will have $(A_\mathsf{DST}\,\Vert\,\{0\}^{2}\,\Vert\,\{0\}^{16}\,\Vert\,\{0\}^{128})$.


Let's take a look at an example processing in the reply path. It is largely identical to the forward path, only the processing at the final destination, which in case of SURB packets is the original sender, will be different.

The exit node sends the encrypted payload (with the key included in the given SURB), to the first hop on the return path. The address of the corresponding mix node is included in the SURB packet. Thus, our processing example starts at thevery fist hop - hop 0. 

**hop 0**:

The node extracts $\alpha_0$, $\beta_0$, and $\gamma_0$ from the header. Using $\alpha_0$ and its own private key, it derives the shared secret $s_0$, from which other keys are subsequently derived. In this document we focus on the processing of the $\beta$ element, so the details of the key derivation are skipped. We assume that the node has $\mathcal{S}_0$ - the AES-CTR keystream derived from the per-hop shared secret $s_0$.

Before decrypting $\beta_0$, the node appends $\{0\}^{112}$ to the end of it:

$$
\mathcal{B}_0 = (\beta_0\;\Vert\;\{0\}^{112})\;\oplus\;\mathcal{S}_0[0,688)
$$

With more details:

$$
\begin{matrix}
\mathcal{B}_0 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_1\,\Vert\,D_0\,\Vert\,\gamma_1) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[0,112)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[0,112)}
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[0,112) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[112,224)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[112,224)}
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\mathcal{S}_1[112,224) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[224,336)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[224,336)}
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\mathcal{S}_1[224,464) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[336,576)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_0[336,576)}
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_0[576,688)
\end{matrix}  
\right.  
\end{array}
$$

which reduces to:

$$
\begin{matrix}
\mathcal{B}_0 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_1\,\Vert\,D_0\,\Vert\,\gamma_1) \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[0,112)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\mathcal{S}_1[112,224)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\mathcal{S}_1[224,464)
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_0[576,688)
\end{matrix}  
\right.  
\end{array}
$$

We see that $(A_1\,\Vert\,D_0\,\Vert\,\gamma_1)$ is successfully decrypted. It is then removed and the remaining part is shifted to the left by the size of $(A_1\,\Vert\,D_0\,\Vert\,\gamma_1)$ - $112$ bytes:

$$
\begin{matrix}
\beta_1 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\mathcal{S}_1[112,224)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\mathcal{S}_1[224,464)
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_0[576,688)
\end{matrix}  
\right.  
\end{array}
$$

Yes, this is exactly the same $\beta_1$ we constructed in construction phase we shown in the previous section. Notice the appended part of the filler. If there would be any different or misalignement in the reconstructed $\beta_1$, the next node would detect it using the received MAC $\gamma_1$. The node at hop 0 is not able to fake that $\gamma_1$, as it is keyed with $\mathcal{S}_1$, which the node at hop 0 does not have.

Now we should start seeing how it all works.

**hop 1**:

$$
\mathcal{B}_1 = (\beta_1\;\Vert\;\{0\}^{112})\;\oplus\;\mathcal{S}_1[0,688)
$$

$$
\begin{matrix}
\mathcal{B}_1 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[0,112)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[0,112)}
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[112,224)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[112,224)}
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[224,464)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_1[224,464)}
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688)
\end{matrix}  
\right.  
\end{array}
$$

This reduces to:

$$
\begin{matrix}
\mathcal{B}_1 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_2\,\Vert\,D_1\,\Vert\,\gamma_2) \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352)
\end{array}
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688)
\end{matrix}  
\right.  
\end{array}
$$

After removing $(A_2\,\Vert\,D_1\,\Vert\,\gamma_2)$ and shifting to the left, we get the original constructed $\beta_2$:

$$
\begin{matrix}
\beta_2 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_2[0,112)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\mathcal{S}_2[112,352)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688)
\end{matrix}  
\right.  
\end{array}
$$

**hop 2**:

$$
\mathcal{B}_2 = (\beta_2\;\Vert\;\{0\}^{112})\;\oplus\;\mathcal{S}_2[0,688)
$$

$$
\begin{matrix}
\mathcal{B}_2 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[0,112)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[0,112)}
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\;\mathcal{S}_3[0,240) \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[112,352)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_2[112,352)}
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_2[576,688)
\end{matrix}  
\right.  
\end{array}
$$

which is:

$$
\begin{matrix}
\mathcal{B}_2 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
(A_3\,\Vert\,D_2\,\Vert\,\gamma_3) \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{array}{l}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_3[0,240)
\end{array}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_2[576,688)
\end{matrix}  
\right.  
\end{array}
$$

which, after removing $(A_3\,\Vert\,D_2\,\Vert\,\gamma_3)$ and shifting, gives us:

$$
\begin{matrix}
\beta_3 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_3[0,240)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576)  
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\vphantom{a} \\  
\small\;\mathcal{S}_2[576,688)  
\end{matrix}  
\right.  
\end{array}
$$

It matches $\beta_3$ from the construction phase, and we also now see fully reconstructed filler.

**hop 3**:

$$
\mathcal{B}_3 = (\beta_3\;\Vert\;\{0\}^{112})\;\oplus\;\mathcal{S}_3[0,688)
$$

$$
\begin{matrix}
\mathcal{B}_3 \; = \ \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128}) \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_3[0,240)} \\
\small\;\enclose{horizontalstrike}{\mathcal{S}_3[0,240)}
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\;\mathcal{S}_0[576,688) \\
\small\;\mathcal{S}_1[464,576) \\
\small\;\mathcal{S}_2[352,464) \\
\small\;\mathcal{S}_3[240,352)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}
\{0\}^{112} \\
\,\left\vert
\begin{matrix}
\small\vphantom{a} \\
\small\;\mathcal{S}_1[576,688) \\
\small\;\mathcal{S}_2[464,576) \\
\small\;\mathcal{S}_3[352,464)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\vphantom{a} \\  
\small\;\mathcal{S}_2[576,688) \\
\small\;\mathcal{S}_3[464,576)
\end{matrix}  
\right.  
\end{array}
\begin{matrix}
\quad\Large\Vert\quad \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\vphantom{a}
\end{matrix}
\begin{array}{l}  
\{0\}^{112} \\
\,\left\vert
\begin{matrix}  
\small\vphantom{a} \\  
\small\vphantom{a} \\
\small\vphantom{a} \\
\small\;\mathcal{S}_3[576,688)  
\end{matrix}  
\right.  
\end{array}
$$

There is no $\beta_4$, and of course, the filler after this last step does not make any sense anymore, but we are only interested in the first $240$ bytes:

$$
(\{0\}^{94}\,\Vert\,\{0\}^{2}\,\Vert\,\mathcal{id}_{\mathsf{SURB}}\,\Vert\,\{0\}^{128})
$$

This is the end of the processing phase for the $\beta$ element, and the end of this document.