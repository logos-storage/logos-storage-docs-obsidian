Here are some basic steps to follow:

### Step 1: Initialize the application

```bash
curl -sS http://127.0.0.1:45453/statusgo/InitializeApplication \
  -H 'Content-Type: application/json' \
  -d '{"dataDir":"/tmp/status-go-test"}'
```

### Step 2: Create an account (if you don't have one) OR login

```bash
curl -sS http://127.0.0.1:45453/statusgo/CreateAccountAndLogin \
  -H 'Content-Type: application/json' \
  -d '{
    "rootDataDir": "/tmp/status-go-test",
    "displayName": "TestUser",
    "password": "test123456",
    "customizationColor": "blue"
  }'
```

or if you already have account:

```bash
curl -sS http://127.0.0.1:45453/statusgo/LoginAccount -X POST -H 'Content-Type: application/json' -d '{
  "rootDataDir": "/tmp/status-go-test",
  "keyUid": "0x9b755874a92bcc2d20c730fc76d451f44b39868cc8fbd31f2ff74907e299e7fd",
  "password": "test123456"
}'
```

If you see `{"error":""}` as the output it means the command was successful and there is no error.

If you try to call the API before login, you will get the following error (example):

```bash
❯ curl -sS http://127.0.0.1:45453/statusgo/CallRPC -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"wakuext_getArchiveDistributionPreference","params":[]}'
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"the method wakuext_getArchiveDistributionPreference does not exist/is not available"}}
```


I did not record the output of the `CreateAccountAndLogin` but in the returned response object you should be able to find the `keyUid` mentioned above. It is also included in the response from `InitializeApplication` for each existing account:

```bash
curl -sS http://127.0.0.1:45453/statusgo/InitializeApplication \
  -H 'Content-Type: application/json' \
  -d '{"dataDir":"/tmp/status-go-test"}'
{"accounts":[{"name":"TestUser","timestamp":1762236462,"identicon":"","colorHash":[[3,9],[5,18],[3,24],[5,22],[4,6],[5,23],[2,3],[4,24],[1,27],[5,21],[3,11]],"colorId":3,"customizationColor":"blue","keycard-pairing":"","key-uid":"0x9b755874a92bcc2d20c730fc76d451f44b39868cc8fbd31f2ff74907e299e7fd","images":null,"kdfIterations":3200,"hasAcceptedTerms":true}],"centralizedMetricsInfo":{"enabled":false,"userConfirmed":false,"userID":""}}
```

The `keyUid` is a unique identifier for each account in status-go. You can also find it by looking at the database filenames in the data directory.

When you create an account, status-go creates database files with a specific naming pattern:

```
<address><keyUid>-v4.db
<address><keyUid>-wallet.db
```

In my case:
```bash
ls -la /tmp/status-go-test/
```

Showed files like:
```
0x9b755874a92bcc2d20c730fc76d451f44b39868cc8fbd31f2ff74907e299e7fd-v4.db
0x9b755874a92bcc2d20c730fc76d451f44b39868cc8fbd31f2ff74907e299e7fd-wallet.db
```

The filename pattern is: `<ethereum-address><key-uid>-<db-type>.db`

Breaking it down:
- **Address**: `0x9b755874a92bcc2d20c730fc76d451f44b39868c` (42 characters - standard Ethereum address)
- **KeyUID**: `c8fbd31f2ff74907e299e7fd` (the remaining characters before the dash)

So the full keyUid is actually: `0x9b755874a92bcc2d20c730fc76d451f44b39868cc8fbd31f2ff74907e299e7fd` (combining both parts).

You can also query the accounts database:
```bash
❯ sqlite3 /tmp/status-go-test/accounts.sql "SELECT keyUid, name FROM accounts;"
0x9b755874a92bcc2d20c730fc76d451f44b39868cc8fbd31f2ff74907e299e7fd|TestUser
```

The keyUid is essentially derived from the account's key material and is used to uniquely identify the account across the system.

### Step 3: Start the messenger (optional)

I initially thought this is necessary - but it turns out that logging in is sufficient. But for reference:

```bash
curl -sS http://127.0.0.1:45453/statusgo/CallRPC \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"wakuext_startMessenger","params":[]}'
```
### Step 4: Now you can call your method!

Some examples:

```bash
❯ curl -sS http://127.0.0.1:45453/statusgo/CallRPC -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"wakuext_getArchiveDistributionPreference","params":[]}'
{"jsonrpc":"2.0","id":1,"result":"codex"}
```

```bash
❯ curl -sS http://127.0.0.1:45453/statusgo/CallRPC -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"wakuext_setArchiveDistributionPreference","params":[{"preference":"codex"}]}'
{"jsonrpc":"2.0","id":1,"result":"codex"}
```

```bash
❯ curl -sS http://127.0.0.1:45453/statusgo/CallRPC   -H 'Content-Type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"wakuext_getMessageArchiveInterval","params":[]}'
{"jsonrpc":"2.0","id":1,"result":604800000000000}
```

```bash
curl -sS http://127.0.0.1:12345/statusgo/CallRPC -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"wakuext_updateMessageArchiveInterval","params":[10000]}'
{"jsonrpc":"2.0","id":1,"result":10000}
```
