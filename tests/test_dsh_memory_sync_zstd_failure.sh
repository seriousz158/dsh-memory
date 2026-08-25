#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-zstd-failure.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
TEST_DSH_HOME="$TEST_ROOT/dsh-home"
TEST_MEMORY_ROOT="$TEST_ROOT/memory"
TEST_INTEGRATION="$TEST_ROOT/integrations/dsh"
TEST_BIN="$TEST_ROOT/bin"
mkdir -p "$TEST_DSH_HOME/sessions" "$TEST_INTEGRATION" "$TEST_BIN" \
  "$TEST_ROOT/packages/dsh-memory/templates/.sync" \
  "$TEST_ROOT/packages/dsh-memory/templates/scripts"

cp "$PROJECT_DIR/integrations/dsh/dsh-memory-sync" "$TEST_INTEGRATION/dsh-memory-sync"
cp "$PROJECT_DIR/integrations/dsh/dsh-memory-init" "$TEST_INTEGRATION/dsh-memory-init"
cp "$PROJECT_DIR/packages/dsh-memory/lib/sync-apply.py" "$TEST_INTEGRATION/sync-apply.py"
cp "$PROJECT_DIR/packages/dsh-memory/templates/README.md" "$TEST_ROOT/packages/dsh-memory/templates/README.md"
cp "$PROJECT_DIR/packages/dsh-memory/templates/.sync/.gitignore" "$TEST_ROOT/packages/dsh-memory/templates/.sync/.gitignore"
cp "$PROJECT_DIR/packages/dsh-memory/templates/scripts/filter_session.py" "$TEST_ROOT/packages/dsh-memory/templates/scripts/filter_session.py"
chmod +x "$TEST_INTEGRATION/dsh-memory-sync" "$TEST_INTEGRATION/dsh-memory-init"

DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" "$TEST_INTEGRATION/dsh-memory-init" >/dev/null
touch -t 200001010000 "$TEST_MEMORY_ROOT/.last-sync"
/usr/bin/python3 - "$TEST_DSH_HOME/sessions/session.jsonl.zstd" <<'PY'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(bytes((0x28, 0xB5, 0x2F, 0xFD, 0x00)))
PY
touch -t 200001010001 "$TEST_DSH_HOME/sessions/session.jsonl.zstd"

cat > "$TEST_BIN/should-not-run" <<'EOF'
#!/bin/zsh
print -u2 -- 'fake DSH must not run when zstd is unavailable'
exit 99
EOF
chmod +x "$TEST_BIN/should-not-run"

if env \
  HOME="$TEST_ROOT/home" \
  DSH_HOME="$TEST_DSH_HOME" \
  DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  DSH_BIN="$TEST_BIN/should-not-run" \
  DPSK_MEMORY_SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py" \
  DPSK_ZSTD="$TEST_ROOT/missing-zstd" \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  zsh "$TEST_INTEGRATION/dsh-memory-sync" >"$TEST_ROOT/stdout" 2>"$TEST_ROOT/stderr"; then
  print -u2 -- 'sync unexpectedly succeeded with unavailable zstd'
  exit 1
fi
grep -q -- 'zstd-unavailable' "$TEST_ROOT/stderr"

/usr/bin/python3 - "$TEST_MEMORY_ROOT/.sync/runs" "$TEST_MEMORY_ROOT/.sync/failure-sentinel.json" <<'PY'
import json
import pathlib
import sys

runs = sorted(pathlib.Path(sys.argv[1]).glob("*.json"))
assert runs, runs
record = json.loads(runs[-1].read_text())
assert record["error_code"] == "zstd-unavailable", record
sentinel = json.loads(pathlib.Path(sys.argv[2]).read_text())
assert sentinel["error_code"] == "zstd-unavailable", sentinel
PY

print -- "dsh-memory zstd failure mapping test passed"
