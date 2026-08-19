#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
MIGRATE="$PROJECT_DIR/integrations/dsh/dsh-memory-migrate"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-migrate.XXXXXX")"
MEMORY_ROOT="$TEST_ROOT/memory"

DSH_HOME="$TEST_ROOT" DSH_MEMORY_ROOT="$MEMORY_ROOT" "$INITIALIZER" >/dev/null
mkdir -p "$MEMORY_ROOT/handbook"
cat > "$MEMORY_ROOT/handbook/legacy.md" <<'EOF'
# Legacy entry
old knowledge body
EOF
git -C "$MEMORY_ROOT" add -A
git -C "$MEMORY_ROOT" commit -m "add legacy record" >/dev/null
BODY_SHA="$(git -C "$MEMORY_ROOT" rev-parse HEAD)"

# dry-run must not change files or Git.
dry_output="$(DSH_HOME="$TEST_ROOT" DSH_MEMORY_ROOT="$MEMORY_ROOT" "$MIGRATE" --dry-run)"
echo "$dry_output" | grep -q -- 'handbook/legacy.md'
test "$(git -C "$MEMORY_ROOT" rev-parse HEAD)" = "$BODY_SHA"
grep -q -- '^# Legacy entry' "$MEMORY_ROOT/handbook/legacy.md"

# apply adds front matter but preserves the body.
apply_output="$(DSH_HOME="$TEST_ROOT" DSH_MEMORY_ROOT="$MEMORY_ROOT" "$MIGRATE" --apply)"
echo "$apply_output" | grep -q -- 'migrated 1 record'
grep -q -- '^---$' "$MEMORY_ROOT/handbook/legacy.md"
grep -q -- '^# Legacy entry' "$MEMORY_ROOT/handbook/legacy.md"
grep -q -- 'old knowledge body' "$MEMORY_ROOT/handbook/legacy.md"
grep -q -- '^id: legacy-' "$MEMORY_ROOT/handbook/legacy.md"
APPLY_HEAD="$(git -C "$MEMORY_ROOT" rev-parse HEAD)"
test "$APPLY_HEAD" != "$BODY_SHA"
test -f "$MEMORY_ROOT/.sync/last-run.json"

# Re-running apply is idempotent (no legacy records remain).
idempotent="$(DSH_HOME="$TEST_ROOT" DSH_MEMORY_ROOT="$MEMORY_ROOT" "$MIGRATE" --apply)"
echo "$idempotent" | grep -q -- 'no legacy records'
test "$(git -C "$MEMORY_ROOT" rev-parse HEAD)" = "$APPLY_HEAD"

print -- "dsh-memory migrate tests passed"
