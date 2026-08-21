# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- LaunchAgent sync now discovers a local Node runtime when launchd provides a
  minimal `PATH`, so the pinned `#!/usr/bin/env node` DSH launcher does not
  fail before headless consolidation.
- Workspace and package lock metadata now consistently records v0.7.0.
- Removed the Legacy migration card and controls from the settings UI; the
  host API and `dsh-memory-migrate` CLI remain available.

## [0.8.0] - 2026-08-21

### Added

- `memory.context({ query, limit })` returns bounded memory records with stable
  source citations and deterministic usage-aware ordering.
- Metadata-only usage feedback is stored atomically in the private
  `.sync/usage.json` sidecar (`usage_count`, `last_usage`) and never enters
  payload files or journal records.
- Existing memory repositories add the sidecar to local Git excludes without
  modifying tracked files; new repositories include it in `.sync/.gitignore`.

### Safety

- Context reads are host-owned and read-only with a 20-record limit and a
  4 KiB per-record body bound.
- Expired records are excluded, citations expose only relative payload paths
  and optional record ids, and no UI or filesystem path selector was added.

## [0.7.0] - 2026-08-21

### Added

- Browser end-to-end tests for the settings UI: the suite boots a throwaway
  DSH web profile on an ephemeral port (reusing the pinned runtime and shared
  plugin store, symlinking the local workspaces, and seeding onboarding
  settings plus an empty fixture memory repository), then drives headless
  Chromium to assert the panel across desktop/light, dark, and narrow
  viewports, plus empty-state hiding of the Legacy and preview sections and
  the enable switch.
- The E2E suite runs as part of `npm test` and skips cleanly when the Python
  Playwright browser-acceptance tooling is unavailable.

## [0.6.0] - 2026-08-20

### Added

- `memory.legacyRecords()` exposes metadata-only legacy-record discovery to
  the host and settings UI.
- `memory.migrateLegacy({ dryRun })` moves the existing CLI migration logic
  into the library and applies front matter through the normal staged,
  host-owned recovery/apply transaction.
- `dsh-memory-migrate --dry-run|--apply` now delegates to the library API.
- Settings UI now shows pending legacy paths and deterministic generated ids,
  and offers an explicit migration action.

### Safety

- Dry-run does not write the live repository, journal, watermark, or Git.
- Migration preserves legacy record bodies and stores metadata only in the
  journal; no transcript, prompt, credential, or memory body is exposed.
- Applying migration is idempotent and uses the existing operation lock.

## [0.5.0] - 2026-08-20

### Added

- `dsh-memory-backup export <bundle>`: self-contained Git bundle of the full
  memory history plus a manifest sidecar (head, commit count, payload file
  list, size). The live store is never modified.
- `dsh-memory-backup import <bundle> [--target <root>]`: restores a bundle
  into a new directory as a complete Git worktree (recovery/apply/journal/
  rollback history preserved). Refuses an existing target; `--dry-run`
  verifies without writing.
- `docs/compatibility.md`: DSH runtime matrix (rc.6 declared peer, rc.7
  verified baseline), operating-system scope (macOS supported, Linux
  expected, Windows unsupported), and integration tool defaults.
- Release checklist now verifies the backup round-trip before release.

### Compatibility

- DSH `0.1.0-rc.6` remains within the declared peer range.
- DSH `0.1.0-rc.7` is the reproducible clean-room and locally integrated
  baseline.

### Safety

- Backup export never touches the live store; import never overwrites an
  existing repository and verifies the bundle before writing.
- The backup manifest contains metadata only (head, counts, file list) —
  no transcripts, prompts, or credentials.

## [0.4.0] - 2026-08-20

### Added

- Namespaced record ids: a single `/` separator (`project/codegen`,
  `user/preferences`); each segment is `[a-z0-9][a-z0-9-]*`. Enforced by both
  the JS metadata parser and the Python staging validator.
- Optional provenance front matter fields: `source_hash`, `created_by`,
  `review_after`, `expires_at`. Absent fields parse as `null` and render
  canonically; invalid values fail closed.
- Lazy expiry projection: a record with `expires_at` in the past is excluded
  from `search()` and from deterministic conflict resolution without
  rewriting its front matter.
- Deterministic conflict resolution: records sharing a topic key
  (`type:namespace`) pick a winner by status precedence (active > candidate >
  conflicted > superseded > archived), then newest `updated_at`, then smallest
  id. Expired records never win.
- `memory.search({ query, limit })` local full-text search over payload
  records with front matter + body scoring and snippets.
- `memory/search` remote descriptor for the settings UI.

### Compatibility

- DSH `0.1.0-rc.6` remains within the declared peer range.
- DSH `0.1.0-rc.7` is the reproducible clean-room and locally integrated
  baseline.

### Safety

- Malformed provenance values and out-of-pattern namespaced ids fail closed in
  both parsers.
- Lazy expiry never mutates record files; a later consolidation decides how to
  archive or remove expired content.

## [0.3.1] - 2026-08-20

### Added

- `dsh-memory-sync --preview <id>` captures a candidate diff as a pending
  preview under `<root>/.sync/previews/<id>` (7-day expiry) without applying.
- `dsh-memory-sync --apply-preview <id>` applies a pending preview as a normal
  sync transaction and journals it under `operation: preview`; the preview is
  consumed on success.
- `dsh-memory-sync --discard-preview <id>` removes a pending preview.
- `dsh-memory-sync --dry-run --json` emits a single machine-parseable JSON
  report with all progress lines suppressed from stdout.
- `memory.previews()`, `memory.applyPreview()`, and `memory.discardPreview()`
  host APIs, plus settings-UI preview list with apply/discard actions.
- `prepare-preview` now seeds the preview staging from the live payload tree
  (baseline + directory skeleton + manifest), so an applied preview is a
  complete transaction.
- Helper error envelopes are recovered from non-zero helper exits (stdout JSON)
  instead of collapsing to a generic failure code.

### Compatibility

- DSH `0.1.0-rc.6` remains within the declared peer range.
- DSH `0.1.0-rc.7` is the reproducible clean-room and locally integrated
  baseline.

### Safety

- A preview apply acquires the operation lock, so it cannot race a normal sync.
- Applying a preview never touches the watermark (`.last-sync`); a later normal
  sync still sees the sessions that produced the preview.
- Expired previews are never listed and cannot be applied.

## [0.3.0] - 2026-08-20

### Added

- Host-side operation lock (`<root>/.sync/operation.lock`) that serializes sync
  and rollback operations; stale locks from dead processes are recovered by
  pid/mtime checks.
- Active-run tracking (`<root>/.sync/active-run.json`) with phase progression
  (staging/validating/applying/finalizing/complete); an interrupted run left by
  a dead process is recovered into the journal on the next sync.
- `memory.health()` reporting lock, active-run, interrupted-run, journal
  readability, and a `needsManualRecovery` flag; `memory.runs()` now accepts
  `operation` and `status` filters; `memory.status()` reports the newest
  pending preview.
- Hard staging limits enforced before apply: 1 MiB per file, 50 added files,
  5 MiB total change bytes, with stable rejection codes.
- Failed applies are journaled (`status: failed`, `error_code`) so attempted
  runs are auditable.
- `.sync` directory created by the initializer with a `.gitignore` covering
  `operation.lock`, `active-run.json`, and `previews/`.

### Compatibility

- DSH `0.1.0-rc.6` remains within the declared peer range.
- DSH `0.1.0-rc.7` is the reproducible clean-room and locally integrated
  baseline.
- DSH `rc.8` and later releases are not verified by this release.

### Safety

- The operation lock and active-run record are host-side coordination state,
  never committed into the memory payload; `.sync/.gitignore` keeps them out of
  journal commits.
- Dry-run remains read-only: it never touches the lock, the journal, Git, or
  the watermark.

## [0.2.0] - 2026-08-20

### Added

- Transactional idle-session synchronization through an isolated staging
  repository and host-owned recovery/apply commits.
- Metadata-only sync journals, `memory.runs()`, `memory.rollback()`, and
  recent-run status reporting.
- Structured Markdown front matter with incremental legacy-file migration and
  a dry-run preview that does not modify the live memory repository.
- Settings UI support for inspecting the latest sync and rolling back the
  latest journaled apply.

### Compatibility

- DSH `0.1.0-rc.6` remains within the declared peer range.
- DSH `0.1.0-rc.7` is the reproducible clean-room and locally integrated
  baseline.
- DSH `rc.8` and later releases are not verified by this release.

### Safety

- Existing legacy memory files remain readable without a forced migration.
- Rollback creates a new Git commit and never resets or rewrites history.
- Sync journals contain metadata only; transcripts, prompts, and credentials
  are not persisted by the journal.

## [0.1.0] - 2026-08-19

### Added

- `dsh-memory` host plugin with an immediately registered `memory.enabled` setting.
- `dsh-memory-ui` settings row with repository status, a persisted toggle, and a two-step clear confirmation.
- Git-backed, recovery-commit-based memory clearing with symbolic-link and layout protections.
- Portable local installer that creates a missing private Git memory root, optional idle-session synchronizer, transcript redaction, release guard scripts, and GitHub Actions CI.
- Release guards that inspect the Git index snapshot, reject non-text source candidates, and cover classic and fine-grained GitHub token shapes.

### Compatibility

- DSH runtime peer range `^0.1.0-rc.6`, Node.js 22, and Python 3.11.
- The clean-room development test graph uses DSH client packages
  `0.1.0-rc.7`; npm cannot resolve the registry's `rc.6` transitive peer graph
  with plain `npm ci`.

### Not included

- npm registry publication.
- Remote memory hosting or telemetry.
- A guarantee of privacy erasure from local Git history.
