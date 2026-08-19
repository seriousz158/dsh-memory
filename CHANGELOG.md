# Changelog

All notable changes to this project are documented here.

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
