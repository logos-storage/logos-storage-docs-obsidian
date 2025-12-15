The following bigger changes has been observed:

- added `context` to `HandleCommunityMessageArchiveMagnetlink` so that the signature now looks like this: 
  
```go
  func (m *Messenger) HandleCommunityMessageArchiveMagnetlink(ctx context.Context, state *ReceivedMessageState, message *protobuf.CommunityMessageArchiveMagnetlink, statusMessage *common.StatusMessage) error {

return m.HandleHistoryArchiveMagnetlinkMessage(state, state.CurrentMessageState.PublicKey, message.MagnetUri, message.Clock)
}
```

### Makefile

(1) extended parts related to `libwaku` and `libsds`

(2) building main target does refer to vendors:

```bash
.PHONY: $(GO_CMD_NAMES) $(GO_CMD_PATHS) $(GO_CMD_BUILDS)
$(GO_CMD_BUILDS): generate $(LIBWAKU) $(LIBSDS)
$(GO_CMD_BUILDS): ##@build Build any Go project from cmd folder
	CGO_ENABLED=1 \
	CGO_CFLAGS="$(CGO_CFLAGS)" \
	CGO_LDFLAGS="$(CGO_LDFLAGS)" \
	go build -v \
		-tags '$(BUILD_TAGS)' $(BUILD_FLAGS) \
		-o ./$@ ./cmd/$(notdir $@)
	@echo "Compilation done."
	@echo "Run \"build/bin/$(notdir $@) -h\" to view available commands."
```

You see now they use:

```bash
go build -v \
```

previously they had:

```bash
go build -mod=vendor -v \
```

This is in commit `1f18d4d326537e1da90faac6b29dee6aa3bdc6d1`:

```
chore: stop vendoring (#6951)
* chore: ignore go work
* chore: stop vendoring
ci: update github pr workflow
chore: update nix vendor hash
* feat(Makefile): vendor-hash
* fix(Makefile): colors
* chore: rm -rf vendor
* chore: update nix vendorHash
```

### nix

Nix has been slightly updated:

```nix
in mkShell {
  name = "status-go-shell";

  buildInputs = with pkgs;
    lib.optionals (stdenv.isDarwin) [ xcodeWrapper llvmPackages.openmp ] ++ [
    git jq which
    go golangci-lint go-junit-report gopls codecov-cli
    protobuf3_24 protoc-gen-go gotestsum openjdk openssl
    rustc cargo
  ];
```

to:

```nix
in mkShell {
  name = "status-go-shell";

  buildInputs = with pkgs;
    lib.optionals (stdenv.isDarwin) [ xcodeWrapper ] ++ [
    git jq which
    go golangci-lint go-junit-report gopls codecov-cli
    protobuf3_24 protoc-gen-go gotestsum openjdk openssl
    rustc cargo
    nim
    lib-sds-pkg
  ];
```

and then on top of that we have our changes:

```nix
in mkShell {
  name = "status-go-shell";

  buildInputs = with pkgs;
    lib.optionals (stdenv.isDarwin) [ xcodeWrapper llvmPackages.openmp ] ++ [
    git jq which
    go golangci-lint go-junit-report gopls codecov-cli
    protobuf3_24 protoc-gen-go gotestsum openjdk openssl
    rustc cargo
    nim
    lib-sds-pkg
  ] ++ lib.optionals (!stdenv.isDarwin) [ gcc ];
```
