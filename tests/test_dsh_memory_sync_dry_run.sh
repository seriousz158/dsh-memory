#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SYNC_SOURCE="$PROJECT_DIR/integrations/dsh/dsh-memory-sync"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-dry-run.XXXXXX")"
TEST_INTEGRATION="$TEST_ROOT/integrations/dsh"
TEST_HOME="$TEST_ROOT/home"
TEST_DSH_HOME="$TEST_ROOT/dsh-home"
TEST_MEMORY_ROOT="$TEST_ROOT/memory"
TEST_BIN="$TEST_ROOT/bin"
OUTPUT="$TEST_ROOT/dry-run-output.txt"

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

DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" "$INITIALIZER" >/dev/null
rm -f "$TEST_MEMORY_ROOT/.last-sync"

cat > "$TEST_BIN/dsh" <<'EOF'
#!/bin/zsh
set -euo pipefail
printf 'synthetic memory entry\n' > handbook/synthetic.md
exit 0
EOF
chmod +x "$TEST_BIN/dsh"

# dry-run must report the would-be changes without applying them.
set +e
env \
  HOME="$TEST_HOME" \
  DSH_HOME="$TEST_DSH_HOME" \
  DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  DSH_BIN="$TEST_BIN/dsh" \
  DPSK_MEMORY_SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py" \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  zsh "$TEST_INTEGRATION/dsh-memory-sync" --dry-run > "$OUTPUT" 2>&1
rc=$?
set -e
test "$rc" = "0"
grep -q -- 'dry-run' "$OUTPUT"
grep -q -- 'handbook/synthetic.md' "$OUTPUT"

# dry-run must not modify the live root, journal, or watermark.
test ! -e "$TEST_MEMORY_ROOT/handbook/synthetic.md"
test ! -e "$TEST_MEMORY_ROOT/.sync"
test ! -e "$TEST_MEMORY_ROOT/.last-sync"
# The marker was removed by the test itself; nothing else in the live root may change.
test "$(git -C "$TEST_MEMORY_ROOT" status --porcelain | grep -v '^ D .last-sync$' | wc -l | tr -d ' ')" = "0"

print -- "dsh-memory sync dry-run tests passed"
