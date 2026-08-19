# Privacy and recovery

## Local storage only

`dsh-memory` stores memory in a local Git repository. This code repository contains no automatically uploaded memory content, session archives, credential stores, or browser profiles.

The optional synchronizer reads local DSH session logs only to construct a compact transcript for the model that performs extraction. It avoids active sessions and uses `.last-sync` as an incremental watermark.

## Redaction and least privilege

Before handing a transcript to a model, the filter removes common bearer, `sk-`, classic GitHub and `github_pat_` token, AWS-like, query-parameter, and home-directory patterns. It also truncates fields. These controls reduce accidental disclosure, but they are heuristic: do not place secrets in ordinary conversations and do not assume a redactor recognizes every proprietary format.

The initializer re-executes itself with a rebuilt, minimal environment. It
keeps only `HOME`, `PATH`, `TMPDIR`, `LANG`, standard `LC_*` locale values, and
the explicitly selected `DSH_HOME`/`DSH_MEMORY_ROOT`; it does not forward
provider credential values. The final DSH sync child also starts from a rebuilt
environment, defaults to `workspace-write`, does not silently download a CLI,
and requires explicit selection of any provider credential variable.

The initializer keeps the memory root owner-only and re-applies private modes to a validated existing root. It refuses an incomplete Git repository instead of treating it as usable memory storage.

## Clear versus secure erase

The settings-page clear action is a recoverable reset:

1. Snapshot the target memory files into a recovery commit.
2. Commit the empty memory state.
3. Leave the repository, README, scripts, structure, and `.last-sync` available for new learning.

This means a normal clear is **not** a claim of privacy erasure. A local Git clone, backup, reflog, remote mirror, or disk snapshot may retain earlier content. For privacy-sensitive deletion, follow your organization's data-retention process and securely remove all relevant copies.

## What must never be committed here

- `.dsh/storages/memory/`
- `.dsh/sessions/`
- `.dsh/.credentials.yaml`
- `.dsh/.anonymous-user-id`
- `node_modules/`, browser profiles, Playwright recordings, logs, and Python cache files
- Any unredacted transcript, prompt, authentication value, API key, access token, or local absolute user path
