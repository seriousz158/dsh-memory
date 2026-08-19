#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SYNC_SOURCE="$PROJECT_DIR/integrations/dsh/dsh-memory-sync"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-disabled.XXXXXX")"
TEST_BIN="$TEST_ROOT/bin"
CALLS="$TEST_ROOT/calls.log"

mkdir -p "$TEST_BIN"

make_fake_integration() {
  local destination="$1"
  mkdir -p "$destination/integrations/dsh"
  cp "$SYNC_SOURCE" "$destination/integrations/dsh/dsh-memory-sync"
cat > "$destination/integrations/dsh/dsh-memory-init" <<'EOF'
#!/usr/bin/env zsh
set -euo pipefail
mkdir -p "${DSH_MEMORY_ROOT:?}"
print -- init > "$DSH_MEMORY_ROOT/.test-init"
EOF
  chmod +x "$destination/integrations/dsh/dsh-memory-sync" "$destination/integrations/dsh/dsh-memory-init"
}

for command_name in find dsh; do
  cat > "$TEST_BIN/$command_name" <<EOF
#!/usr/bin/env zsh
set -euo pipefail
print -- $command_name >> "\${DSH_MEMORY_SYNC_TEST_LOG:?}"
exit 0
EOF
  chmod +x "$TEST_BIN/$command_name"
done

DISABLED_PROJECT="$TEST_ROOT/disabled-project"
DISABLED_HOME="$DISABLED_PROJECT/.dsh"
make_fake_integration "$DISABLED_PROJECT"
mkdir -p "$DISABLED_HOME/storages/memory"
cat > "$DISABLED_HOME/settings.yaml" <<'YAML'
memory:
  enabled: false
YAML
touch "$DISABLED_HOME/storages/memory/.last-sync"

env \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  DSH_HOME="$DISABLED_HOME" \
  DSH_MEMORY_SYNC_TEST_LOG="$CALLS" \
  zsh "$DISABLED_PROJECT/integrations/dsh/dsh-memory-sync" >/dev/null
[[ ! -e "$CALLS" ]] || { print -u2 -- "disabled memory sync invoked: $(<"$CALLS")"; exit 1; }
[[ -f "$DISABLED_HOME/storages/memory/.last-sync" ]] || { print -u2 -- "disabled memory sync modified the marker"; exit 1; }

DEFAULT_PROJECT="$TEST_ROOT/default-project"
DEFAULT_HOME="$DEFAULT_PROJECT/.dsh"
DEFAULT_CALLS="$TEST_ROOT/default-calls.log"
make_fake_integration "$DEFAULT_PROJECT"
mkdir -p "$DEFAULT_HOME/storages/memory" "$DEFAULT_HOME/sessions"
touch "$DEFAULT_HOME/storages/memory/.last-sync"

env \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  DSH_HOME="$DEFAULT_HOME" \
  DSH_MEMORY_SYNC_TEST_LOG="$DEFAULT_CALLS" \
  zsh "$DEFAULT_PROJECT/integrations/dsh/dsh-memory-sync" >/dev/null
grep -qx -- init "$DEFAULT_HOME/storages/memory/.test-init" || { print -u2 -- "missing setting did not initialize memory"; exit 1; }
grep -qx -- find "$DEFAULT_CALLS" || { print -u2 -- "missing setting did not preserve the default enabled behavior"; exit 1; }

print -- "dsh-memory disabled sync test passed"
