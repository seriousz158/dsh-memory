# API contract

`dsh-memory` exposes a local Typert remote namespace named `memory`.

The browser UI can call only this namespace. It cannot supply a memory path, execute Git, or request arbitrary filesystem operations.

## Setting

```text
memory.enabled: boolean
```

Default: `true`.

When the setting is changed, the host updates its memory system-prompt section immediately; the next model call observes the new state without restarting DSH.

## Methods

### `memory.getSettings()`

Success:

```json
{ "ok": true, "value": { "enabled": true } }
```

Failure:

```json
{ "ok": false, "error": { "code": "settings-unavailable" } }
```

### `memory.setEnabled({ enabled })`

Input:

```json
{ "enabled": false }
```

Success:

```json
{ "ok": true, "value": { "enabled": false } }
```

Failures use `settings-invalid-request`, `settings-unavailable`, or `settings-write-failed`.

### `memory.status()`

Success:

```json
{
  "ok": true,
  "value": {
    "empty": false,
    "dataFileCount": 6,
    "targetDirty": false,
    "recoverable": true
  }
}
```

This method reports metadata only. It never returns a memory document, Git diff, transcript, or credential.

Failures use `repo-unavailable` or `unsafe-layout`.

### `memory.clear({ confirmation })`

The only accepted confirmation is the exact machine value:

```json
{ "confirmation": "DELETE_MEMORY" }
```

Success when data was cleared:

```json
{
  "ok": true,
  "value": {
    "alreadyEmpty": false,
    "clearedFileCount": 6,
    "recoveryCommit": "<git commit id>",
    "clearCommit": "<git commit id>"
  }
}
```

Success for an already empty repository uses `alreadyEmpty: true`, `clearedFileCount: 0`, and `null` commit values.

For a nonempty repository, `recoveryCommit` is always the recovery point that
parents `clearCommit`. When the target memory paths are clean, it is the
existing pre-clear `HEAD` and no redundant checkpoint commit is created. When
target memory paths are dirty, it is a dedicated checkpoint commit containing
their live pre-clear contents.

Failures use stable codes:

| Code | Meaning |
| --- | --- |
| `repo-unavailable` | the configured memory root is not an accessible Git repository |
| `unsafe-layout` | the root or target layout includes an unsafe path/symbolic link |
| `checkpoint-failed` | the recovery checkpoint could not be built |
| `clear-failed` | clear staging or confirmation failed safely |
| `commit-failed` | live index/head update could not be completed safely |

The user interface shows a human-readable two-step confirmation before it sends the machine confirmation above.

### `memory.status()` (v0.2)

The response adds schema and journal observability:

```json
{
  "ok": true,
  "value": {
    "empty": false,
    "dataFileCount": 6,
    "targetDirty": false,
    "recoverable": true,
    "schemaVersion": 1,
    "legacyFileCount": 2,
    "pendingMigration": true,
    "lastRun": {
      "runId": "20260819T120000Z-a1b2c3d4",
      "status": "applied",
      "changedFileCount": 2,
      "applyCommit": "550010e76d7e5c6995a1e15f7e439873586dff40"
    }
  }
}
```

`schemaVersion` is the front matter schema version. `legacyFileCount` counts
payload records (handbook/, rollouts/, archive/) without front matter;
`summary.md` is a navigation file and never counts as legacy. `pendingMigration`
is true when at least one legacy record exists. `lastRun` is null before the
first journaled run and otherwise reflects `.sync/last-run.json`.

### `memory.runs({ limit })`

Lists recent journaled runs (newest first, default limit 20):

```json
{
  "ok": true,
  "value": {
    "runs": [
      {
        "schema_version": 1,
        "run_id": "20260819T120000Z-a1b2c3d4",
        "operation": "sync",
        "status": "applied",
        "changed_paths": ["handbook/preferences.md"],
        "recovery_commit": "...",
        "apply_commit": "..."
      }
    ]
  }
}
```

For a `sync` run, `candidate_sessions`, `processed_sessions`, and
`skipped_sessions` are host-lifecycle counts, not values inferred from a model
report: candidates passed the watermark and one-hour-idle guards; processed
candidates were successfully submitted to headless DSH; skipped candidates were
withheld by the host before submission. On the current successful incremental
path, every candidate is submitted, so `processed_sessions` equals
`candidate_sessions` and `skipped_sessions` is `0`. A model's per-session
`NO_SIGNAL` judgment is intentionally not parsed from natural-language output.

### `memory.rollback({ runId, confirmation })`

Rolls back a whole journaled run by creating a new rollback commit. The only
accepted confirmation is the exact machine value `"ROLLBACK_MEMORY"`.

Preconditions:

- the run exists and its status is `applied`;
- the run's apply commit is still the latest payload write (journal commits
  after it are fine);
- the repository layout is safe.

Failures use stable codes:

| Code | Meaning |
| --- | --- |
| `rollback-invalid-confirmation` | the confirmation value is wrong |
| `rollback-run-not-found` | no such journaled run |
| `rollback-not-applicable` | the run is not applied or cannot be rolled back |
| `rollback-conflict` | newer memory writes happened after the apply commit |
| `rollback-failed` | the rollback commit could not be completed safely |

The rollback commit restores the payload to the run's recovery commit tree,
preserves `.sync` and `.last-sync`, and records the rollback itself in the
journal. It never uses `reset`, force update, or history deletion.
