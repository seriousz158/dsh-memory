# Release checklist

Run this checklist from the repository root before creating or updating any
GitHub release, tag, or pull request.

## 1. Confirm the release boundary

- Review `git status --short --branch` and account for every change.
- Confirm that memory stores, sessions, browser state, dependency trees, logs,
  compressed archives, and local credential files are not tracked.
- Keep examples synthetic. Credential examples must use `[REDACTED]`, for
  example `Authorization: Bearer [REDACTED]`.
- Use `$HOME` in portable documentation and scripts; never publish a developer
  machine's home or source-checkout path.

## 2. Run the fail-closed publication guards

```zsh
zsh tools/secret-scan.sh
zsh tests/test_public_tree.sh
git diff --cached --check
git ls-files
```

All four commands must exit successfully. Inspect the complete `git ls-files`
output: every path must be intentional public source under the documented
allowlist.

The secret scan checks both tracked working-tree content and the Git index. The public-tree guard constructs an isolated snapshot from the Git index before reading manifests, workflows, and `npm pack` contents, so stage the intended release files before running it. Resolve every finding; do not weaken or bypass the patterns for a release.

## 3. Run clean-room tests

```zsh
npm test
```

Tests must use temporary homes and repositories. They must not start a browser,
a live DSH account, a LaunchAgent, a provider process, or a paid service.

## 4. Inspect package contents

For each packaged workspace artifact, inspect the archive before creating a
GitHub Release. The workspaces are intentionally private and must not be sent
to npm:

```zsh
npm pack --dry-run --workspace packages/dsh-memory
npm pack --dry-run --workspace packages/dsh-memory-ui
```

Confirm that each package contains only runtime source, templates, metadata,
license material, and intended documentation. It must not contain test memory,
local state, logs, credentials, caches, or generated archives.

## 5. Record release evidence

- Record the exact commit and version being released.
- Record the successful guard, test, and package-inspection commands.
- Confirm the public repository and package targets before the external action.
- If any check is skipped or cannot run, stop the release and document the
  blocker instead of treating the release as verified.
