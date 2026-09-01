#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-batch.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
TEST_DSH_HOME="$TEST_ROOT/dsh-home"
TEST_MEMORY_ROOT="$TEST_ROOT/memory"
TEST_BIN="$TEST_ROOT/bin"
mkdir -p "$TEST_DSH_HOME/sessions" "$TEST_BIN"

DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  "$PROJECT_DIR/integrations/dsh/dsh-memory-init" >/dev/null
touch -t 200001010000 "$TEST_MEMORY_ROOT/.last-sync"
for index in {1..12}; do
  mkdir -p "$TEST_DSH_HOME/sessions/session-$index"
  print -- "session-$index" > "$TEST_DSH_HOME/sessions/session-$index/session.jsonl.zstd"
  touch -t 200001010001 "$TEST_DSH_HOME/sessions/session-$index/session.jsonl.zstd"
done

cat > "$TEST_BIN/dsh" <<'EOF'
#!/bin/zsh
set -euo pipefail
print -- "---\nschema_version: 1\nid: batch-entry\ntype: observation\nsource_session_digest: stub-digest\n---\nbatch synthetic memory" > handbook/batch.md
EOF
chmod +x "$TEST_BIN/dsh"

env \
  HOME="$TEST_ROOT/home" \
  DSH_HOME="$TEST_DSH_HOME" \
  DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  DSH_BIN="$TEST_BIN/dsh" \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  zsh "$PROJECT_DIR/integrations/dsh/dsh-memory-sync" >/dev/null

# The capped first batch must leave the watermark unchanged and remember the
# ten delivered files, so the next run picks up the remaining two without
# paying the provider twice for the first batch.
env \
  HOME="$TEST_ROOT/home" \
  DSH_HOME="$TEST_DSH_HOME" \
  DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  DSH_BIN="$TEST_BIN/dsh" \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  zsh "$PROJECT_DIR/integrations/dsh/dsh-memory-sync" >/dev/null

/usr/bin/python3 - "$TEST_MEMORY_ROOT/.sync/runs" <<'PY'
import json
import pathlib
import sys

records = [json.loads(path.read_text()) for path in pathlib.Path(sys.argv[1]).glob("*.json")]
applied = [record for record in records if record["status"] == "applied"]
assert len(applied) == 1, records
assert applied[0]["candidate_sessions"] == 10, applied[0]
assert applied[0]["processed_sessions"] == 10, applied[0]
no_change = [record for record in records if record["status"] == "no_change"]
assert len(no_change) == 1, records
assert no_change[0]["candidate_sessions"] == 2, no_change[0]
assert no_change[0]["processed_sessions"] == 2, no_change[0]
PY

print -- "dsh-memory sync batch limit tests passed"
