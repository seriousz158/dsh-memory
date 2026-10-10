# DSH compatibility matrix

`dsh-memory` is a Cordis plugin for DeepSeek Harness. The host and UI packages
declare a runtime peer range; this document records what is actually verified
by the repository's test and integration work.

## Runtime peer range

| Component | Declared range | Verified |
| --- | --- | --- |
| `@deepseek-ai/dsh-*` (host plugin peers) | `^0.1.0-rc.6 \|\| 0.1.5-rc.1 \|\| 0.1.7-rc.1 \|\| >=0.2.0-rc.2 <0.3.0` | rc.6, rc.7, 0.1.5-rc.1, 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-*` (UI peers) | same range | rc.7, 0.2.0-rc.2 |

DSH 0.2 evaluates plugin peers with prereleases included, so the 0.2 range
admits later 0.2 release candidates and 0.2.x releases without a new pin.

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
| `dsh-memory-sync` | `DSH_BIN`, PATH `dsh`, then the desktop app's bundled CLI | Honors the desktop profile's `memory.enabled` |
| `dsh-memory-backup` | none (pure Git) | `git bundle` export/import |
| `dsh-memory-migrate` | none (pure Node) | Front matter migration |

## DSH desktop 0.2.0-rc.2

Verified by `test:desktop-compat` against the real 0.2.0-rc.2 dependency graph
(`DSH_DESKTOP_NODE_MODULES`; CI installs it with
`tools/install-dsh-contract-deps.mjs 0.2.0-rc.2`):

- the app's own `evaluatePluginCompatibility` accepts all three manifests;
- `Config` is exported and `memory.enabled` is a volatile field, so
  `SettingsForms` projects it and edits apply live via `loader/volatile-update`;
  writes go to `SettingsForms.update(<profile entry id>, patch)`. Without any
  settings backend a write fails with `settings-unavailable` instead of
  reporting success;
- the memory prompt section is registered with `interpolate: false` (and its
  untrusted summary has `{{`/`}}` broken up for hosts that always interpolate),
  so summary text can neither break prompt rendering nor be template-expanded;
- the host contract suite (settings backends, refresh ordering, tool gating)
  passes on 0.2's cordis, tools and typert packages.

Session logs: the synchronizer selects the highest `session.v<N>.jsonl[.zstd]`
generation per session directory (generation 0 is `session.jsonl`). A pending,
incomplete delivery of an older generation next to a newer one fails closed with
`session-generation-changed` (exit 78), as the V2→V3 rule below did.

## DSH 0.1.5-rc.1 and 0.1.7-rc.1

The desktop preview `0.1.7-rc.1` is verified with the Host and client entry points. The desktop profile must use the matching built packages; stale `0.5.0` links are not compatible.

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
