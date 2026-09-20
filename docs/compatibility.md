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

## DSH 0.1.5-rc.1

The tested RC is explicitly included in peer ranges. Namespace strings are
validated by the Host, without importing the removed `settingsNamespace` helper.
The marketplace aggregate is rebuilt from the same Host source.

Memory sync prefers `session.v3.jsonl.zstd` to a retained V2 generation, including
when the V3 log is too recent to process. A pending, incomplete V2 delivery next
to V3 fails closed with `session-generation-changed` (exit 78). Its chunk cursor
and watermark are retained: do not copy the cursor to V3 or delete pending state
without reconciling the already-delivered transcript. Completed V2 entries do not
block processing the new generation.

`npm test` retains the legacy dependency suite. `test:runtime-imports` can target
an independently installed runtime using `DSH_RUNTIME_NODE_MODULES`, with optional
`DSH_EXPECTED_VERSION` enforcing the requested version. CI also runs these import
contracts against current DSH dependencies. These checks do not run paid models.

The unused `dsh-client-runtime` bootstrap dependency was removed: the package
was retired before 0.1.5. The UI consumes the Host-provided slots/remote services,
not that legacy module. Current CI pins the transitive DSH peer graph to rc.1
instead of accidentally combining rc.1 and rc.2.
