#!/bin/zsh
# v0.3: the sync wrapper serializes runs with the host-side operation lock,
# records an active run, recovers an interrupted previous run into the journal,
# and never touches the lock or .sync on a read-only dry-run.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SYNC_SOURCE="$PROJECT_DIR/integrations/dsh/dsh-memory-sync"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-lock.XXXXXX")"
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

# A minimal initializer that prepares a real Git-backed memory root. It must be
# idempotent like the real initializer: re-runs inside sync must not reset the
# .last-sync watermark mtime (the sync finds sessions newer than the marker).
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

# Provide one idle session newer than the watermark so the sync runs the full
# transactional path instead of the zero-session fast exit.
touch -t 200001010000 "$TEST_MEMORY_ROOT/.last-sync"
: > "$TEST_DSH_HOME/sessions/session.jsonl.zstd"
touch -t 200001010001 "$TEST_DSH_HOME/sessions/session.jsonl.zstd"

cat > "$TEST_BIN/dsh" <<'EOF'
#!/bin/zsh
set -euo pipefail
printf -- "---\nschema_version: 1\nid: synthetic-entry\ntype: observation\nsource_session_digest: stub-digest\n---\nsynthetic memory entry\n" > handbook/synthetic.md
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

# 1. A held operation lock is refused with a clean non-zero exit.
python3 "$SYNC_HELPER" acquire-lock --root "$TEST_MEMORY_ROOT" \
  --operation-name sync --run-id "20260820T120000Z-heldlock01" >/dev/null
set +e
run_sync >"$TEST_ROOT/refused.out" 2>&1
refused_rc=$?
set -e
test "$refused_rc" != "0"
grep -q -- "another sync operation is in progress" "$TEST_ROOT/refused.out"
python3 "$SYNC_HELPER" release-lock --root "$TEST_MEMORY_ROOT" \
  --run-id "20260820T120000Z-heldlock01" >/dev/null

# 2. An active run left behind by a dead process is recovered into the journal
#    before the new sync proceeds.
python3 "$SYNC_HELPER" write-active --root "$TEST_MEMORY_ROOT" \
  --run-id "20260819T000000Z-interrupt00" --operation-name sync \
  --phase applying --started-at "2026-08-19T00:00:00Z" \
  --pid 999999 >/dev/null
run_sync >"$TEST_ROOT/recover.out" 2>&1
grep -q -- "recovered an interrupted run" "$TEST_ROOT/recover.out"
/usr/bin/python3 - "$TEST_MEMORY_ROOT/.sync/runs" <<'PY'
import json
import pathlib
import sys

records = [json.loads(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob("*.json")]
interrupted = [r for r in records if r["status"] == "interrupted"]
assert len(interrupted) == 1, records
assert interrupted[0]["run_id"].startswith("20260819T000000Z"), interrupted[0]
assert interrupted[0]["phase"] == "applying", interrupted[0]
applied = [r for r in records if r["status"] == "applied"]
assert len(applied) == 1, records
assert applied[0]["phase"] == "complete", applied[0]
assert applied[0]["duration_ms"] is not None, applied[0]
PY

# 3. No active run or lock remains after a successful sync.
test ! -e "$TEST_MEMORY_ROOT/.sync/operation.lock"
test ! -e "$TEST_MEMORY_ROOT/.sync/active-run.json"

# 4. dry-run after a sync is still read-only: it must not touch the lock or
#    the journal, and it must not create any new run record.
run_sync --dry-run >"$TEST_ROOT/dry.out" 2>&1
grep -q -- "dry-run" "$TEST_ROOT/dry.out"
test ! -e "$TEST_MEMORY_ROOT/.sync/operation.lock"
/usr/bin/python3 - "$TEST_MEMORY_ROOT/.sync/runs" <<'PY'
import json
import pathlib
import sys

records = [json.loads(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob("*.json")]
assert len(records) == 2, [r["run_id"] for r in records]
PY

print -- "dsh-memory sync lock tests passed"
