# dsh-memory

`dsh-memory` is a local, Git-backed long-term-memory plugin for [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh).

It adds one persistent setting, a safe settings-page workflow for clearing memories, and an optional idle-session synchronizer. The host plugin injects memory guidance only when `memory.enabled` is true; the UI plugin lets a user inspect the repository state, toggle the setting, and clear learned memory through a deliberate two-step confirmation.

## What it does

- Stores durable memory in a local Git repository, not in this source repository or a hosted service.
- Registers the `memory` settings namespace immediately, so `memory.enabled` takes effect for the next model call without restarting DSH.
- Shows a long-term-memory row in DSH settings with repository status and a double-confirmation **Delete memory** action.
- Preserves a Git recovery point before clearing `summary.md`, `handbook/`, `rollouts/`, and `archive/`: a clean repository reuses its existing HEAD, while dirty target paths get a dedicated checkpoint commit; the next commit records the cleared state.
- Refuses unsafe repository layouts, symbolic-link escapes, non-repository roots, and path races during a clear operation.
- Can process only idle local session logs through an optional headless synchronizer. The synchronizer defaults to `workspace-write`, never silently installs DSH, and forwards only an allowlisted environment.

## v0.2: transactional sync, audit, structured memory, and rollback

> Historical: v0.2 introduced transactional sync. v0.3 (below) adds run
> serialization, health reporting, and interrupted-run recovery on top of it.

v0.2 makes every automatic write transactional:

- The synchronizer copies the payload tree into an isolated staging worktree;
  headless DSH only ever sees and writes that staging copy.
- The host verifies the staged diff (paths, read-only reference, live-root
  concurrency) and applies it to the live memory repository with its own
  `recovery` + `apply` commit pair. The model never runs Git.
- Every run is journaled under `.sync/runs/<run-id>.json` with `last-run.json`
  as the current status; the journal holds metadata only, never transcripts,
  prompts, or credentials. `.last-sync` advances only after a successful apply.
- New memory records use Markdown front matter (`schema_version: 1`, `id`,
  `type`, `status`, `confidence`, dates, tags, `source_rollouts`). Legacy files
  without front matter keep working, are counted by `status()`, and can be
  migrated incrementally with `dsh-memory-migrate --dry-run` / `--apply`.
- The latest journaled sync run can be rolled back as a whole through
  `memory.rollback()` (with the `ROLLBACK_MEMORY` confirmation) or the settings
  UI. Rollback creates a new commit; it never resets or rewrites history.
- `memory.status()` now reports `schemaVersion`, `legacyFileCount`,
  `pendingMigration`, and `lastRun`; `memory.runs({ limit })` lists the journal.

`dsh-memory-sync --dry-run` reports the candidate diff (added/modified/deleted
paths, rejected files and reasons) without touching the live root, the journal,
Git, or the watermark.

The clear operation keeps its existing semantics: it preserves `.sync`,
`.last-sync`, `README.md`, and `scripts/`, and after a clear the journal still
exists so an operator can see what happened. Rollback after a clear reports
`rollback-conflict` because newer memory writes superseded the run.

## v0.3: serialized sync runs, health, and interrupted-run recovery

v0.3 hardens the sync pipeline against concurrent runs and crashes:

- A host-side operation lock (`<root>/.sync/operation.lock`) serializes sync and
  rollback operations. A second sync while one is running exits cleanly with
  `operation-in-progress`; stale locks from dead processes are recovered by
  mtime/pid checks.
- An active-run record (`<root>/.sync/active-run.json`) tracks the phase of the
  current run. If the host process dies mid-run, the next sync detects the dead
  pid and recovers the interrupted run into the journal (`status: interrupted`)
  before starting fresh work.
- Run journal records now carry `phase`
  (`staging`/`validating`/`applying`/`finalizing`/`complete`), `duration_ms`,
  `rejected_file_count`, `changed_path_count`, and `staging_digest`.
- `memory.health()` reports lock/active-run/interrupted-run/journal state and a
  `needsManualRecovery` flag. `memory.runs()` accepts `operation` and `status`
  filters, and `memory.status()` reports the newest pending preview.
- Staged payloads are validated against hard limits before apply: 1 MiB per
  file, 50 added files, 5 MiB total change bytes. Oversized or binary files are
  rejected with `file-too-large`, `too-many-files`, `change-too-large`, or
  `binary-file` codes instead of being applied.
- Failed applies are journaled (`status: failed`, `error_code`) so every
  attempted run is auditable, and the journal commit never records transcripts,
  prompts, or credentials.

`dsh-memory-sync --dry-run` remains read-only: it reports the candidate diff
without touching the live root, the lock, the journal, Git, or the watermark.

## v0.3.1: preview before apply

v0.3.1 lets an operator review a candidate sync before it is applied:

- `dsh-memory-sync --preview <id>` captures the candidate diff (baseline plus
  model edits) as a pending preview under `<root>/.sync/previews/<id>` with a
  7-day expiry, without applying anything.
- `dsh-memory-sync --apply-preview <id>` applies a pending preview as a normal
  sync transaction (recovery + apply commits), consumes the preview, and
  journals the run under `operation: preview`.
- `dsh-memory-sync --discard-preview <id>` removes a pending preview.
- `dsh-memory-sync --dry-run --json` emits a single machine-parseable JSON
  report (`dryRun`, `candidateSessions`, `changedPaths`, `added`, `modified`,
  `deleted`, `changedBytes`) with all progress lines suppressed from stdout.
- `memory.previews()`, `memory.applyPreview()`, and `memory.discardPreview()`
  expose the same flow to the settings UI, which shows pending previews with
  apply/discard actions.

## Compatibility

`v0.3.1` keeps the DSH `0.1.0-rc.6` peer-compatibility range and has been
tested and locally integrated with a consistently pinned `0.1.0-rc.7` graph:

| Component | Supported version |
| --- | --- |
| DSH runtime peer range | `@deepseek-ai/dsh@^0.1.0-rc.6` (rc.6 and rc.7) |
| Recommended/tested runtime | `0.1.0-rc.7` |
| Clean-room development test graph | DSH client packages `0.1.0-rc.7` |
| Node.js | 22.x |
| Python | 3.11.x |
| Git | a local executable available on `PATH` |
| Operating system | macOS is the supported/tested integration target |

The package uses DSH's Cordis loader interfaces. The `rc.7` graph is the
reproducible development and integration baseline because the registry's `rc.6`
transitive peer graph cannot be installed by plain `npm ci`; this does not
change the host/UI packages' declared `rc.6` runtime peer range. DSH `rc.8` and
later releases are unverified until they pass this repository's test suite.

## Install

Clone the repository and install its reproducible development/runtime dependencies:

```zsh
git clone https://github.com/seriousz158/dsh-memory.git
cd dsh-memory
# Use the pinned runtime that this v0.3.1 integration was tested with.
npm install --global @deepseek-ai/dsh@0.1.0-rc.7
dsh --version
npm ci --ignore-scripts
```

This is a source-and-GitHub-Release project. Both workspace packages are
intentionally marked private, so `v0.3.1` cannot be published to npm by
accident.

Install the two local packages into your DSH profile. The installer defaults to
`~/.dsh`. If you use a non-default DSH or memory path, keep the same values in
the environment that installs, starts, validates, and synchronizes DSH:

```zsh
./integrations/dsh/install.sh

# Example for a non-default DSH home and memory repository:
export DSH_HOME="$HOME/.config/dsh"
export DSH_MEMORY_ROOT="$HOME/Documents/dsh-memory-data"
./integrations/dsh/install.sh
# Start DSH from this configured environment as well.
```

The installer creates only these DSH-profile links and the two required Cordis entries:

```text
<DSH_HOME>/profiles/node_modules/dsh-memory
<DSH_HOME>/profiles/node_modules/dsh-memory-ui
```

It also initializes a missing memory root as a private local Git repository. For an existing complete memory repository, it verifies the layout and restores owner-only permissions; it does **not** delete or rewrite learned memory, session history, credentials, other plugins, or unrelated `cordis.patch.yml` entries. See [installation details](docs/installation.md) before using a custom memory root.

Restart the DSH host after installation. In DSH Settings, find **长期记忆** and leave the switch on to enable recall for the next model call.

## Storage layout

By default the host uses:

```text
<DSH_HOME>/storages/memory
```

with `DSH_HOME` defaulting to `~/.dsh`. An operator can set
`DSH_MEMORY_ROOT` to a different local absolute path. It must be present for
the installer, every DSH host launch, explicit initializer run, and optional
synchronizer run; a one-time installation assignment does not configure future
LaunchAgent jobs. The web UI cannot submit or change a filesystem path.

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

The clear operation is designed for recoverable day-to-day resets, not guaranteed privacy erasure. Before it changes any target memory path, it preserves a recovery point: for a clean repository this is the existing pre-clear HEAD, while dirty target paths are captured in a dedicated checkpoint commit. The clear commit is then created directly on that recovery point. The operation leaves `.git`, `README.md`, helper scripts, directory structure, and `.last-sync` intact so future sessions can learn again without reprocessing historical logs.

Use Git history inside the local memory repository to recover a checkpoint. For privacy-sensitive deletion requirements, remove relevant local backups and follow your organization's retention policy; Git history alone is not a secure-erasure mechanism.

## Optional idle-session sync

The optional synchronizer is separate from the settings UI:

```zsh
./integrations/dsh/dsh-memory-sync
```

It skips work when `memory.enabled` is `false`, and it skips active sessions. It needs a user-installed `dsh` executable (or an explicitly selected `DSH_BIN`), rather than invoking `npx --yes`. It defaults to `workspace-write`; wider privileges are never a repository default. The LaunchAgent template explicitly sets the default DSH and memory paths; edit both assignments before loading it when your installation is custom.

The session filter redacts common credential shapes and home-directory prefixes before a transcript reaches the memory-extraction model. This is defense in depth, not a promise that every secret format is detectable. Review [privacy and recovery](docs/privacy-and-recovery.md) before enabling unattended sync.

## Development

Run the full, local-only suite:

```zsh
npm ci --ignore-scripts
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
