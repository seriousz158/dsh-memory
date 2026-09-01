#!/bin/zsh
# v0.3.1: the sync wrapper can capture a candidate diff as a pending preview
# (--preview), apply a preview (--apply-preview), and discard it
# (--discard-preview). v0.8.3: --dry-run is a deprecated alias of --scan-only
# and no longer emits a diff report.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SYNC_SOURCE="$PROJECT_DIR/integrations/dsh/dsh-memory-sync"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-preview.XXXXXX")"
TEST_INTEGRATION="$TEST_ROOT/integrations/dsh"
TEST_HOME="$TEST_ROOT/home"
TEST_DSH_HOME="$TEST_ROOT/dsh-home"
TEST_MEMORY_ROOT="$TEST_ROOT/memory"
TEST_BIN="$TEST_ROOT/bin"
SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py"

mkdir -p "$TEST_INTEGRATION" "$TEST_HOME" "$TEST_DSH_HOME/sessions" "$TEST_MEMORY_ROOT" "$TEST_BIN"
cp "$SYNC_SOURCE" "$TEST_INTEGRATION/dsh-memory-sync"
chmod +x "$TEST_INTEGRATION/dsh-memory-sync"
cp "$PROJECT_DIR/packages/dsh-memory/lib/sync-apply.py" "$SYNC_HELPER"

# Idempotent initializer that prepares a real Git-backed memory root.
cat > "$TEST_INTEGRATION/dsh-memory-init" <<'EOF'
#!/bin/zsh
set -euo pipefail
root="${DSH_MEMORY_ROOT:?}"
if [[ ! -d "$root/.git" ]]; then
  mkdir -p "$root/handbook" "$root/rollouts" "$root/archive"
  : > "$root/summary.md"
  : > "$root/.last-sync"
  git -C "$root" init --quiet
  git -C "$root" config user.name "DSH Memory Test"
  git -C "$root" config user.email "dsh-memory-test@example.invalid"
  git -C "$root" add .
  git -C "$root" commit -q -m "Initialize DPSK memory repository"
fi
EOF
chmod +x "$TEST_INTEGRATION/dsh-memory-init"

DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" "$INITIALIZER" >/dev/null
touch -t 200001010000 "$TEST_MEMORY_ROOT/.last-sync"
: > "$TEST_DSH_HOME/sessions/session.jsonl.zstd"
touch -t 200001010001 "$TEST_DSH_HOME/sessions/session.jsonl.zstd"

cat > "$TEST_BIN/dsh" <<'EOF'
#!/bin/zsh
set -euo pipefail
printf 'preview entry %s\n' "$(date +%s)" > handbook/preview-cli.md
exit 0
EOF
chmod +x "$TEST_BIN/dsh"

run_sync() {
  env \
    HOME="$TEST_HOME" \
    DSH_HOME="$TEST_DSH_HOME" \
    DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
    DSH_BIN="$TEST_BIN/dsh" \
    DPSK_MEMORY_SYNC_HELPER="$SYNC_HELPER" \
    PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    zsh "$TEST_INTEGRATION/dsh-memory-sync" "$@"
}

# 1. --preview captures the candidate diff as a pending preview without
#    touching the live root.
PREVIEW_ID="20260820T150000Z-a1b2c3d4"
run_sync --preview "$PREVIEW_ID" >"$TEST_ROOT/preview.out" 2>&1
grep -q -- "preview $PREVIEW_ID created" "$TEST_ROOT/preview.out"
grep -q -- "handbook/preview-cli.md" "$TEST_ROOT/preview.out"
test ! -e "$TEST_MEMORY_ROOT/handbook/preview-cli.md"
test -f "$TEST_MEMORY_ROOT/.sync/previews/$PREVIEW_ID/preview.json"
/usr/bin/python3 - "$TEST_MEMORY_ROOT/.sync/previews/$PREVIEW_ID/preview.json" <<'PY'
import json
import sys
meta = json.load(open(sys.argv[1]))
assert meta["preview_id"].endswith("a1b2c3d4"), meta
assert meta["status"] == "pending", meta
assert "handbook/preview-cli.md" in meta["changed_paths"], meta
assert meta["expires_at"] > meta["created_at"], meta
PY

# 2. --apply-preview applies the staged payload and cleans up the preview.
run_sync --apply-preview "$PREVIEW_ID" >"$TEST_ROOT/apply.out" 2>&1
grep -q -- "preview $PREVIEW_ID applied" "$TEST_ROOT/apply.out"
test -f "$TEST_MEMORY_ROOT/handbook/preview-cli.md"
test ! -e "$TEST_MEMORY_ROOT/.sync/previews/$PREVIEW_ID"
test "$(git -C "$TEST_MEMORY_ROOT" log --oneline | wc -l | tr -d ' ')" -ge 2
test "$(git -C "$TEST_MEMORY_ROOT" log --oneline | grep -c -- 'DPSK memory sync applied')" -ge 1

# 3. --discard-preview on a missing id fails cleanly.
set +e
run_sync --discard-preview "20260820T150000Z-deadbeef" >"$TEST_ROOT/discard.out" 2>&1
discard_rc=$?
set -e
test "$discard_rc" != "0"
grep -q -- "preview not found" "$TEST_ROOT/discard.out"

# 4. --preview and --dry-run are mutually exclusive.
set +e
run_sync --dry-run --preview "$PREVIEW_ID" >"$TEST_ROOT/mutex.out" 2>&1
mutex_rc=$?
set -e
test "$mutex_rc" != "0"
grep -q -- "mutually exclusive" "$TEST_ROOT/mutex.out"

# 5. --dry-run is a deprecated alias of --scan-only: it warns on stderr and
#    emits the scan-only JSON contract (no diff report, no model run). The
#    session above is still an unconsumed candidate because preview apply
#    never advances the watermark.
marker_before="$(stat -f %m "$TEST_MEMORY_ROOT/.last-sync")"
run_sync --dry-run --json >"$TEST_ROOT/dry.json" 2>"$TEST_ROOT/dry.err"
grep -q -- '--dry-run is deprecated' "$TEST_ROOT/dry.err"
/usr/bin/python3 - "$TEST_ROOT/dry.json" <<'PY'
import json
import sys
report = json.load(open(sys.argv[1]))
assert report["ok"] is True, report
assert report["scanOnly"] is True, report
assert report["watermark"] == "set", report
assert report["candidateSessions"] == 1, report
assert isinstance(report["candidates"], list) and len(report["candidates"]) == 1, report
PY

# 6. The alias run stays side-effect free: no lock, journal, pending state,
#    and the watermark is untouched.
test ! -e "$TEST_MEMORY_ROOT/.sync/operation.lock"
test ! -e "$TEST_MEMORY_ROOT/.sync/active-run.json"
test ! -d "$TEST_MEMORY_ROOT/.sync/runs"
test ! -e "$TEST_MEMORY_ROOT/.sync/pending-candidates.json"
test "$(stat -f %m "$TEST_MEMORY_ROOT/.last-sync")" = "$marker_before"

print -- "dsh-memory sync preview tests passed"
