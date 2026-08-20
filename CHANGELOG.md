# Changelog

All notable changes to this project are documented here.

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
