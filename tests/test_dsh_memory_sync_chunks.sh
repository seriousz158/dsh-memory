#!/usr/bin/env zsh
# v0.8.4 chunked-delivery contract tests:
#   1. sanitized transcripts are split into headered chunks with stable
#      provenance (session_id / session_digest / chunk_index), and the
#      journal records the delivered chunk count;
#   2. a session whose chunks exceed the model input cap is partially
#      delivered, deferred via pending-candidates v2 (next_chunk), and
#      resumes on the next run without re-paying for delivered chunks;
#   3. raw-cap rejections at scan time hold the watermark without a run
#      record (zero deliverable candidates);
#   4. mixed batches (one deliverable + one oversized) are applied but the
#      watermark stays held past the rejected candidate;
#   5. decompressed-too-large rejections at filter time journal a zero-cost
#      "rejected" run and hold the watermark.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-chunks.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
TEST_INTEGRATION="$TEST_ROOT/integrations/dsh"
mkdir -p "$TEST_INTEGRATION" \
  "$TEST_ROOT/packages/dsh-memory/templates/.sync" \
  "$TEST_ROOT/packages/dsh-memory/templates/scripts"

cp "$PROJECT_DIR/integrations/dsh/dsh-memory-sync" "$TEST_INTEGRATION/dsh-memory-sync"
cp "$PROJECT_DIR/integrations/dsh/dsh-memory-init" "$TEST_INTEGRATION/dsh-memory-init"
cp "$PROJECT_DIR/packages/dsh-memory/lib/sync-apply.py" "$TEST_INTEGRATION/sync-apply.py"
cp "$PROJECT_DIR/packages/dsh-memory/templates/README.md" "$TEST_ROOT/packages/dsh-memory/templates/README.md"
cp "$PROJECT_DIR/packages/dsh-memory/templates/.sync/.gitignore" "$TEST_ROOT/packages/dsh-memory/templates/.sync/.gitignore"
cp "$PROJECT_DIR/packages/dsh-memory/templates/scripts/filter_session.py" "$TEST_ROOT/packages/dsh-memory/templates/scripts/filter_session.py"
chmod +x "$TEST_INTEGRATION/dsh-memory-sync" "$TEST_INTEGRATION/dsh-memory-init"
FILTER_SRC="$TEST_ROOT/packages/dsh-memory/templates/scripts/filter_session.py"

PY=/usr/bin/python3
OBS="$TEST_ROOT/observations"
mkdir -p "$OBS"
print -- 0 > "$OBS/counter"

# Build a plain-text (non-zstd) session log with <turns> user messages of
# <text_len> ASCII characters each, backdated out of the 1-hour idle window.
make_session_log() {
  "$PY" - "$@" <<'PYEOF'
import json
import pathlib
import sys

path, sid, turns, text_len = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
lines = [{"type": "session", "id": sid, "data": {"id": sid, "cwd": "/tmp/demo", "agentPreset": "test"}}]
for turn in range(1, turns + 1):
    lines.append({
        "type": "user/message",
        "data": {"turn": turn, "content": [{"type": "text", "text": "turn %d payload: %s" % (turn, "a" * text_len)}]},
    })
pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(path).write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")
PYEOF
}

# fresh_env <name>: provision an isolated dsh-home + memory root + bin dir.
SECTION=""
fresh_env() {
  SECTION="$1"
  SECTION_DSH_HOME="$TEST_ROOT/$SECTION/dsh-home"
  SECTION_ROOT="$TEST_ROOT/$SECTION/memory"
  SECTION_BIN="$TEST_ROOT/$SECTION/bin"
  mkdir -p "$SECTION_DSH_HOME/sessions" "$SECTION_BIN"
  DSH_HOME="$SECTION_DSH_HOME" DSH_MEMORY_ROOT="$SECTION_ROOT" \
    "$TEST_INTEGRATION/dsh-memory-init" >/dev/null
  touch -t 200001010000 "$SECTION_ROOT/.last-sync"
}

# Headless DSH stub: captures how many chunk files the manifest delivered on
# each run and copies them out for inspection (they live under the staging
# input tree, which the host deletes after the child exits).
write_stub() {
  local bin="$1"
  cat > "$bin/dsh" <<EOF
#!/bin/zsh
set -euo pipefail
for last; do :; done
prompt="\$last"
seq=\$(cat "$OBS/counter" 2>/dev/null || print 0)
seq=\$((seq + 1))
print -- "\$seq" > "$OBS/counter"
out="$OBS/run-\$seq"
mkdir -p "\$out"
print -r -- "\$prompt" > "\$out/prompt.txt"
manifest="\$(printf '%s' "\$prompt" | /usr/bin/python3 -c 'import sys,re; m=re.search(r"候选会话清单：(\\S+?)（", sys.stdin.read()); print(m.group(1) if m else "")')"
n=0
if [[ -n "\$manifest" && -f "\$manifest" ]]; then
  while IFS= read -r chunk; do
    [[ -n "\$chunk" ]] || continue
    n=\$((n + 1))
    cp -- "\$chunk" "\$out/chunk-\$n.md"
  done < "\$manifest"
fi
print -- "\$n" > "\$out/chunk-count.txt"
mkdir -p handbook
print -- "stub consolidation run \$seq" > handbook/consolidated.md
EOF
  chmod +x "$bin/dsh"
}

run_sync() {
  # $1 = extra env assignments already set by the caller via env prefix.
  env \
    HOME="$TEST_ROOT/home" \
    DSH_HOME="$SECTION_DSH_HOME" \
    DSH_MEMORY_ROOT="$SECTION_ROOT" \
    DSH_BIN="$SECTION_BIN/dsh" \
    DPSK_MEMORY_SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py" \
    PATH="$SECTION_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$@" \
    zsh "$TEST_INTEGRATION/dsh-memory-sync"
}

JOURNAL_TMP="$TEST_ROOT/journal.json"
journal_records() {
  "$PY" - "$SECTION_ROOT" "$JOURNAL_TMP" <<'PYEOF'
import json
import pathlib
import sys

runs = pathlib.Path(sys.argv[1]) / ".sync" / "runs"
records = [json.loads(p.read_text()) for p in sorted(runs.glob("*.json"))]
pathlib.Path(sys.argv[2]).write_text(json.dumps(records), encoding="utf-8")
PYEOF
}

watermark_held() {
  [[ -f "$SECTION_ROOT/.last-sync" && ! -s "$SECTION_ROOT/.last-sync" ]]
}

watermark_advanced() {
  [[ -s "$SECTION_ROOT/.last-sync" ]]
}

# --- 1. Chunk headers: provenance header on every chunk + journal counts ---
fresh_env headers
HEADERS_SESSION="$SECTION_DSH_HOME/sessions/sess-headers/session.jsonl.zstd"
make_session_log "$HEADERS_SESSION" "sess-headers" 6 200
touch -t 200001010001 "$HEADERS_SESSION"
write_stub "$SECTION_BIN"
run_sync DSH_MEMORY_MAX_CHUNK_BYTES=300 >/dev/null

HEADERS_T="$("$PY" - "$OBS/run-1" "$HEADERS_SESSION" <<'PYEOF'
import hashlib
import pathlib
import re
import sys

run_dir = pathlib.Path(sys.argv[1])
session = pathlib.Path(sys.argv[2])
digest = hashlib.sha256(session.read_bytes()).hexdigest()
chunks = sorted(run_dir.glob("chunk-*.md"))
assert len(chunks) >= 3, len(chunks)
seen = []
total = None
for chunk in chunks:
    match = re.match(
        r"<!-- dsh-memory-chunk\n"
        r"session_id: (.*)\n"
        r"session_digest: ([0-9a-f]{64})\n"
        r"chunk_index: (\d+)/(\d+)\n"
        r"-->",
        chunk.read_text(),
    )
    assert match, chunk.read_text()[:200]
    assert match.group(1) == "sess-headers", match.group(1)
    assert match.group(2) == digest, (match.group(2), digest)
    seen.append(int(match.group(3)))
    total = int(match.group(4))
assert seen == list(range(1, len(chunks) + 1)), seen
assert total == len(chunks), (total, len(chunks))
print(total)
PYEOF
)"

journal_records
"$PY" - "$JOURNAL_TMP" "$HEADERS_T" <<'PYEOF'
import json
import pathlib
import sys

records = json.loads(pathlib.Path(sys.argv[1]).read_text())
applied = [r for r in records if r["status"] == "applied"]
assert len(applied) == 1, records
record = applied[0]
assert record["candidate_sessions"] == 1, record
assert record["processed_chunk_count"] == int(sys.argv[2]), record
assert record["deferred_candidate_count"] == 0, record
assert record["rejected_candidate_count"] == 0, record
PYEOF
watermark_advanced
[[ ! -e "$SECTION_ROOT/.sync/pending-candidates.json" ]]
print -- "1. chunk header provenance + journal counts: ok"

# --- 2. Deferred resume: model input cap defers chunks, next run resumes ---
fresh_env resume
RESUME_SESSION="$SECTION_DSH_HOME/sessions/sess-resume/session.jsonl.zstd"
make_session_log "$RESUME_SESSION" "sess-resume" 6 200
touch -t 200001010001 "$RESUME_SESSION"
write_stub "$SECTION_BIN"
RESUME_DIGEST="$(shasum -a 256 -- "$RESUME_SESSION" | awk '{print $1}')"
probe="$("$PY" "$FILTER_SRC" "$RESUME_SESSION" \
  --chunk-dir "$TEST_ROOT/probe-resume" --chunk-bytes 300 \
  --session-digest "$RESUME_DIGEST" --max-decompressed-bytes 1048576)"
RESUME_TOTAL="$(printf '%s' "$probe" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["chunk_total"])')"
FIRST_SIZE="$(printf '%s' "$probe" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["chunk_sizes"][0])')"

# Run 1: only the first chunk fits the model input batch cap; the rest is
# deferred and recorded in pending-candidates v2.
run_sync DSH_MEMORY_MAX_CHUNK_BYTES=300 "DSH_MEMORY_MAX_CANDIDATE_BYTES=$((FIRST_SIZE + 10))" >/dev/null
[[ "$(cat "$OBS/run-2/chunk-count.txt")" == "1" ]]
journal_records
"$PY" - "$JOURNAL_TMP" "$RESUME_TOTAL" <<'PYEOF'
import json
import pathlib
import sys

records = json.loads(pathlib.Path(sys.argv[1]).read_text())
applied = [r for r in records if r["status"] == "applied"]
assert len(applied) == 1, records
record = applied[0]
assert record["processed_chunk_count"] == 1, record
assert record["deferred_candidate_count"] == 1, record
assert record["rejected_candidate_count"] == 0, record
assert record["processed_sessions"] == 1, record
PYEOF
watermark_held
"$PY" - "$SECTION_ROOT" "$RESUME_DIGEST" "$RESUME_TOTAL" <<'PYEOF'
import json
import pathlib
import re
import sys

root, digest, total = sys.argv[1], sys.argv[2], int(sys.argv[3])
state = json.loads((pathlib.Path(root) / ".sync" / "pending-candidates.json").read_text())
assert state["schema_version"] == 2, state
entries = state["entries"]
assert len(entries) == 1, entries
entry = list(entries.values())[0]
assert entry["digest"] == digest, entry
assert entry["next_chunk"] == 2, entry
assert entry["chunk_total"] == total, entry
assert entry["complete"] is False, entry
assert re.fullmatch(r"[0-9a-f]{64}", digest)
PYEOF

# Run 2: the session resumes from chunk 2, delivers the remainder, and the
# watermark finally advances past the fully resolved window.
run_sync DSH_MEMORY_MAX_CHUNK_BYTES=300 >/dev/null
[[ "$(cat "$OBS/run-3/chunk-count.txt")" == "$((RESUME_TOTAL - 1))" ]]
"$PY" - "$OBS/run-3" <<'PYEOF'
import pathlib
import re
import sys

run_dir = pathlib.Path(sys.argv[1])
indices = []
total = None
for chunk in sorted(run_dir.glob("chunk-*.md")):
    match = re.search(r"chunk_index: (\d+)/(\d+)", chunk.read_text())
    assert match, chunk
    indices.append(int(match.group(1)))
    total = int(match.group(2))
assert indices == list(range(2, total + 1)), (indices, total)
PYEOF
journal_records
"$PY" - "$JOURNAL_TMP" "$RESUME_TOTAL" <<'PYEOF'
import json
import pathlib
import sys

records = json.loads(pathlib.Path(sys.argv[1]).read_text())
applied = [r for r in records if r["status"] == "applied"]
assert len(applied) == 2, records
resume = applied[1]
assert resume["processed_chunk_count"] == int(sys.argv[2]) - 1, resume
assert resume["deferred_candidate_count"] == 0, resume
assert resume["rejected_candidate_count"] == 0, resume
PYEOF
watermark_advanced
[[ ! -e "$SECTION_ROOT/.sync/pending-candidates.json" ]]
print -- "2. deferred resume via pending-candidates v2: ok (chunk_total=$RESUME_TOTAL)"

# --- 3. Raw cap at scan time, all candidates oversized: zero-cost hold ---
fresh_env rawcap
BIG_SESSION="$SECTION_DSH_HOME/sessions/sess-big/session.jsonl.zstd"
make_session_log "$BIG_SESSION" "sess-big" 6 200
"$PY" - "$BIG_SESSION" <<'PYEOF'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(b"x" * 4096)
PYEOF
touch -t 200001010001 "$BIG_SESSION"
write_stub "$SECTION_BIN"
rawcap_out="$(run_sync DSH_MEMORY_MAX_SESSION_FILE_BYTES=1024)"
print -r -- "$rawcap_out" | grep -q "0 deliverable session(s), 1 rejected by the raw cap; watermark held."
journal_records
[[ "$(cat "$JOURNAL_TMP")" == "[]" ]]
watermark_held
[[ ! -e "$SECTION_ROOT/.sync/pending-candidates.json" ]]
print -- "3. raw-cap zero-deliverable hold: ok"

# --- 4. Mixed batch: deliverable applied, oversized rejected, watermark held ---
fresh_env rawmix
MIX_SMALL="$SECTION_DSH_HOME/sessions/sess-small/session.jsonl.zstd"
MIX_BIG="$SECTION_DSH_HOME/sessions/sess-oversize/session.jsonl.zstd"
make_session_log "$MIX_SMALL" "sess-small" 2 60
make_session_log "$MIX_BIG" "sess-oversize" 6 200
"$PY" - "$MIX_BIG" <<'PYEOF'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(b"x" * 4096)
PYEOF
touch -t 200001010001 "$MIX_SMALL" "$MIX_BIG"
write_stub "$SECTION_BIN"
counter_before="$(cat "$OBS/counter")"
run_sync DSH_MEMORY_MAX_SESSION_FILE_BYTES=1024 >/dev/null
[[ "$(cat "$OBS/counter")" == "$((counter_before + 1))" ]]
journal_records
"$PY" - "$JOURNAL_TMP" <<'PYEOF'
import json
import pathlib
import sys

records = json.loads(pathlib.Path(sys.argv[1]).read_text())
applied = [r for r in records if r["status"] == "applied"]
assert len(applied) == 1, records
record = applied[0]
assert record["candidate_sessions"] == 1, record
assert record["rejected_candidate_count"] == 1, record
assert record["deferred_candidate_count"] == 0, record
PYEOF
# The run applied memory changes, but the rejected candidate keeps the
# watermark from advancing past the window.
watermark_held
print -- "4. mixed batch apply + watermark held past rejection: ok"

# --- 5. Decompressed-too-large: filter-stage rejection journals a zero-cost run ---
fresh_env decomp
DECOMP_SESSION="$SECTION_DSH_HOME/sessions/sess-decomp/session.jsonl.zstd"
make_session_log "$DECOMP_SESSION" "sess-decomp" 4 400
touch -t 200001010001 "$DECOMP_SESSION"
write_stub "$SECTION_BIN"
counter_before="$(cat "$OBS/counter")"
decomp_out="$(run_sync DSH_MEMORY_MAX_SESSION_DECOMPRESSED_BYTES=500)"
[[ "$(cat "$OBS/counter")" == "$counter_before" ]]
print -r -- "$decomp_out" | grep -q "0 chunk(s) delivered (0 deferred, 1 rejected); watermark held."
journal_records
"$PY" - "$JOURNAL_TMP" <<'PYEOF'
import json
import pathlib
import sys

records = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert len(records) == 1, records
record = records[0]
assert record["status"] == "rejected", record
assert record["rejected_candidate_count"] == 1, record
assert record["deferred_candidate_count"] == 0, record
assert record["processed_chunk_count"] == 0, record
PYEOF
watermark_held
print -- "5. decompressed-too-large rejection: ok"

print -- "dsh-memory sync chunked delivery tests passed"
