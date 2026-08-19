# dsh-memory

`dsh-memory` is a local, Git-backed long-term-memory plugin for [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh).

It adds one persistent setting, a safe settings-page workflow for clearing memories, and an optional idle-session synchronizer. The host plugin injects memory guidance only when `memory.enabled` is true; the UI plugin lets a user inspect the repository state, toggle the setting, and clear learned memory through a deliberate two-step confirmation.

## What it does

- Stores durable memory in a local Git repository, not in this source repository or a hosted service.
- Registers the `memory` settings namespace immediately, so `memory.enabled` takes effect for the next model call without restarting DSH.
- Shows a long-term-memory row in DSH settings with repository status and a double-confirmation **Delete memory** action.
- Creates a Git recovery checkpoint before clearing `summary.md`, `handbook/`, `rollouts/`, and `archive/`; the next commit records the cleared state.
- Refuses unsafe repository layouts, symbolic-link escapes, non-repository roots, and path races during a clear operation.
- Can process only idle local session logs through an optional headless synchronizer. The synchronizer defaults to `workspace-write`, never silently installs DSH, and forwards only an allowlisted environment.

## Compatibility

`v0.1.0` is tested against:

| Component | Supported version |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.1.0-rc.6` |
| Node.js | 22.x |
| Python | 3.11.x |
| Git | a local executable available on `PATH` |
| Operating system | macOS is the supported/tested integration target |

The package uses DSH's Cordis loader interfaces. Treat other DSH releases as unverified until they pass this repository's test suite.

## Install

Clone the repository and install its reproducible development/runtime dependencies:

```zsh
git clone https://github.com/seriousz158/dsh-memory.git
cd dsh-memory
npm ci
```

Install the two local packages into your DSH profile. The installer defaults to `~/.dsh`; use `DSH_HOME` only when your DSH installation has another home:

```zsh
./integrations/dsh/install.sh

# Example for a non-default DSH home:
DSH_HOME="$HOME/.config/dsh" ./integrations/dsh/install.sh
```

The installer creates only these DSH-profile links and the two required Cordis entries:

```text
<DSH_HOME>/profiles/node_modules/dsh-memory
<DSH_HOME>/profiles/node_modules/dsh-memory-ui
```

It does **not** delete or rewrite an existing memory repository, session history, credentials, other plugins, or unrelated `cordis.patch.yml` entries. See [installation details](docs/installation.md) before using a custom memory root.

Restart the DSH host after installation. In DSH Settings, find **长期记忆** and leave the switch on to enable recall for the next model call.

## Storage layout

By default the host uses:

```text
<DSH_HOME>/storages/memory
```

with `DSH_HOME` defaulting to `~/.dsh`. An operator can set `DSH_MEMORY_ROOT` before starting DSH to use a different local absolute path. The web UI cannot submit or change a filesystem path.

The initialized repository contains:

```text
summary.md      short, stable navigation and preferences
handbook/       reusable knowledge
rollouts/       per-session extraction results
archive/        superseded entries
scripts/        transcript filter helper
.last-sync      optional synchronizer watermark
```

## Settings and API

The only persisted setting is:

```yaml
memory:
  enabled: true
```

The local UI talks only to the fixed `memory` remote service:

```text
memory.getSettings()
memory.setEnabled({ enabled: boolean })
memory.status()
memory.clear({ confirmation: "DELETE_MEMORY" })
```

`status()` reports metadata such as `empty`, `dataFileCount`, `targetDirty`, and `recoverable`; it never returns the memory body. Full request/response contracts and stable error codes are in [docs/api.md](docs/api.md).

## Clear memory safely

The settings UI intentionally requires two acknowledgements:

1. Click **删除记忆**, read the affected paths, then click **继续**.
2. Enter exactly `删除记忆`, then click the final confirmation.

The clear operation is designed for recoverable day-to-day resets, not guaranteed privacy erasure. Before it changes any target memory path, it writes a recovery checkpoint commit. A second commit records the empty state. The operation leaves `.git`, `README.md`, helper scripts, directory structure, and `.last-sync` intact so future sessions can learn again without reprocessing historical logs.

Use Git history inside the local memory repository to recover a checkpoint. For privacy-sensitive deletion requirements, remove relevant local backups and follow your organization's retention policy; Git history alone is not a secure-erasure mechanism.

## Optional idle-session sync

The optional synchronizer is separate from the settings UI:

```zsh
./integrations/dsh/dsh-memory-sync
```

It skips work when `memory.enabled` is `false`, and it skips active sessions. It needs a user-installed `dsh` executable (or an explicitly selected `DSH_BIN`), rather than invoking `npx --yes`. It defaults to `workspace-write`; wider privileges are never a repository default.

The session filter redacts common credential shapes and home-directory prefixes before a transcript reaches the memory-extraction model. This is defense in depth, not a promise that every secret format is detectable. Review [privacy and recovery](docs/privacy-and-recovery.md) before enabling unattended sync.

## Development

Run the full, local-only suite:

```zsh
npm ci
npm test
```

Tests use temporary Git repositories and synthetic fixtures. They must not require a DSH account, start Chrome, launch a LaunchAgent, read the current user's memory/session folders, or make a paid model request.

Before opening an issue or pull request, run:

```zsh
npm test
zsh tools/secret-scan.sh
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [release checklist](docs/release-checklist.md).

## Privacy promise

This repository contains code, tests, templates, and examples only. It must never contain any real DSH memory, session log, credential file, browser profile, or user-specific DSH configuration. If you believe sensitive data was committed, treat it as exposed, rotate affected credentials, and follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 seriousz158.
