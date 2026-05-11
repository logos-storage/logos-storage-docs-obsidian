A youtube video about Mix and Sphinx: https://youtu.be/34TKXELJa2c?is=J8G4cNyG3djsWdtm

Notes:

Mixing strategies and how mixing nodes can add security to the messages:
- buffer the messages and send them or regular intervals,
- Buffer messages till a selected number of the is collected and then send all of them or just a selection of them - pool model
- Messages can be tagged by the sender to indicate special security requirements

Mix format
- has to hide the length of the message
- where you are in the path - if you just add a layer of encryption, the message gets longer and longer leaking its potential position in the  mix path
- includes mechanism that allows the recipient to reply to the message in an anonymous way - it should be indistinguishable from the *forward messages*. It comes from the concept called anonymity set: number of people that use the system - that could have send the given message. E.g. if only, say 10 people use the system it is obviously way easier to figure out the potential recipient and the sender. Thus, the larger the number of people using the system, the bigger the anonymity set and the better protection. If the reply messages are distinguishable from the forward messages, we are effectively dealing with two mix nets with effectively lower corresponding anonymity sets.

Existing Mix format

- Mixmaster (1998)
	- No replies
	- Heuristic security (you define the level of security by how many known attacks the network survives)
- Möller (2003), Camenish & Lysyanskaya (2005)
	- provable security - a mathematical proof that if you can break some aspect of the system then you can solve some problems believed to be hard (like factoring or discrete logs)
	- still no (indistinguishable) replies
	- never actually deployed
- Mixminion (2003)
	- a follow-up to Mixmaster
		- Heuristic security
	- has indistinguishable replies
	- deployed
- Minx (2004)
	- First attempt of a *compact* mix format - the overhead - the headers you need to route the message through the network - has a certain size (kB or tens of kB), which may not be ideal if your messages are very small
	- indistinguishable replies
	- heuristic security
		- BROKEN
- Shimsock, Staats, Hopper (2008) - ”SSH 08”
	- Broke Minx, provided provable security fix
	- has indistinguishable replies
	- But: very expensive to construct mix messages
	- The only way add an e.g. address of the next mix to the message was to share a cryptographic hash with the next mix - that hash has to contain the information (routing info) Alice wants to convey, e.g. to convey a 32 bit address, Alice would have to create mix packets that hash to that 32 bit address (2^32 - 4 billion tries in the worst case)
		- to make that easier, the only information that Alice is allowed to convey is the identity of the next hop and there are at most 255 different mix nodes - we store their addresses in a table and Alice just has to convey 8 bits of information (indicating the row in the table) - so 2^8 x number of hops.
- Sphinx takes the best of the all above approaches
	- Provable security
	- supports indistinguishable replies
	- compact
	- Computationally cheap

![[Pasted image 20260331141209.png]]

- r - maximum length of the path (common value 3, 5, 10)
- s - size of the symmetric key in bytes - how much we choose for s depends on the level of security we want - commonly at that time 80-bit security - 2^80 operations for an attacker to brake the system. Today we prefer to use around 128 bits (16 bytes)
- p - size of the public key - also depends on the security level you want - e.g. for 80 bits security, you may need to have something like 1000-bit public key if you are using RSA or something like that… It also depends on which system you use: for RSA, Elgamal, or Diffie-Hellman, the key size will be rather big, for elliptic curves the key will be much smaller for the same security.

Some examples:

RSA-like…

![[Pasted image 20260331142627.png]]

EC:

![[Pasted image 20260331142912.png]]

Around 100 bytes for 80-bit security.

### Sphinx message format

![[Pasted image 20260331143337.png]]

![[Pasted image 20260331144536.png]]

Now, we could be tempted to use the same alpha for each hop (and different for different message/recipient), but then the message coming into the mix node and one coming out to the mix node could be correlated.

![[Pasted image 20260331145433.png]]