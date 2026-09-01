#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-init.XXXXXX")"
FIXTURE_REPO="$TEST_ROOT/repository"
INITIALIZER="$FIXTURE_REPO/integrations/dsh/dsh-memory-init"
TEST_DSH_HOME="$TEST_ROOT/dsh-config/.dsh"
MEMORY_ROOT="$TEST_DSH_HOME/storages/memory"
OVERRIDE_ROOT="$TEST_ROOT/override-memory"

mkdir -p "$FIXTURE_REPO/integrations/dsh" "$FIXTURE_REPO/packages/dsh-memory/templates/.sync" "$FIXTURE_REPO/packages/dsh-memory/templates/scripts"
/usr/bin/install -m 700 "$PROJECT_DIR/integrations/dsh/dsh-memory-init" "$INITIALIZER"
/usr/bin/install -m 600 "$PROJECT_DIR/packages/dsh-memory/templates/README.md" "$FIXTURE_REPO/packages/dsh-memory/templates/README.md"
/usr/bin/install -m 600 "$PROJECT_DIR/packages/dsh-memory/templates/.sync/.gitignore" "$FIXTURE_REPO/packages/dsh-memory/templates/.sync/.gitignore"
/usr/bin/install -m 700 "$PROJECT_DIR/packages/dsh-memory/templates/scripts/filter_session.py" "$FIXTURE_REPO/packages/dsh-memory/templates/scripts/filter_session.py"

DSH_HOME="$TEST_DSH_HOME" "$INITIALIZER" >/dev/null

test -d "$MEMORY_ROOT"
test ! -L "$MEMORY_ROOT"
MEMORY_ROOT_REAL="$(cd -- "$MEMORY_ROOT" && pwd -P)"
test -f "$MEMORY_ROOT/README.md"
test -f "$MEMORY_ROOT/summary.md"
test -f "$MEMORY_ROOT/.last-sync"
test -f "$MEMORY_ROOT/.sync/.gitignore"
test -x "$MEMORY_ROOT/scripts/filter_session.py"
test -d "$MEMORY_ROOT/handbook"
test -d "$MEMORY_ROOT/rollouts"
test -d "$MEMORY_ROOT/archive"
test -d "$MEMORY_ROOT/.sync"
test "$(git -C "$MEMORY_ROOT" rev-parse --show-toplevel)" = "$MEMORY_ROOT_REAL"
test "$(git -C "$MEMORY_ROOT" log -1 --format=%s)" = "Initialize DPSK memory repository"

if stat -f '%Lp' "$MEMORY_ROOT" >/dev/null 2>&1; then
  test "$(stat -f '%Lp' "$MEMORY_ROOT")" = "700"
  test "$(stat -f '%Lp' "$MEMORY_ROOT/summary.md")" = "600"
else
  test "$(stat -c '%a' "$MEMORY_ROOT")" = "700"
  test "$(stat -c '%a' "$MEMORY_ROOT/summary.md")" = "600"
fi

head_before="$(git -C "$MEMORY_ROOT" rev-parse HEAD)"
DSH_HOME="$TEST_DSH_HOME" "$INITIALIZER" >/dev/null
test "$(git -C "$MEMORY_ROOT" rev-parse HEAD)" = "$head_before"
test ! -e "$TEST_ROOT/dsh-config/.zcode/memory"

chmod 755 "$MEMORY_ROOT"
chmod 644 "$MEMORY_ROOT/summary.md"
DSH_HOME="$TEST_DSH_HOME" "$INITIALIZER" >/dev/null
if stat -f '%Lp' "$MEMORY_ROOT" >/dev/null 2>&1; then
  test "$(stat -f '%Lp' "$MEMORY_ROOT")" = "700"
  test "$(stat -f '%Lp' "$MEMORY_ROOT/summary.md")" = "600"
else
  test "$(stat -c '%a' "$MEMORY_ROOT")" = "700"
  test "$(stat -c '%a' "$MEMORY_ROOT/summary.md")" = "600"
fi

DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$OVERRIDE_ROOT" "$INITIALIZER" >/dev/null
test -d "$OVERRIDE_ROOT/.git"
test ! -e "$TEST_DSH_HOME/storages/memory/override-memory"

ENV_PROBE_HOME="$TEST_ROOT/environment-probe/.dsh"
ENV_PROBE_BIN="$TEST_ROOT/environment-probe-bin"
ENV_PROBE_LOG="$TEST_ROOT/dsh-memory-init-env-probe.log"
REAL_GIT="$(command -v git)"
mkdir -p "$ENV_PROBE_BIN"
print -r -- '#!/bin/zsh' > "$ENV_PROBE_BIN/git"
print -r -- 'print -r -- "${DEEPSEEK_API_KEY:-missing}" >> "$TMPDIR/dsh-memory-init-env-probe.log"' >> "$ENV_PROBE_BIN/git"
print -r -- "exec ${(q)REAL_GIT} \"\$@\"" >> "$ENV_PROBE_BIN/git"
chmod 700 "$ENV_PROBE_BIN/git"
TMPDIR="$TEST_ROOT" PATH="$ENV_PROBE_BIN:$PATH" DEEPSEEK_API_KEY="synthetic-provider-value" DSH_HOME="$ENV_PROBE_HOME" "$INITIALIZER" >/dev/null
test -s "$ENV_PROBE_LOG"
if grep -q -- 'synthetic-provider-value' "$ENV_PROBE_LOG"; then
  print -u2 -- 'initializer passed a provider credential into its child environment'
  exit 1
fi
if grep -qv -- '^missing$' "$ENV_PROBE_LOG"; then
  print -u2 -- 'initializer child environment probe recorded an unexpected credential value'
  exit 1
fi

if DSH_HOME=relative "$INITIALIZER" >/dev/null 2>&1; then
  print -u2 -- "initializer accepted a relative DSH_HOME"
  exit 1
fi

ln -s "$TEST_ROOT" "$TEST_ROOT/symlink-memory"
if DSH_MEMORY_ROOT="$TEST_ROOT/symlink-memory" "$INITIALIZER" >/dev/null 2>&1; then
  print -u2 -- "initializer accepted a symlink memory root"
  exit 1
fi

INCOMPLETE_REPOSITORY="$TEST_ROOT/incomplete-repository"
mkdir -p "$INCOMPLETE_REPOSITORY"
git -C "$INCOMPLETE_REPOSITORY" init --quiet
if DSH_MEMORY_ROOT="$INCOMPLETE_REPOSITORY" "$INITIALIZER" >/dev/null 2>&1; then
  print -u2 -- "initializer accepted an incomplete Git repository"
  exit 1
fi

REFRESH_HOME="$TEST_ROOT/refresh-home"
DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null
REFRESH_MEMORY_ROOT="$REFRESH_HOME/storages/memory"
REFRESH_TEMPLATE="$FIXTURE_REPO/packages/dsh-memory/templates/scripts/filter_session.py"
REFRESH_HELPER="$REFRESH_MEMORY_ROOT/scripts/filter_session.py"
REFRESH_README_TEMPLATE="$FIXTURE_REPO/packages/dsh-memory/templates/README.md"
REFRESH_README="$REFRESH_MEMORY_ROOT/README.md"
REFRESH_GITIGNORE_TEMPLATE="$FIXTURE_REPO/packages/dsh-memory/templates/.sync/.gitignore"
REFRESH_GITIGNORE="$REFRESH_MEMORY_ROOT/.sync/.gitignore"
print -r -- '# refresh-marker-one' >> "$REFRESH_TEMPLATE"
refresh_head_before="$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)"
DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null
test "$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)" != "$refresh_head_before"
test "$(git -C "$REFRESH_MEMORY_ROOT" log -1 --format=%s)" = "Refresh managed memory templates"
test "$(git -C "$REFRESH_MEMORY_ROOT" diff-tree --no-commit-id --name-only -r HEAD)" = "scripts/filter_session.py"
cmp -s "$REFRESH_TEMPLATE" "$REFRESH_HELPER"
refresh_head_after="$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)"
DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null
test "$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)" = "$refresh_head_after"

# All managed templates (README, .sync/.gitignore, helper) refresh in a
# single "Refresh managed memory templates" commit listing exactly the
# changed files.
print -r -- '# refresh-readme-marker' >> "$REFRESH_README_TEMPLATE"
print -r -- '# refresh-gitignore-marker' >> "$REFRESH_GITIGNORE_TEMPLATE"
DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null
test "$(git -C "$REFRESH_MEMORY_ROOT" log -1 --format=%s)" = "Refresh managed memory templates"
changed_files="$(git -C "$REFRESH_MEMORY_ROOT" diff-tree --no-commit-id --name-only -r HEAD | sort)"
test "$changed_files" = "$(printf '.sync/.gitignore\nREADME.md')"
cmp -s "$REFRESH_README_TEMPLATE" "$REFRESH_README"
cmp -s "$REFRESH_GITIGNORE_TEMPLATE" "$REFRESH_GITIGNORE"
refresh_head_after="$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)"
DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null
test "$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)" = "$refresh_head_after"

# A dirty (uncommitted) managed template fails closed for every managed file.
print -r -- '# uncommitted-helper-change' >> "$REFRESH_HELPER"
if DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null 2>&1; then
  print -u2 -- "initializer overwrote a dirty helper"
  exit 1
fi
grep -q -- '# uncommitted-helper-change' "$REFRESH_HELPER"
test "$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)" = "$refresh_head_after"
git -C "$REFRESH_MEMORY_ROOT" checkout -- scripts/filter_session.py

print -r -- '# uncommitted-readme-change' >> "$REFRESH_README"
if DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null 2>&1; then
  print -u2 -- "initializer overwrote a dirty README"
  exit 1
fi
grep -q -- '# uncommitted-readme-change' "$REFRESH_README"
test "$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)" = "$refresh_head_after"
git -C "$REFRESH_MEMORY_ROOT" checkout -- README.md

print -r -- '# uncommitted-gitignore-change' >> "$REFRESH_GITIGNORE"
if DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null 2>&1; then
  print -u2 -- "initializer overwrote a dirty .sync/.gitignore"
  exit 1
fi
grep -q -- '# uncommitted-gitignore-change' "$REFRESH_GITIGNORE"
test "$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)" = "$refresh_head_after"
git -C "$REFRESH_MEMORY_ROOT" checkout -- .sync/.gitignore

# After reverting every dirty change, the initializer succeeds again and the
# live copies match the (now stale) templates without a new commit.
DSH_HOME="$REFRESH_HOME" "$INITIALIZER" >/dev/null
test "$(git -C "$REFRESH_MEMORY_ROOT" rev-parse HEAD)" = "$refresh_head_after"

print "dsh-memory initializer tests passed"
