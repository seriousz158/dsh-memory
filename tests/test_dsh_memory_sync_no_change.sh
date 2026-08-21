#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-nochange.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

export DSH_HOME="$TEST_ROOT/.dsh"
export DSH_MEMORY_ROOT="$DSH_HOME/storages/memory"
mkdir -p "$DSH_HOME"

DSH_HOME="$DSH_HOME" DSH_MEMORY_ROOT="$DSH_MEMORY_ROOT" \
  "$PROJECT_DIR/integrations/dsh/dsh-memory-init" >/dev/null

# init 创建的 .last-sync 内容为空（即断言 1 的空基线，zsh 算术比较按 0 处理）、
# mtime 是现在；因此把 marker mtime 拨到 3 小时前、session mtime 拨到 2 小时前即构成候选。
mkdir -p "$DSH_HOME/sessions/ws/s1"
print -- 'fake' | /usr/bin/gzip > "$DSH_HOME/sessions/ws/s1/session.jsonl.zstd"
THREE_HOURS_AGO="$(date -v-3H +%Y%m%d%H%M.%S)"
TWO_HOURS_AGO="$(date -v-2H +%Y%m%d%H%M.%S)"
/usr/bin/touch -t "$THREE_HOURS_AGO" "$DSH_MEMORY_ROOT/.last-sync"
/usr/bin/touch -t "$TWO_HOURS_AGO" "$DSH_HOME/sessions/ws/s1/session.jsonl.zstd"
MARKER_BEFORE="$(cat "$DSH_MEMORY_ROOT/.last-sync")"

STUB_BIN="$TEST_ROOT/dsh-stub"
print -- '#!/bin/zsh
exit 0' > "$STUB_BIN"
chmod +x "$STUB_BIN"

env DSH_HOME="$DSH_HOME" DSH_MEMORY_ROOT="$DSH_MEMORY_ROOT" DSH_BIN="$STUB_BIN" \
  zsh "$PROJECT_DIR/integrations/dsh/dsh-memory-sync" >/dev/null

MARKER_AFTER="$(cat "$DSH_MEMORY_ROOT/.last-sync")"
[[ "$MARKER_AFTER" -gt "$MARKER_BEFORE" ]] || { print -u2 -- "watermark not advanced: $MARKER_BEFORE -> $MARKER_AFTER"; exit 1; }
/usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["status"]=="no_change", d["status"]' \
  "$DSH_MEMORY_ROOT/.sync/last-run.json"
/usr/bin/git -C "$DSH_MEMORY_ROOT" log -1 --format=%s | grep -q "DPSK memory journal"

print 'dsh-memory no-change watermark test passed'
