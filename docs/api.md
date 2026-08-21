# API contract

`dsh-memory` exposes a local Typert remote namespace named `memory`.

The browser UI can call only this namespace. It cannot supply a memory path, execute Git, or request arbitrary filesystem operations.

## Setting

```text
memory.enabled: boolean
```

Default: `true`.

When the setting is changed, the host updates its memory system-prompt section immediately; the next model call observes the new state without restarting DSH.
When enabled, that section also contains a bounded (16 KiB) `summary.md`
snapshot marked as `[DPSK MEMORY: UNTRUSTED CONTEXT]`; unreadable summaries
fall back to the static instructions.

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

### `memory.legacyRecords()` (v0.6)

Returns metadata-only descriptions of legacy Markdown records under
`handbook/`, `rollouts/`, and `archive/`. Files that already have valid front
matter are not returned. The response never includes the record body:

```json
{
  "ok": true,
  "value": {
    "count": 1,
    "pendingMigration": true,
    "records": [
      {
        "path": "handbook/old-note.md",
        "id": "legacy-4f2b7c1a9e0d3c55",
        "frontMatter": "---\nschema_version: 1\nid: legacy-4f2b7c1a9e0d3c55\ncreated_at: 2026-08-20\nupdated_at: 2026-08-20\n---\n\n",
        "createdAt": "2026-08-20",
        "updatedAt": "2026-08-20",
        "bytes": 128
      }
    ]
  }
}
```

Failures use `repo-unavailable`, `unsafe-layout`, or a migration-specific
filesystem error code.

### `memory.migrateLegacy({ dryRun })` (v0.6)

`dryRun` is required and must be a boolean. `true` returns the pending records
and planned paths without changing the worktree, journal, watermark, or Git:

```json
{
  "ok": true,
  "value": {
    "dryRun": true,
    "status": "pending",
    "legacyCount": 1,
    "migratedCount": 0,
    "changedPaths": ["handbook/old-note.md"],
    "recoveryCommit": null,
    "applyCommit": null,
    "journalCommit": null
  }
}
```

`{ "dryRun": false }` applies deterministic front matter through the same
staging, validation, operation-lock, recovery/apply-commit, and metadata-only
journal path used by host-owned sync. The original Markdown body is preserved.
Applying again returns `status: "no_change"` with no new payload commit.

Failures use `migration-invalid-request`, `repo-unavailable`, `unsafe-layout`,
`operation-in-progress`, `interrupted-run`, or a stable `migration-*` error
code. If an older process left an active run, the host journals it as
`status: "interrupted"` and stops; the operator must inspect `health()` and
recover the repository explicitly before applying another migration.

### `memory.status()` (v0.3)

The response adds a pending-preview field:

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
    "lastRun": { "runId": "...", "status": "applied" },
    "pendingPreview": null
  }
}
```

`pendingPreview` is the newest non-expired preview under `.sync/previews/`, or
`null` when none exists. Previews expire after a host-defined TTL and are
cleaned lazily; an expired preview is never reported as pending.

### `memory.health()`

Read-only repository health summary used by the settings UI:

```json
{
  "ok": true,
  "value": {
    "memoryRoot": "$DSH_HOME/storages/memory",
    "rootSafe": true,
    "gitAvailable": true,
    "dataFileCount": 6,
    "payloadDirty": false,
    "operationLock": {
      "operation": "sync",
      "pid": 12345,
      "runId": "20260820T100000Z-a1b2c3d4",
      "startedAt": "2026-08-20T10:00:00Z",
      "active": false
    },
    "activeRun": {
      "run_id": "20260820T100000Z-a1b2c3d4",
      "operation": "sync",
      "status": "running",
      "phase": "applying",
      "pid": 12345,
      "started_at": "2026-08-20T10:00:00Z",
      "state": "running"
    },
    "interruptedRun": null,
    "pendingPreview": null,
    "pendingPreviewCount": 0,
    "journalReadable": true,
    "needsManualRecovery": false
  }
}
```

`operationLock` is the current `.sync/operation.lock` state (null when no lock
is held). `activeRun.state` is `running` when the recorded pid is alive,
`interrupted` when the pid is gone, and `null` when no active run exists.
`interruptedRun` is the interrupted run record that should be recovered or
audited. `needsManualRecovery` is true when the payload is dirty, an active run
is interrupted, an interrupted run exists in the journal, or the journal is not
readable.

Failures use `repo-unavailable` or `unsafe-layout`.

### `memory.runs({ limit, operation, status })`

Lists recent journaled runs (newest first, default limit 20). `operation` and
`status` are optional exact-match filters. Run records include the v0.3 fields
`phase` (staging/validating/applying/finalizing/complete), `duration_ms`,
`rejected_file_count`, `changed_path_count`, and `staging_digest`:

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
        "phase": "complete",
        "changed_paths": ["handbook/preferences.md"],
        "recovery_commit": "...",
        "apply_commit": "...",
        "duration_ms": 1234,
        "rejected_file_count": 0,
        "changed_path_count": 1
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

### `memory.previews()` (v0.3.1)

Lists pending (non-expired) previews, newest first:

```json
{
  "ok": true,
  "value": {
    "previews": [
      {
        "preview_id": "20260820T150000Z-a1b2c3d4",
        "created_at": "2026-08-20T15:00:00Z",
        "expires_at": "2026-08-27T15:00:00Z",
        "candidate_sessions": 1,
        "changed_paths": ["handbook/preferences.md"],
        "status": "pending"
      }
    ]
  }
}
```

Previews are created by `dsh-memory-sync --preview <id>`, which captures the
candidate diff (baseline + model edits) under `<root>/.sync/previews/<id>`
without applying anything. Expired previews are never listed and cannot be
applied.

### `memory.applyPreview({ previewId })` (v0.3.1)

Applies a pending preview's staged payload as a normal sync transaction
(recovery + apply commits), consumes the preview, and journals the run under
`operation: "preview"`:

```json
{
  "ok": true,
  "value": {
    "status": "applied",
    "previewId": "20260820T150000Z-a1b2c3d4",
    "changed_paths": ["handbook/preferences.md"],
    "recovery_commit": "...",
    "apply_commit": "...",
    "journaled": true
  }
}
```

Failures use `preview-invalid-request`, `preview-not-found`, `preview-expired`,
`live-memory-changed`, `operation-in-progress`, or `preview-apply-failed`.

### `memory.discardPreview({ previewId })` (v0.3.1)

Removes a pending preview without applying it:

```json
{ "ok": true, "value": { "removed": true, "previewId": "20260820T150000Z-a1b2c3d4" } }
```

Failures use `preview-invalid-request` or `preview-not-found`.

### `memory.search({ query, limit })` (v0.4)

Local full-text search over the payload records (`handbook/`, `rollouts/`,
`archive/`). The query is tokenized on non-letter/number boundaries; each
record is scored by front matter fields (id matches weigh most) and body
text. Expired records are excluded. Returns matches sorted by score with a
short body snippet:

```json
{
  "ok": true,
  "value": {
    "query": "codegen",
    "count": 1,
    "results": [
      {
        "path": "handbook/project.md",
        "score": 5,
        "id": "project/codegen",
        "type": "decision",
        "updated_at": "2026-08-10",
        "snippet": "We chose TypeScript for the codegen pipeline…",
        "citation": "[source: handbook/project.md · id: project/codegen]"
      }
    ]
  }
}
```

`limit` defaults to 20. Failures use `search-invalid-request`,
`repo-unavailable`, or `search-failed`.

### `memory.context({ query, limit })` (v0.8)

Host-owned read path for a bounded memory context. `query` is optional; when
omitted, records are ordered by usage feedback. When present, deterministic
full-text matches are selected first and then ordered by `usage_count`,
`last_usage`, and path. Expired records are excluded.

```json
{
  "ok": true,
  "value": {
    "query": "codegen",
    "count": 1,
    "records": [
      {
        "path": "handbook/project.md",
        "id": "project/codegen",
        "type": "decision",
        "content": "We chose TypeScript for the codegen pipeline.\n",
        "truncated": false,
        "citation": "[source: handbook/project.md · id: project/codegen]",
        "usage_count": 3,
        "last_usage": "2026-08-21T02:00:00.000Z",
        "score": 5
      }
    ]
  }
}
```

`limit` defaults to 10 and is restricted to 1–20. Each returned body is
bounded to 4 KiB. A successful context read increments metadata-only usage in
`.sync/usage.json`; the sidecar is atomically written with owner-only
permissions and is excluded from Git. It contains no memory body, transcript,
prompt, or credential. `truncated` is true when the body reached the 4 KiB
limit. Failures use `context-invalid-request`,
`usage-invalid`, `unsafe-layout`, `repo-unavailable`, or `context-failed`.

### Agent tools (v0.8.x)

The host registers two read-path tools when the `tools` service is available:

- `memory_search({ query, limit })` returns the same ranked snippets and
  citations as `memory.search()`.
- `memory_context({ query?, limit? })` returns bounded records and updates
  only the metadata-only usage sidecar used for deterministic ordering.

Both tools return a JSON string to the model. They do not expose the memory
root, Git operations, journal contents, transcripts, prompts, or credentials.

### Front matter schema (v0.4)

Record ids may be namespaced with a single `/`: `project/codegen` or
`user/preferences`. Each segment is `[a-z0-9][a-z0-9-]*`; ids without a
namespace remain valid.

Provenance fields (all optional, completed as `null` by the host when absent):

| Field | Type | Meaning |
| --- | --- | --- |
| `source_hash` | string | stable hash of the source that produced the record |
| `created_by` | string | agent or process that created the record |
| `review_after` | date | suggested review date (`YYYY-MM-DD`) |
| `expires_at` | date | validity deadline (`YYYY-MM-DD`) |

`expires_at` is a lazy projection: an expired record is excluded from
`search()` and from deterministic conflict resolution without rewriting its
front matter. The deterministic conflict key is `type` plus the id's
namespace (`fact:project`), and the winner is chosen by status precedence
(active > candidate > conflicted > superseded > archived), then newest
`updated_at`, then lexicographically smallest id. Expired records never win.
