
Undigested chat on the options we have for structuring a C Codex API on top of Chronos code.

### Giuliano (part-time) _—_ 9:15 AM

Hey, thanks for the reply. I mean how do you wrap something that's mostly chronos-based and expose it over a C library. ![🙂](https://discord.com/assets/0424e06a82d250e2.svg) You obviously can't have synchronous (blocking) functions, and you don't have async/await support in C, so you'd likely have to translate this into callbacks and/or events somehow. I was wondering if anyone did anything like that before so we could take inspiration. Gonna have a look at libwaku, thanks.

### autobotAPP _—_ 9:37 AM

cheatfate@nimbus: There actually many approaches how to do it As fast example:

1. You could make it like Postgresql libpq, which will allow you to put the library into custom event processing loop binary. I think its the most complex approach, but the most flexible.
2. You could start thread which will be running all the chronos stuff and establish synchronous public API which will communicate with thread over pipes/sockets and return results
3. Mostly the same as `2` but does not provide any API calls but allow communication throught pipe/socket to application.

- ### cheatfate@nimbusAPP _—_ 9:37 AM
    
    Examples of `2` and `3` could be found, but nobody ever tried `1` yet.
    
- ### autobotAPP _—_ 9:42 AM
    
    enzeepee@waku: Actially it is the second we use with libwaku. But you also need a separated thread for your nim library to let nim gc work is own (especially with refc). ...and you need to take care on who allocates / free memory on the lib boundary. Here is my proposal, work in progress... [https://docs.google.com/presentation/d/1ysjFIDKaV1FdupvH2C2ZkqAoDOkxOvv2dbP4rsZIrmk/edit?usp=sharing](https://docs.google.com/presentation/d/1ysjFIDKaV1FdupvH2C2ZkqAoDOkxOvv2dbP4rsZIrmk/edit?usp=sharing "https://docs.google.com/presentation/d/1ysjFIDKaV1FdupvH2C2ZkqAoDOkxOvv2dbP4rsZIrmk/edit?usp=sharing")
    

- ### cheatfate@nimbusAPP _—_ 9:45 AM
    
    In my proposal of `1` Nim library is not required to run in thread.
    

- I see in your proposal is too many concentration on `protobuf`... i do not really care how to transfer data, using `protobuf` or any other scheme, for me we could use SSZ
    
- ### autobotAPP _—_ 9:48 AM
    
    enzeepee@waku: Can you elaborate it deeper? How do you know the users threading strategy? How can you be sure the chronos' async loop to get time to run? Of course it really depends on what is the purpose of the lib, with waku we thinking on actively doing networking in the background that cannot depend on user processing.
    
- ### autobotAPP _—_ 9:49 AM
    
    enzeepee@waku: Yeah, protobuf is an example channel here, already supported on both sides (almost any language has its port).
    
- ### autobotAPP _—_ 9:50 AM
    
    cheatfate@nimbus: I prefer more simple approaches which could be decoded much more faster
    
- ### autobotAPP _—_ 9:51 AM
    
    cheatfate@nimbus: chronos is mostly single threaded library, of course it has some threading primitives but there it does not create any threads yet, and so the only thing that it needs for running is calls to `poll()` function (which powers it). If you check asynchronous API of libpq library in PostgreSQL documentation you will find what i'm proposing...
    
- ### autobotAPP _—_ 9:54 AM
    
    enzeepee@waku: Yes that can be a value, for me protobuf comes with clear definition that acts as a contract for the exposed API, like open api or so. Also we are able to generate code with ease from it. But of course its debatable.
    

- ### cheatfate@nimbusAPP _—_ 9:54 AM
    
    so actually when you call `{.async.}` function it will returns to you immediately after it finds the block or call which is going to block execution... After that you are required to call `chronos.poll()` function to power up events... So the main idea is to return some kind of primitives instead of `Future` which application could use as tokens to check if this operation actually completed or not yet.
    

Such approach allows to integrate chronos powered library into other async loop, probably not Go (just because of thread scheduler), but at least to any other language which has async loop (Python, Rust, C++).

- ### autobotAPP _—_ 10:01 AM
    
    enzeepee@waku: Sure, but requires greater prerequisites from the user, compared to allow threading. (For waku Golang binding is a must) In my head such a lib integration shall be fool proof in the sense we do not require anything from the user of the lib other than initilization in the begining. Of course threading comes with price. But in this sense I see no use case to provide a chronos like nim library to other languages to use, but more complex solutions like waku or codex.
    

### cheatfate@nimbusAPP _—_ 10:02 AM

You probably should always start with `Go language` as requirement, because of its runtime its completely different from any other language. So if you want to communicate with `Go Language` you are REQUIRED to create socket/pipe connection and exchange with messages through it. But i thought are talking not about `Go Language`.

- you should always mention that under `nim-ffi` you mean `Go-FFI`.
    
- ### autobotAPP _—_ 10:03 AM
    
    enzeepee@waku: You're right, I'm now too much focued on waku APIs exposure...
    

- ### enzeepee@wakuAPP _—_ 10:07 AM
    
    I would argue with Go-FFI, I would like a generic support that allows to write simple nim API (regular procs) and support them from mainly any other langs. Currently we have a working solution for libwaku which is proven to be working (Go, Rust, Python, node) but needs manual ground work for any extension and change. So for me if it works for Go, we can easily make it work for Rust, ....
    

- ### cheatfate@nimbusAPP _—_ 10:08 AM
    
    of course, but for Rust we could find more performant ways of communications
    

- Because passing big amounts of data through pipe does not give you a good performance
    

- mostly because pipes has internal buffer which for linux is 128kb if i remember correctly...
    

- So if you going to pass like 100+Mb of data between this channel, you should consider more performant ways
    

### arnetheduck@nimbusAPP _—_ 10:28 AM

for logos C api's in particular, the level of support/granularity offered should be similar to that of your REST/JSON-RPC interface, ie the C api should expose mostly the same operations as you would have when using `web3` to access ethereum.. the API's should follow more or less the same pattern where the API is asynchronous in the sense that it separates request from response, that requests are allowed to come in on any thread and that responses are returned on an unspecified thread as well. to deal with an API like that, it's important that you encapsulate all data in a Context object of some sort that the user initializes when they start using your library and then passes to your every function - in this init function, you can indeed launch a context thread in which chronos operates - then you post work to this thread and respond to the caller when results are ready - you wouldn't expose _chronos_ types per se but rather higher-level constructs, indeed in some RPC-like serialization (protobuf / cbor / json / ssz / etc depends on what you're already offering as API options go).. nwaku is one example, the nimbus verifying proxy another - we don't have any _excellent_ channel implementation right now - instead, each project has implemented its own ad-hoc - the nwaku one is as good a starting point as any though eventually this will crystallise into a bespoke chronos-based channel that uses the chronos ThreadSignalPtr mechanism to wake the thread ([https://github.com/arnetheduck/nora-poc/blob/master/src/threadchannel.nim](https://github.com/arnetheduck/nora-poc/blob/master/src/threadchannel.nim "https://github.com/arnetheduck/nora-poc/blob/master/src/threadchannel.nim") is the beginning of such a channel as well).. later, we can replace the channel with something more efficient, as @cheatfate suggests but I wouldn't worry about it for now - for the granularity we're discussing, this shouldn't be a bottleneck

- GitHub
    
    [nora-poc/src/threadchannel.nim at master · arnetheduck/nora-poc](https://github.com/arnetheduck/nora-poc/blob/master/src/threadchannel.nim)
    
    seaqt playground. Contribute to arnetheduck/nora-poc development by creating an account on GitHub.
    
    [](https://opengraph.githubassets.com/1679faf5c2d4d8937616d8d02c9d67fedfc2d917361a5d081ee681112609d662/arnetheduck/nora-poc)
    
    ![seaqt playground. Contribute to arnetheduck/nora-poc development by creating an account on GitHub.](https://images-ext-1.discordapp.net/external/I5JzRl_RVWeZyqrg3XykI57ERm-qniJseSGv2EynV1E/https/opengraph.githubassets.com/1679faf5c2d4d8937616d8d02c9d67fedfc2d917361a5d081ee681112609d662/arnetheduck/nora-poc?format=webp&width=400&height=200)
    

- standardising on this "context+thread" approach is probably more important than any single technology choice - ie, it's more important to be consistent than to innovate, per project
    

- ### enzeepee@wakuAPP _—_ 10:31 AM
    
    I can just agree!
    

### arnetheduck@nimbusAPP _—_ 10:31 AM

a minimal example / precursor to nwaku is probably the verifying proxy: [https://github.com/status-im/nimbus-eth1/blob/master/nimbus_verified_proxy/libverifproxy/verifproxy.nim](https://github.com/status-im/nimbus-eth1/blob/master/nimbus_verified_proxy/libverifproxy/verifproxy.nim "https://github.com/status-im/nimbus-eth1/blob/master/nimbus_verified_proxy/libverifproxy/verifproxy.nim")

GitHub

[nimbus-eth1/nimbus_verified_proxy/libverifproxy/verifproxy.nim at m...](https://github.com/status-im/nimbus-eth1/blob/master/nimbus_verified_proxy/libverifproxy/verifproxy.nim)

Nimbus: an Ethereum Execution Client for Resource-Restricted Devices - status-im/nimbus-eth1

[](https://opengraph.githubassets.com/475ba8f3355601a39da7cbc7caa1c5fd2e623a1d738128704ce4ce0c6ce194a6/status-im/nimbus-eth1)

![Nimbus: an Ethereum Execution Client for Resource-Restricted Devices - status-im/nimbus-eth1](https://images-ext-1.discordapp.net/external/CZKRNjouu525bb3-tWxblRWi95zdp8XjXQQp1ucyWnw/https/opengraph.githubassets.com/475ba8f3355601a39da7cbc7caa1c5fd2e623a1d738128704ce4ce0c6ce194a6/status-im/nimbus-eth1?format=webp&width=400&height=200)

- it's lacking in functionality but it's easy to see the pattern from there
    

### autobotAPP _—_ 10:33 AM

enzeepee@waku: It is exactly what libwaku is doing now. cc: @ivansete_fb

### autobotAPP _—_ 10:34 AM

arnetheduck@nimbus: not without reason ![😛](https://discord.com/assets/426e7fc34498f6f9.svg)

### Giuliano (part-time) _—_ 10:52 AM

Thanks guys, this definitely is abundant material to get us in the right direction.