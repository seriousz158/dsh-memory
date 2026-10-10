#!/bin/zsh
# Without DSH_BIN or a dsh on PATH, the synchronizer launches the CLI bundled
# inside the desktop app; an explicit DSH_BIN is never second-guessed.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-desktop-bin.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
TEST_DSH_HOME="$TEST_ROOT/dsh-home"
TEST_MEMORY_ROOT="$TEST_ROOT/memory"
APP="$TEST_ROOT/DeepSeek Harness.app"
CLI="$APP/Contents/Resources/runtime/cli/bin/dsh"
mkdir -p "$TEST_DSH_HOME/sessions/--Users-me-project--/0d611b15" "$TEST_ROOT/home" "${CLI:h}"
DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" "$PROJECT_DIR/integrations/dsh/dsh-memory-init" >/dev/null
touch -t 200001010000 "$TEST_MEMORY_ROOT/.last-sync"
SESSION="$TEST_DSH_HOME/sessions/--Users-me-project--/0d611b15/session.v4.jsonl.zstd"
print -r -- '{"type":"user/message","data":{"content":[{"type":"text","text":"synthetic"}]}}' > "$SESSION"
touch -t 200001010001 "$SESSION"
cat > "$CLI" <<'CLI'
#!/bin/zsh
print -r -- "$@" > "$HOME/bundled-cli-invoked"
exit 3
CLI
chmod +x "$CLI"

run_sync() {
  env -i HOME="$TEST_ROOT/home" TMPDIR="$TEST_ROOT" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" "$@" \
    zsh "$PROJECT_DIR/integrations/dsh/dsh-memory-sync" >/dev/null 2>&1
}

# Explicit DSH_BIN that does not exist: fail with 127, never fall back.
set +e
run_sync DSH_BIN=/does-not-exist DSH_APP_BUNDLE="$APP"
code=$?
set -e
[[ "$code" == "127" ]] || { print -u2 -- "expected 127 for explicit missing DSH_BIN, got $code"; exit 1; }
[[ ! -e "$TEST_ROOT/home/bundled-cli-invoked" ]]
# Even a failed run leaves a heartbeat recording its exit code.
/usr/bin/python3 -c 'import json,sys; h=json.load(open(sys.argv[1])); assert h["exit_code"] == 127 and h["candidate_sessions"] == 1, h' "$TEST_MEMORY_ROOT/.sync/heartbeat.json"
git -C "$TEST_MEMORY_ROOT" check-ignore -q .sync/heartbeat.json

# Default: the bundled desktop CLI is launched with the headless profile.
set +e
run_sync DSH_APP_BUNDLE="$APP"
set -e
[[ -f "$TEST_ROOT/home/bundled-cli-invoked" ]] || { print -u2 -- "bundled desktop CLI was not invoked"; exit 1; }
grep -q -- '--profile headless' "$TEST_ROOT/home/bundled-cli-invoked"

# Scan-only stays side-effect free: no heartbeat rewrite.
rm -f -- "$TEST_MEMORY_ROOT/.sync/heartbeat.json"
env -i HOME="$TEST_ROOT/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  zsh "$PROJECT_DIR/integrations/dsh/dsh-memory-sync" --scan-only --json >/dev/null
[[ ! -e "$TEST_MEMORY_ROOT/.sync/heartbeat.json" ]]
print "dsh-memory sync desktop CLI resolution tests passed"
