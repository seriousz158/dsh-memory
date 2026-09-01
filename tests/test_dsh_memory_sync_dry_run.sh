#!/usr/bin/env zsh
set -euo pipefail

# v0.8.3: --scan-only (and its deprecated --dry-run alias) is the zero-Provider
# acceptance path. It reports the candidate scan without starting DSH, without
# acquiring the operation lock, without writing a journal or pending state,
# and without advancing the .last-sync watermark.

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SYNC_SOURCE="$PROJECT_DIR/integrations/dsh/dsh-memory-sync"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-scan-only.XXXXXX")"
TEST_INTEGRATION="$TEST_ROOT/integrations/dsh"
TEST_HOME="$TEST_ROOT/home"
TEST_DSH_HOME="$TEST_ROOT/dsh-home"
TEST_MEMORY_ROOT="$TEST_ROOT/memory"
TEST_BIN="$TEST_ROOT/bin"
CANARY_HIT="$TEST_ROOT/canary-hit"
OUT="$TEST_ROOT/scan-out.txt"
ERR="$TEST_ROOT/scan-err.txt"

mkdir -p "$TEST_INTEGRATION" "$TEST_HOME" "$TEST_DSH_HOME/sessions" "$TEST_MEMORY_ROOT" "$TEST_BIN"
cp "$SYNC_SOURCE" "$TEST_INTEGRATION/dsh-memory-sync"
chmod +x "$TEST_INTEGRATION/dsh-memory-sync"
cp "$PROJECT_DIR/packages/dsh-memory/lib/sync-apply.py" "$TEST_INTEGRATION/sync-apply.py"
cat > "$TEST_INTEGRATION/dsh-memory-init" <<'EOF'
#!/bin/zsh
set -euo pipefail
mkdir -p "${DSH_MEMORY_ROOT:?}"
EOF
chmod +x "$TEST_INTEGRATION/dsh-memory-init"

# Real initializer (via env) prepares the git-backed memory root; the stub
# above is what dsh-memory-sync itself invokes in scan-only mode (and it must
# never be reached, because scan-only skips the initializer).
DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com \
  GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com \
  "$INITIALIZER" >/dev/null

# A canary DSH stub: if any sync path reaches DSH, the test fails loudly.
cat > "$TEST_BIN/dsh" <<EOF
#!/bin/zsh
print -r -- hit > "$CANARY_HIT"
exit 42
EOF
chmod +x "$TEST_BIN/dsh"

run_sync() {
  env \
    HOME="$TEST_HOME" \
    DSH_HOME="$TEST_DSH_HOME" \
    DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
    DSH_BIN="$TEST_BIN/dsh" \
    DPSK_MEMORY_SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py" \
    GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com \
    GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com \
    PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    zsh "$TEST_INTEGRATION/dsh-memory-sync" "$@"
}

assert_no_side_effects() {
  test ! -e "$CANARY_HIT"
  test ! -e "$TEST_MEMORY_ROOT/.sync/operation.lock"
  test ! -e "$TEST_MEMORY_ROOT/.sync/active-run.json"
  test ! -d "$TEST_MEMORY_ROOT/.sync/runs"
  test ! -e "$TEST_MEMORY_ROOT/.sync/last-run.json"
  test ! -e "$TEST_MEMORY_ROOT/.sync/pending-candidates.json"
  local dirty
  dirty="$(git -C "$TEST_MEMORY_ROOT" status --porcelain | grep -v '^ D \.last-sync$' || true)"
  [[ -z "$dirty" ]] || { print -u2 -- "unexpected live-root changes: $dirty"; exit 1; }
}

# --- Case 1: first run (no watermark) — JSON reports an absent watermark and
# zero candidates, with zero side effects.
rm -f "$TEST_MEMORY_ROOT/.last-sync"
set +e
run_sync --scan-only --json > "$OUT" 2> "$ERR"
rc=$?
set -e
test "$rc" = "0"
/usr/bin/python3 - "$OUT" <<'PY'
import json, sys
data = json.loads(open(sys.argv[1]).read())
assert data["ok"] is True and data["scanOnly"] is True, data
assert data["watermark"] == "absent", data
assert data["candidateSessions"] == 0, data
assert data["candidates"] == [], data
PY
assert_no_side_effects
test ! -e "$TEST_MEMORY_ROOT/.last-sync"

# --- Case 2: watermark present plus one idle (2h-old) session newer than the
# marker — JSON reports the candidate with bytes and digest, the watermark
# state stays "set", and the marker mtime is untouched.
git -C "$TEST_MEMORY_ROOT" checkout -- .last-sync
touch -t "$(date -v-3H +%Y%m%d%H%M)" "$TEST_MEMORY_ROOT/.last-sync"
SESSION_DIR="$TEST_DSH_HOME/sessions/sess-scan-0001"
mkdir -p "$SESSION_DIR"
printf 'synthetic session payload\n' > "$SESSION_DIR/session.jsonl.zstd"
touch -t "$(date -v-2H +%Y%m%d%H%M)" "$SESSION_DIR/session.jsonl.zstd"
marker_mtime_before="$(stat -f %m "$TEST_MEMORY_ROOT/.last-sync")"
set +e
run_sync --scan-only --json > "$OUT" 2> "$ERR"
rc=$?
set -e
test "$rc" = "0"
/usr/bin/python3 - "$OUT" "$SESSION_DIR/session.jsonl.zstd" <<'PY'
import json, sys
data = json.loads(open(sys.argv[1]).read())
expected = sys.argv[2]
assert data["ok"] is True and data["scanOnly"] is True, data
assert data["watermark"] == "set", data
assert data["candidateSessions"] == 1, data
assert data["candidates"][0]["path"] == expected, data
assert data["candidates"][0]["bytes"] > 0, data
digest = data["candidates"][0]["digest"]
assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest), data
PY
marker_mtime_after="$(stat -f %m "$TEST_MEMORY_ROOT/.last-sync")"
test "$marker_mtime_before" = "$marker_mtime_after"
assert_no_side_effects
test -e "$TEST_MEMORY_ROOT/.last-sync"

# Text mode reports the same scan in prose.
set +e
run_sync --scan-only > "$OUT" 2> "$ERR"
rc=$?
set -e
test "$rc" = "0"
grep -q -- 'scan-only: 1 candidate session(s)' "$OUT" "$ERR" || {
  print -u2 -- "text scan-only output missing candidate summary"; exit 1; }
assert_no_side_effects

# --- Case 3: --dry-run is a deprecated alias of --scan-only: it warns on
# stderr, never runs the model, and has zero side effects.
set +e
run_sync --dry-run > "$OUT" 2> "$ERR"
rc=$?
set -e
test "$rc" = "0"
grep -q -- '--dry-run is deprecated' "$ERR"
assert_no_side_effects

# --- Case 4: --scan-only and --preview are mutually exclusive (fail-closed).
set +e
run_sync --scan-only --preview some-id > "$OUT" 2> "$ERR"
rc=$?
set -e
test "$rc" != "0"
grep -q -- 'mutually exclusive' "$ERR"
assert_no_side_effects

rm -rf "$TEST_ROOT"
print -- "dsh-memory sync scan-only tests passed"
