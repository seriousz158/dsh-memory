# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-08-19

### Added

- `dsh-memory` host plugin with an immediately registered `memory.enabled` setting.
- `dsh-memory-ui` settings row with repository status, a persisted toggle, and a two-step clear confirmation.
- Git-backed, recovery-commit-based memory clearing with symbolic-link and layout protections.
- Portable local installer, optional idle-session synchronizer, transcript redaction, release guard scripts, and GitHub Actions CI.

### Compatibility

- DSH `0.1.0-rc.6`, Node.js 22, and Python 3.11.

### Not included

- npm registry publication.
- Remote memory hosting or telemetry.
- A guarantee of privacy erasure from local Git history.
