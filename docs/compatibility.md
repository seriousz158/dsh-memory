# DSH compatibility matrix

`dsh-memory` is a Cordis plugin for DeepSeek Harness. The host and UI packages
declare a runtime peer range; this document records what is actually verified
by the repository's test and integration work.

## Runtime peer range

| Component | Declared range | Verified |
| --- | --- | --- |
| `@deepseek-ai/dsh` (host plugin peer) | `^0.1.0-rc.6` | rc.6 and rc.7 |
| `@deepseek-ai/dsh-client-*` (UI peer) | `^0.1.0-rc.6` | rc.7 |

## Verified environments

| DSH version | Node | Python | Git | Verified scope |
| --- | --- | --- | --- | --- |
| `0.1.0-rc.6` | 22.x | 3.11.x | local `git` | Plugin load (`--dump-config`), headless sync transaction, rollback, preview apply, backup export/import |
| `0.1.0-rc.7` | 22.x | 3.11.x | local `git` | Development and integration baseline; `npm test` (21 groups), UI settings row, remote methods |

## Not verified

- `rc.8` and later DSH releases: not run against this repository's test suite.
- Headless end-to-end model calls (require provider credentials; deliberately
  not exercised by tests).
- Windows and Linux: the FD-anchored helper targets macOS/POSIX semantics.
  Linux is expected to work (same POSIX syscalls) but is not CI-covered.

## Operating-system scope

| OS | Status |
| --- | --- |
| macOS | Supported and tested integration target |
| Linux | Expected to work (POSIX `O_NOFOLLOW`/`dir_fd`); not CI-covered |
| Windows | Not supported (no `dir_fd`/`O_NOFOLLOW` equivalent in the helper) |

## Integration tools

| Tool | DSH version used by default | Notes |
| --- | --- | --- |
| `dsh-memory-sync` | PATH `dsh` or `DSH_BIN` | Prefers the pinned project-local runtime when present |
| `dsh-memory-backup` | none (pure Git) | `git bundle` export/import |
| `dsh-memory-migrate` | none (pure Node) | Front matter migration |
