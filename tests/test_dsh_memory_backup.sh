#!/bin/zsh
# v0.5: dsh-memory-backup exports the memory repository as a Git bundle and
# restores it into a new directory, preserving the full commit history.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
BACKUP="$PROJECT_DIR/integrations/dsh/dsh-memory-backup"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-backup.XXXXXX")"
MEMORY_ROOT="$TEST_ROOT/memory"
BUNDLE="$TEST_ROOT/backup.bundle"
RESTORED="$TEST_ROOT/restored"

mkdir -p "$MEMORY_ROOT/handbook" "$MEMORY_ROOT/rollouts" "$MEMORY_ROOT/archive"
printf 'base memory\n' > "$MEMORY_ROOT/summary.md"
printf 'first entry\n' > "$MEMORY_ROOT/handbook/entry.md"
git -C "$MEMORY_ROOT" init --quiet
git -C "$MEMORY_ROOT" config user.name "DSH Memory Test"
git -C "$MEMORY_ROOT" config user.email "dsh-memory-test@example.invalid"
git -C "$MEMORY_ROOT" add .
git -C "$MEMORY_ROOT" commit -q -m "initial"
printf 'second entry\n' >> "$MEMORY_ROOT/handbook/entry.md"
git -C "$MEMORY_ROOT" add .
git -C "$MEMORY_ROOT" commit -q -m "second"

# 1. Export produces a bundle and a manifest sidecar.
DSH_MEMORY_ROOT="$MEMORY_ROOT" "$BACKUP" export "$BUNDLE" >"$TEST_ROOT/export.out" 2>&1
grep -q -- "exported 2 commits" "$TEST_ROOT/export.out"
grep -q -- "head " "$TEST_ROOT/export.out"
test -f "$BUNDLE"
test -f "$BUNDLE.json"
git bundle verify "$BUNDLE" >/dev/null 2>&1
/usr/bin/python3 - "$BUNDLE.json" <<'PY'
import json
import sys
meta = json.load(open(sys.argv[1]))
assert meta["schema_version"] == 1, meta
assert meta["commit_count"] == 2, meta
assert "handbook/entry.md" in meta["payload_files"], meta
PY

# 2. Import restores the full history into a new directory.
DSH_MEMORY_ROOT="$MEMORY_ROOT" "$BACKUP" import "$BUNDLE" --target "$RESTORED" >"$TEST_ROOT/import.out" 2>&1
grep -q -- "restored to" "$TEST_ROOT/import.out"
test "$(cat "$RESTORED/handbook/entry.md")" = "first entry
second entry"
test "$(git -C "$RESTORED" log --oneline | wc -l | tr -d ' ')" = "2"
test "$(git -C "$RESTORED" branch --show-current)" = "main"
test "$(git -C "$RESTORED" status --porcelain | wc -l | tr -d ' ')" = "0"

# 3. Import refuses an existing target even with --dry-run.
set +e
DSH_MEMORY_ROOT="$MEMORY_ROOT" "$BACKUP" import "$BUNDLE" --target "$RESTORED" --dry-run >"$TEST_ROOT/exists.out" 2>&1
exists_rc=$?
set -e
test "$exists_rc" != "0"
grep -q -- "target already exists" "$TEST_ROOT/exists.out"

# 4. Usage error for a bad operation.
set +e
"$BACKUP" nonsense "$BUNDLE" >"$TEST_ROOT/usage.out" 2>&1
usage_rc=$?
set -e
test "$usage_rc" != "0"

print -- "dsh-memory backup tests passed"
