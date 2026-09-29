---
tags:
  - logos-storage
  - development
  - nix
verified: 2026-09-29
---

# Basecamp and Storage - Build and Testing Workflow

This note covers how Basecamp, Storage UI, Storage Module, and `libstorage` (built from `logos-storage-nim`) fit together, how to test local changes, and how to prepare for the testing session on **2026-09-30**.

The commands and source definitions were checked on 2026-09-29. The builds and installation steps were not executed as part of preparing this note. Branches and remote scripts can change; the session-specific versions below record what was inspected.

## How the repositories fit together

```text
Basecamp                         Desktop host; installs and loads apps/modules
└── storage-ui                   Storage screens and UI backend
    └── storage-module           Exposes Storage through the Logos module API
        └── logos-storage-nim    Builds libstorage, the Storage library used by the module
```

| Repository | Local checkout | Role |
| --- | --- | --- |
| `logos-basecamp` | `/home/mc2/code/logos-co/logos-basecamp` | Hosts the desktop application and manages installed apps/modules. |
| `logos-storage-ui` | `/home/mc2/code/logos-co/logos-storage-ui` | Provides the Storage interface; calls `storage_module` through the Logos API. |
| `logos-storage-module` | `/home/mc2/code/logos-co/logos-storage-module` | Wraps libstorage as a Logos module. |
| `logos-storage-nim` | `/home/mc2/code/logos-storage/logos-storage-nim` | Implements the Storage node and libstorage. |

There are four separate operations:

1. **Build:** Nix produces libraries or installable `.lgx` packages.
2. **Install:** Basecamp extracts an LGX into its application/module directories.
3. **Load:** Basecamp activates an app and loads its required modules.
4. **Start:** The Storage UI starts the Storage node using its configuration.

Nix builds dependencies automatically. Building a dependency does not install it into Basecamp, and building a sibling checkout does not make other repositories consume that checkout.

## Choose packages that match Basecamp

| Basecamp host | Storage package output |
| --- | --- |
| Local Basecamp built with `nix build` | `nix build '.#lgx'` |
| Released Basecamp AppImage/DMG | `nix build '.#lgx-portable'` |

Local/dev LGX packages retain references to `/nix/store`. Portable LGX packages bundle and relocate the runtime libraries needed for the portable host. For the testing session, use the released Basecamp **0.3.0** and **portable** LGX packages.

## Preparation for 2026-09-30

### 1. Get Basecamp 0.3.0

Use the [0.3.0 release](https://github.com/logos-co/logos-basecamp/releases/tag/0.3.0), rather than a moving latest-release link.

The inspected machine is Linux x86_64. Its asset is [LogosBasecamp-Desktop-v0.3.0-bbe5da-x86_64.AppImage](https://github.com/logos-co/logos-basecamp/releases/download/0.3.0/LogosBasecamp-Desktop-v0.3.0-bbe5da-x86_64.AppImage).

After downloading, run from the download directory:

```bash
chmod +x LogosBasecamp-Desktop-v0.3.0-bbe5da-x86_64.AppImage
./LogosBasecamp-Desktop-v0.3.0-bbe5da-x86_64.AppImage
```

### 2. Generate the temporary deployment configuration

The [deployment script](https://github.com/gmega/logos-storage-do/blob/main/scripts/gen_config.sh) downloads bootstrap records and the Mix pool, then prints the configuration. It requires `curl` and `jq` for JSON output.

```bash
mkdir -p ~/logos-testing
cd ~/logos-testing

curl -fsSL \
  https://raw.githubusercontent.com/gmega/logos-storage-do/main/scripts/gen_config.sh \
  -o gen_config.sh

bash gen_config.sh > storage-config.json
jq -e . storage-config.json
```

**Run the script without arguments.** As inspected, the script uses `$1` for both the data directory and output format. Passing a custom directory breaks format selection. With no arguments, the output is JSON and the data directory is `./logos-storage-data`.

Before applying the JSON, change `data-dir` to an absolute directory such as `/home/mc2/logos-testing/storage-data`. This makes the location independent of Basecamp's working directory. The generated config enables Mix, sets the TCP listen port to `8080`, and includes the temporary deployment's bootstrap and Mix information. Preserve those deployment values.

### 3. Build the testing UI branch

The requested branch is [feat/lgx-files](https://github.com/logos-co/logos-storage-ui/tree/feat/lgx-files).

```bash
cd /home/mc2/code/logos-co/logos-storage-ui
git status --short --branch
git fetch origin
git switch --track origin/feat/lgx-files

nix build '.#lgx-portable' -L -o result-lgx-portable
ls -l result-lgx-portable/
```

If the local branch already exists, use `git switch feat/lgx-files` instead. Preserve any local work before switching branches.

Keep the branch's `flake.lock` for this session. At inspection time, it selected:

| Component           | Revision/version                                             |
| ------------------- | ------------------------------------------------------------ |
| Storage UI metadata | `2.1.4`                                                      |
| Storage Module      | `2.1.3`, revision `60f224214b1648c411c3259fbfeba055fb7d55fe` |
| libstorage (`logos-storage-nim`) | `05926ede792097b68606e772389c388bff56183b`, tag `v0.5.0-rc1` |

These components have independent version numbers: Basecamp 0.3.0, UI 2.1.4, module 2.1.3, and libstorage from `logos-storage-nim` tag `v0.5.0-rc1`. Basecamp shows the module package version, so 2.1.3 is expected when installing this module LGX.

No local dependency overrides are needed for the session build.

### 4. Install the packages and load Storage

Use Basecamp's local LGX installation flow. The 0.3.0 specification describes **Modules → Install LGX Package**, followed by selecting the `.lgx` file.

Storage UI declares a dependency on `storage_module`. Ensure the required Storage module is installed as well; installing the UI package alone does not replace the module package. If the matching module is not already available, build the exact revision recorded above:

```bash
nix build \
  'github:logos-co/logos-storage-module/60f224214b1648c411c3259fbfeba055fb7d55fe#lgx-portable' \
  -L -o result-storage-module-portable
```

Install the module LGX from `result-storage-module-portable/`, then the UI LGX from `result-lgx-portable/`. If the testing branch's lock changes, use its selected module revision instead of the dated revision above.

Open Storage from Basecamp. Loading the UI loads its required module dependencies. Rebuilding a package later requires reinstalling it to update the copy Basecamp uses.

### 5. Apply the configuration and smoke-test

For a fresh setup, choose **Advanced** onboarding and paste the contents of `storage-config.json`.

For an existing setup, the testing branch documents **Ctrl+D** as the debug panel shortcut, with access to the configuration JSON and onboarding reset. The active config is `${HOME}/.logos_storage/config.json`; back it up before replacing it. Restart the Storage node after changing the configuration.

The documented Linux preferences files are:

- Basecamp: `~/.config/Logos/LogosBasecamp.conf`
- Standalone UI: `~/.config/Logos/LogosStandalone.conf`

These preferences preserve onboarding state. They are separate from the active Storage JSON configuration. Repeating onboarding can overwrite onboarding-related config values.

Before the session:

- Confirm that Storage reaches **Running** and connects to peers.
- Upload a small file and record its CID.
- Fetch a peer's CID and download the file.
- Stop and start the node once to check that the configuration still works.

## Local development workflow

Use this workflow when developing with a locally built Basecamp. These examples produce **local/dev LGX packages** with `'.#lgx'`. The testing-session instructions above use the released Basecamp and `'.#lgx-portable'`, without overrides.

The output target and dependency overrides do different jobs:

- `nix build` builds the repository's default output. For the Storage repositories, that is the library/plugin output, not an installable LGX.
- `nix build '.#lgx'` produces the package to install into local Basecamp.
- `--override-input` changes the dependency source used by either build.

### 1. Build and run local Basecamp

```bash
cd /home/mc2/code/logos-co/logos-basecamp
nix build -L
./result/bin/LogosBasecamp
```

This runs the Basecamp source revision currently checked out. Storage packages are installed separately through Basecamp.

### 2. Build Storage Module LGX

Choose one of the following alternatives. Both build the module source in the current checkout; they differ in which revision of `logos-storage-nim` they use to build `libstorage`.

**Without overrides: build `libstorage` from the module checkout's pinned `logos-storage-nim` revision.**

```bash
cd /home/mc2/code/logos-co/logos-storage-module
nix build '.#lgx' -L -o result-lgx
```

**With an override: build `libstorage` from the committed local `logos-storage-nim` checkout.**

```bash
cd /home/mc2/code/logos-co/logos-storage-module
nix build '.#lgx' -L -o result-lgx \
  --override-input logos-storage \
  'git+file:///home/mc2/code/logos-storage/logos-storage-nim?submodules=1'
```

The module package is in `/home/mc2/code/logos-co/logos-storage-module/result-lgx/`.

### 3. Build Storage UI LGX

Choose the dependency selection that matches the module you intend to install.

**Without overrides: use the UI checkout's pinned module and its pinned `libstorage` source.**

```bash
cd /home/mc2/code/logos-co/logos-storage-ui
nix build '.#lgx' -L -o result-lgx
```

This does not consume the adjacent module checkout or its `result-lgx`. The module revision in the UI's lock file may differ from that checkout; use matching module sources when preparing the installed pair.

**With a module override: use the committed local module and its pinned `libstorage` source.**

This is the historical multi-repository workflow from the shell history:

```bash
cd /home/mc2/code/logos-co/logos-storage-ui
nix build '.#lgx' -L -o result-lgx \
  --override-input storage_module \
  'git+file:///home/mc2/code/logos-co/logos-storage-module'
```

**With both overrides: use the committed local module and build `libstorage` from the committed local `logos-storage-nim` checkout.**

Use this together with the module build in step 2 that overrides `logos-storage`, so both builds select the same `logos-storage-nim` revision for `libstorage`.

```bash
cd /home/mc2/code/logos-co/logos-storage-ui
nix build '.#lgx' -L -o result-lgx \
  --override-input storage_module \
  'git+file:///home/mc2/code/logos-co/logos-storage-module' \
  --override-input storage_module/logos-storage \
  'git+file:///home/mc2/code/logos-storage/logos-storage-nim?submodules=1'
```

The UI package is in `/home/mc2/code/logos-co/logos-storage-ui/result-lgx/`. Overriding an input in one command does not automatically apply that override to later builds in another repository.

### 4. Install the local LGX packages into local Basecamp

In the locally built Basecamp, use **Install Local Package** to install:

1. The module `.lgx` from `logos-storage-module/result-lgx/`.
2. The UI `.lgx` from `logos-storage-ui/result-lgx/`.

Open Storage, apply the desired configuration, and start the node. Loading the UI activates its required module dependencies; starting the node is a separate Storage action.

After changing and rebuilding a package, reinstall its LGX so Basecamp uses the new artifact. A Nix rebuild alone does not update Basecamp's installed copy. When changing the module API, rebuild the UI against that module as well.

### 5. Test uncommitted dependency changes

Use `path:` overrides when you explicitly want working-tree contents. For example, to build UI against an edited local module:

```bash
cd /home/mc2/code/logos-co/logos-storage-ui
nix build '.#lgx' -L -o result-lgx \
  --override-input storage_module \
  path:/home/mc2/code/logos-co/logos-storage-module
```

The examples above use `git+file:` for committed dependency sources and CI-like source selection. `submodules=1` includes the Nim repository's submodules. Do not rely on those Git URLs to capture uncommitted dependency edits.

### 6. Update persistent dependency pins

The dependency graph is controlled by `flake.nix` and `flake.lock`, not by adjacent directory names. To make a lasting dependency update, first make the intended revision available through the configured input URL/ref, then update the consuming lock:

```bash
cd /home/mc2/code/logos-co/logos-storage-module
nix flake update logos-storage

# Once the desired module revision is available upstream:
cd /home/mc2/code/logos-co/logos-storage-ui
nix flake update storage_module
```

Review the lock changes, build the packages, and include the intended lock update in the corresponding repository's change. A lock update follows the configured input ref; it does not automatically select a local sibling branch.

## Standalone UI and other development commands

To run the Storage UI without Basecamp:

```bash
cd /home/mc2/code/logos-co/logos-storage-ui
nix run
```

The same dependency overrides can be added to `nix run` when testing local module or `libstorage` changes.

The testing branch also documents QML iteration through:

```bash
cd /home/mc2/code/logos-co/logos-storage-ui
nix build '.#ui-dev'
./result/bin/run-logos-standalone-ui
```

Start this runner from the UI repository root so it finds `src/qml`. Use `nix develop` in the relevant repository to enter its development shell.

Each build normally updates the `result` symlink. The LGX examples use `-o result-lgx` to keep package outputs separate from default build outputs. For development against a released Basecamp AppImage/DMG, replace `'.#lgx'` with `'.#lgx-portable'` for **both** Storage packages and use a separate output name such as `result-lgx-portable`.

## Verification and historical context

The saved UI context recommends building the ordinary output and the LGX output; `nix flake check` alone was not sufficient evidence that the plugin artifacts built. For the released Basecamp testing session, verify the portable output and the installed app as well.

Historical context is stored under:

```text
/home/mc2/code/idbox-repos/opencode/transcripts/code/logos-co/logos-basecamp/current.md
/home/mc2/code/idbox-repos/opencode/transcripts/code/logos-co/logos-storage-ui/current.md
/home/mc2/code/idbox-repos/opencode/transcripts/code/logos-storage/logos-storage-nim/current.md
```

No separate `logos-storage-module` context folder was found in the inspected transcript tree. Module workflow details were recorded in the UI and Basecamp context.

The June context's lifecycle/API details are historical. The September testing branch has changed again; use its source for `init`, `start`, `stop`, and `destroy` behavior rather than copying the old sequence into new code.

## Sources

- [Basecamp 0.3.0 release](https://github.com/logos-co/logos-basecamp/releases/tag/0.3.0)
- [Basecamp 0.3.0 README](https://github.com/logos-co/logos-basecamp/blob/0.3.0/README.md)
- [Basecamp 0.3.0 specification: installation and loading](https://github.com/logos-co/logos-basecamp/blob/0.3.0/docs/spec.md)
- [Temporary deployment config generator](https://github.com/gmega/logos-storage-do/blob/main/scripts/gen_config.sh)
- [Testing UI branch README](https://github.com/logos-co/logos-storage-ui/blob/feat/lgx-files/README.md)
- [Testing UI branch lock file](https://github.com/logos-co/logos-storage-ui/blob/feat/lgx-files/flake.lock)
- [Storage Module build instructions](https://github.com/logos-co/logos-storage-module/blob/60f224214b1648c411c3259fbfeba055fb7d55fe/README.md)
