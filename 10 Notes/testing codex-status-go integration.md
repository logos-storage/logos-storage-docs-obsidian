First some low level simple manual tests.

We will be running codex client, and then use a small testing utility to check if the low level abstraction - CodexClient - correctly uploads and downloads the content.
### Running CodexClient

I often remove some logging noise, by slightly changing the build params in `build.nims`:

```nim
task codex, "build codex binary":
  buildBinary "codex",
    # params = "-d:chronicles_runtime_filtering -d:chronicles_log_level=TRACE"
    params =
      "-d:chronicles_runtime_filtering -d:chronicles_log_level=TRACE -d:chronicles_enabled_topics:restapi:TRACE,node:TRACE"
```

You see a slightly more selective `params` in the `codex` task.

To run the client I use the following command:

```bash
./build/codex --data-dir=./data-1 --listen-addrs=/ip4/127.0.0.1/tcp/8081 --api-port=8001 --nat=none --disc-port=8091 --log-level=TRACE
```

### Building codex-upload and codex-download utilities

Use the following command to build the `codex-upload` and `codex-download` utilities:

```bash
go build -o bin/codex-upload ./cmd/upload
go build -o bin/codex-download ./cmd/download
```
### Uploading content to Codex

Now, using the `codex-upload` utility, we can upload the content to Codex as follows:

```bash
~/code/local/go-codex-client
❯ ./bin/codex-upload -file test-data.bin -host localhost -port 8001
Uploading test-data.bin (43 bytes) to Codex at localhost:8001...
✅ Upload successful!
CID: zDvZRwzm8K7bcyPeBXcZzWD7AWc4VqNuseduDr3VsuYA1yXej49V
```

### Downloading content from Codex

Now, having the content uploaded to Codex - let's get it back using the `codex-download` utility:

```bash
~/code/local/go-codex-client
❯ ./bin/codex-download -cid zDvZRwzm8K7bcyPeBXcZzWD7AWc4VqNuseduDr3VsuYA1yXej49V -file output.bin -host localhost -port 8001
Downloading CID zDvZRwzm8K7bcyPeBXcZzWD7AWc4VqNuseduDr3VsuYA1yXej49V from Codex at localhost:8001...
✅ Download successful!
Saved to: output.bin
```

You can easily compare that the downloaded content matches the original using:

```bash
~/code/local/go-codex-client
❯ openssl sha256 test-data.bin
SHA2-256(test-data.bin)= c74ce73165c288348b168baffc477b6db38af3c629b42a7725c35d99d400d992

~/code/local/go-codex-client
❯ openssl sha256 output.bin
SHA2-256(output.bin)= c74ce73165c288348b168baffc477b6db38af3c629b42a7725c35d99d400d992
```

### Running tests

There are a couple of basic tests, including one integration test.

To run the unit tests:

```bash
❯ go test -v ./communities
=== RUN   TestUpload_Success
--- PASS: TestUpload_Success (0.00s)
=== RUN   TestDownload_Success
--- PASS: TestDownload_Success (0.00s)
=== RUN   TestDownloadWithContext_Cancel
--- PASS: TestDownloadWithContext_Cancel (0.04s)
PASS
ok  	go-codex-client/communities	0.044s
```

To run the integration test, use `integration` tag and narrow the scope using `-run Integration`:

```bash
go test -v -tags=integration ./communities -run Integration -timeout 15s
```
