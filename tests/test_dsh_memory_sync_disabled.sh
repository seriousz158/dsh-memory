#!/usr/bin/env zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SYNC_SOURCE="$PROJECT_DIR/integrations/dsh/dsh-memory-sync"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-disabled.XXXXXX")"
TEST_BIN="$TEST_ROOT/bin"
CALLS="$TEST_ROOT/calls.log"

mkdir -p "$TEST_BIN"

make_fake_integration() {
  local destination="$1"
  mkdir -p "$destination/integrations/dsh"
  cp "$SYNC_SOURCE" "$destination/integrations/dsh/dsh-memory-sync"
  cp "$PROJECT_DIR/packages/dsh-memory/lib/sync-apply.py" "$destination/integrations/dsh/sync-apply.py"
cat > "$destination/integrations/dsh/dsh-memory-init" <<'EOF'
#!/usr/bin/env zsh
set -euo pipefail
mkdir -p "${DSH_MEMORY_ROOT:?}"
print -- init > "$DSH_MEMORY_ROOT/.test-init"
EOF
  chmod +x "$destination/integrations/dsh/dsh-memory-sync" "$destination/integrations/dsh/dsh-memory-init"
}

# The fake DSH records every launch at a fixed path (the headless child runs
# with a filtered environment); it must succeed silently so the host-side
# apply path can run.
LAUNCHES="$TEST_ROOT/dsh-launches.log"
cat > "$TEST_BIN/dsh" <<EOF
#!/usr/bin/env zsh
print -- dsh >> "$LAUNCHES"
exit 0
EOF
chmod +x "$TEST_BIN/dsh"

# An idle session that an enabled sync would deliver.
idle_session() {
  local home="$1"
  mkdir -p "$home/sessions/--Users-me-project--/0d611b15"
  print -r -- '{"type":"user/message","data":{"content":[{"type":"text","text":"synthetic"}]}}' \
    > "$home/sessions/--Users-me-project--/0d611b15/session.v4.jsonl.zstd"
  touch -t 200001010001 "$home/sessions/--Users-me-project--/0d611b15/session.v4.jsonl.zstd"
}

DISABLED_PROJECT="$TEST_ROOT/disabled-project"
DISABLED_HOME="$DISABLED_PROJECT/.dsh"
make_fake_integration "$DISABLED_PROJECT"
mkdir -p "$DISABLED_HOME/storages/memory"
cat > "$DISABLED_HOME/settings.yaml" <<'YAML'
memory:
  enabled: false
YAML
touch -t 200001010000 "$DISABLED_HOME/storages/memory/.last-sync"
idle_session "$DISABLED_HOME"

env \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  DSH_HOME="$DISABLED_HOME" \
  DSH_MEMORY_SYNC_TEST_LOG="$CALLS" \
  zsh "$DISABLED_PROJECT/integrations/dsh/dsh-memory-sync" >/dev/null
[[ ! -e "$LAUNCHES" && ! -e "$DISABLED_HOME/storages/memory/.test-init" ]] || { print -u2 -- "disabled memory sync still ran"; exit 1; }
[[ -f "$DISABLED_HOME/storages/memory/.last-sync" ]] || { print -u2 -- "disabled memory sync modified the marker"; exit 1; }

# Desktop 0.2: the switch lives in the profile patch written by SettingsForms.
DESKTOP_PROJECT="$TEST_ROOT/desktop-project"
DESKTOP_HOME="$DESKTOP_PROJECT/.dsh"
DESKTOP_CALLS="$TEST_ROOT/desktop-calls.log"
make_fake_integration "$DESKTOP_PROJECT"
mkdir -p "$DESKTOP_HOME/storages/memory" "$DESKTOP_HOME/profiles/desktop"
cat > "$DESKTOP_HOME/profiles/desktop/cordis.patch.yml" <<'YAML'
- id: ui-settings
  config:
    enabled: true
- config:
    enabled: false
  id: memory
  name: dsh-git-memory
YAML
touch -t 200001010000 "$DESKTOP_HOME/storages/memory/.last-sync"
idle_session "$DESKTOP_HOME"
env \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  DSH_HOME="$DESKTOP_HOME" \
  DSH_MEMORY_SYNC_TEST_LOG="$DESKTOP_CALLS" \
  zsh "$DESKTOP_PROJECT/integrations/dsh/dsh-memory-sync" >/dev/null
[[ ! -e "$LAUNCHES" && ! -e "$DESKTOP_HOME/storages/memory/.test-init" ]] || { print -u2 -- "desktop-disabled memory sync still ran"; exit 1; }
# Another entry's enabled:false must not disable memory.
cat > "$DESKTOP_HOME/profiles/desktop/cordis.patch.yml" <<'YAML'
- id: ui-settings
  config:
    enabled: false
- id: memory
  name: dsh-git-memory
  config:
    enabled: true
YAML
env \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  DSH_HOME="$DESKTOP_HOME" \
  DSH_MEMORY_SYNC_TEST_LOG="$DESKTOP_CALLS" \
  zsh "$DESKTOP_PROJECT/integrations/dsh/dsh-memory-sync" >/dev/null 2>&1 || true
grep -qx -- init "$DESKTOP_HOME/storages/memory/.test-init" || { print -u2 -- "another entry's switch disabled memory sync"; exit 1; }

DEFAULT_PROJECT="$TEST_ROOT/default-project"
DEFAULT_HOME="$DEFAULT_PROJECT/.dsh"
DEFAULT_CALLS="$TEST_ROOT/default-calls.log"
make_fake_integration "$DEFAULT_PROJECT"
mkdir -p "$DEFAULT_HOME/storages/memory" "$DEFAULT_HOME/sessions"
DSH_HOME="$DEFAULT_HOME" DSH_MEMORY_ROOT="$DEFAULT_HOME/storages/memory" "$INITIALIZER" >/dev/null
touch -t 200001010000 "$DEFAULT_HOME/storages/memory/.last-sync"
idle_session "$DEFAULT_HOME"

env \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  DSH_HOME="$DEFAULT_HOME" \
  DSH_MEMORY_ROOT="$DEFAULT_HOME/storages/memory" \
  DPSK_MEMORY_SYNC_HELPER="$DEFAULT_PROJECT/integrations/dsh/sync-apply.py" \
  DSH_MEMORY_SYNC_TEST_LOG="$DEFAULT_CALLS" \
  zsh "$DEFAULT_PROJECT/integrations/dsh/dsh-memory-sync" >/dev/null 2>&1 || true
grep -qx -- init "$DEFAULT_HOME/storages/memory/.test-init" || { print -u2 -- "missing setting did not initialize memory"; exit 1; }
grep -qx -- dsh "$LAUNCHES" || { print -u2 -- "missing setting did not preserve the default enabled behavior"; exit 1; }

print -- "dsh-memory disabled sync test passed"
