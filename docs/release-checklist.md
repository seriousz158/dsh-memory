# Release checklist

Run this checklist from the repository root before creating or updating any
GitHub release, tag, or pull request.

## 1. Confirm the release boundary

- Review `git status --short --branch` and account for every change.
- Confirm that memory stores, sessions, browser state, dependency trees, logs,
  compressed archives, and local credential files are not tracked.
- Keep examples synthetic. Credential examples must use `[REDACTED]`, for
  example `Authorization: Bearer [REDACTED]`.
- Use `$HOME` in portable documentation and scripts; never publish a developer
  machine's home or source-checkout path.

## 2. Run the fail-closed publication guards

```zsh
zsh tools/secret-scan.sh
zsh tests/test_public_tree.sh
git diff --cached --check
git ls-files
```

All four commands must exit successfully. Inspect the complete `git ls-files`
output: every path must be intentional public source under the documented
allowlist.

The secret scan checks both tracked working-tree content and the Git index. The public-tree guard constructs an isolated snapshot from the Git index before reading manifests, workflows, and `npm pack` contents, so stage the intended release files before running it. Resolve every finding; do not weaken or bypass the patterns for a release.

## 3. Run clean-room tests

```zsh
npm test
```

Tests must use temporary homes and repositories. They must not start a browser,
a live DSH account, a LaunchAgent, a provider process, or a paid service.

## 4. Inspect package contents

For each packaged workspace artifact, inspect the archive before creating a
GitHub Release. The workspaces are intentionally private and must not be sent
to npm:

```zsh
npm pack --dry-run --workspace packages/dsh-memory
npm pack --dry-run --workspace packages/dsh-memory-ui
```

Confirm that each package contains only runtime source, templates, metadata,
license material, and intended documentation. It must not contain test memory,
local state, logs, credentials, caches, or generated archives.

## 4b. Verify backup round-trip (v0.5)

Exercise the backup export/import against a temporary repository before
release:

```zsh
zsh tests/test_dsh_memory_backup.sh
```

The test exports a fixture repository to a Git bundle, restores it into a new
directory, and asserts the full commit history survives. It must not touch a
real memory store.

## 5. Record release evidence

- Record the exact commit and version being released.
- Record the successful guard, test, and package-inspection commands.
- Confirm the public repository and package targets before the external action.
- If any check is skipped or cannot run, stop the release and document the
  blocker instead of treating the release as verified.

## 6. Deployment acceptance (local DSH host)

Perform during a safe window while no memory sync is in flight. These steps
deploy the new bundle to a local DSH installation and prove it works with
zero Provider involvement before re-enabling the scheduler.

1. **Backup first.** Export a backup of the live memory root via the
   `dsh-memory-backup` flow and verify the archive restores into a temporary
   directory. Never deploy without a recovery point.
2. **Quiesce the scheduler.** Unload only the memory-sync LaunchAgent
   (label from `integrations/dsh/dsh-memory-sync.plist.example`), for example
   `launchctl bootout gui/$UID/<label>`. DSH itself keeps running; no other
   agent is touched.
3. **Restart DSH in the safe window.** Restart the local DSH service so the
   new plugin bundle loads, then confirm the settings page shows a healthy
   repository.
4. **Zero-Provider acceptance.** Run:

   ```zsh
   integrations/dsh/dsh-memory-sync --scan-only --json
   ```

   Assert `ok:true`, `scanOnly:true`, sensible `candidateSessions` and
   `candidateBytes`, correct `watermark` state, and that `.last-sync` and
   the journal are untouched afterwards. No DSH headless run, provider
   process, or paid call may be spawned by this mode.
5. **Reload the scheduler.** `launchctl bootstrap gui/$UID/<plist>` and watch
   the next scheduled run acquire the operation lock, complete, and journal a
   healthy `status`.
6. **Retrieval smoke.** Query through `memory_search` and confirm hybrid
   retrieval metadata is present (`retrieval.mode` is `hybrid` or `scan`,
   `indexState` is `fresh`/`rebuilt`/`degraded`) and results are correct.
   A persistent `degraded` state is a rollback signal.
