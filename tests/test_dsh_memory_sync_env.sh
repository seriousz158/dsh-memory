#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SYNC_SOURCE="$PROJECT_DIR/integrations/dsh/dsh-memory-sync"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-sync-env.XXXXXX")"
TEST_INTEGRATION="$TEST_ROOT/integrations/dsh"
TEST_HOME="$TEST_ROOT/home"
TEST_DSH_HOME="$TEST_ROOT/dsh-home"
TEST_MEMORY_ROOT="$TEST_ROOT/memory"
TEST_BIN="$TEST_ROOT/bin"
ENV_NAMES="$TEST_ROOT/child-env-names.txt"

mkdir -p "$TEST_INTEGRATION" "$TEST_HOME" "$TEST_DSH_HOME/sessions" "$TEST_MEMORY_ROOT" "$TEST_BIN"
cp "$SYNC_SOURCE" "$TEST_INTEGRATION/dsh-memory-sync"
chmod +x "$TEST_INTEGRATION/dsh-memory-sync"
cp "$PROJECT_DIR/packages/dsh-memory/lib/sync-apply.py" "$TEST_INTEGRATION/sync-apply.py"

# Initialize a real memory repository so stage-copy and apply have a live root.
DSH_HOME="$TEST_DSH_HOME" DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" "$INITIALIZER" >/dev/null
# Exercise the incremental path with one session that is newer than the
# watermark but has been idle for more than one hour.
touch -t 200001010000 "$TEST_MEMORY_ROOT/.last-sync"
: > "$TEST_DSH_HOME/sessions/session.jsonl.zstd"
touch -t 200001010001 "$TEST_DSH_HOME/sessions/session.jsonl.zstd"

cat > "$TEST_INTEGRATION/dsh-memory-init" <<'EOF'
#!/bin/zsh
set -euo pipefail
mkdir -p "${DSH_MEMORY_ROOT:?}"
/usr/bin/env | /usr/bin/sed 's/=.*//' | /usr/bin/sort > "$DSH_MEMORY_ROOT/initializer-env-names.txt"
EOF
chmod +x "$TEST_INTEGRATION/dsh-memory-init"

cat > "$TEST_BIN/fake-dsh" <<'EOF'
#!/bin/zsh
set -euo pipefail
[[ "$#" -eq 5 && "$1" == "--profile" && "$2" == "headless" && "$3" == "--patch" && -f "$4" && -n "$5" ]]
grep -q -- '^- id: session-persistence-jsonl$' "$4"
grep -q -- 'headless-sessions' "$4"
[[ "$4" != "$DSH_HOME/sessions" ]]
PRIVATE_SESSION_ROOT="$(/usr/bin/awk '/^[[:space:]]*root:/{print $2; exit}' "$4")"
mkdir -p "$PRIVATE_SESSION_ROOT"
: > "$PRIVATE_SESSION_ROOT/session.jsonl.zstd"
print -r -- "$PRIVATE_SESSION_ROOT" > "$HOME/private-session-root.txt"
[[ "${DSH_PERMISSION_MODE:-}" == "workspace-write" ]]
# Simulate a model edit inside the staging worktree (the sync cds into staging).
printf 'synthetic memory entry\n' > handbook/synthetic-entry.md
/usr/bin/env | /usr/bin/sed 's/=.*//' | /usr/bin/sort
EOF
chmod +x "$TEST_BIN/fake-dsh"

env \
  HOME="$TEST_HOME" \
  DSH_HOME="$TEST_DSH_HOME" \
  DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  DSH_BIN="$TEST_BIN/fake-dsh" \
  DPSK_MEMORY_SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py" \
  DSH_MEMORY_PROVIDER_ENV_NAMES="ALLOWED_PROVIDER_TOKEN" \
  ALLOWED_PROVIDER_TOKEN="synthetic-allowed-value" \
  OPENAI_API_KEY="synthetic-openai-value" \
  ANTHROPIC_API_KEY="synthetic-anthropic-value" \
  CODEX_AUTH_TOKEN="synthetic-codex-value" \
  MCP_SYNTHETIC_TOKEN="synthetic-mcp-value" \
  UNRELATED_CREDENTIAL="synthetic-unrelated-value" \
  LC_SYNTHETIC="names-only" \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  zsh "$TEST_INTEGRATION/dsh-memory-sync" > "$ENV_NAMES"

PRIVATE_SESSION_ROOT="$(cat "$TEST_HOME/private-session-root.txt")"
[[ "$PRIVATE_SESSION_ROOT" != "$TEST_DSH_HOME/sessions" ]]
[[ ! -e "$PRIVATE_SESSION_ROOT" ]]

for allowed_name in \
  HOME DSH_HOME DSH_MEMORY_ROOT PATH TMPDIR LANG LC_SYNTHETIC \
  DSH_PERMISSION_MODE DSH_TELEMETRY_DISABLED ALLOWED_PROVIDER_TOKEN; do
  grep -qx -- "$allowed_name" "$ENV_NAMES" || {
    print -u2 -- "expected child environment name missing: $allowed_name"
    exit 1
  }
done

INITIALIZER_ENV_NAMES="$TEST_MEMORY_ROOT/initializer-env-names.txt"
for allowed_name in HOME DSH_HOME DSH_MEMORY_ROOT PATH TMPDIR LANG LC_SYNTHETIC; do
  grep -qx -- "$allowed_name" "$INITIALIZER_ENV_NAMES" || {
    print -u2 -- "expected initializer environment name missing: $allowed_name"
    exit 1
  }
done

for forbidden_name in \
  DSH_BIN DSH_MEMORY_PROVIDER_ENV_NAMES DSH_PERMISSION_MODE DSH_TELEMETRY_DISABLED \
  ALLOWED_PROVIDER_TOKEN OPENAI_API_KEY ANTHROPIC_API_KEY CODEX_AUTH_TOKEN \
  MCP_SYNTHETIC_TOKEN UNRELATED_CREDENTIAL; do
  if grep -qx -- "$forbidden_name" "$INITIALIZER_ENV_NAMES"; then
    print -u2 -- "unexpected initializer environment name inherited: $forbidden_name"
    exit 1
  fi
done

for forbidden_name in \
  DSH_BIN DSH_MEMORY_PROVIDER_ENV_NAMES OPENAI_API_KEY ANTHROPIC_API_KEY \
  CODEX_AUTH_TOKEN MCP_SYNTHETIC_TOKEN UNRELATED_CREDENTIAL; do
  if grep -qx -- "$forbidden_name" "$ENV_NAMES"; then
    print -u2 -- "unexpected child environment name inherited: $forbidden_name"
    exit 1
  fi
done

# launchd supplies a minimal PATH. The sync wrapper must still be able to run
# a standard `#!/usr/bin/env node` DSH launcher by discovering Homebrew/nvm
# Node, without requiring a shell profile to be sourced.
NODE_SHEBANG_DSH="$TEST_BIN/node-shebang-dsh"
cat > "$NODE_SHEBANG_DSH" <<'EOF'
#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("handbook/node-launchd-entry.md", "synthetic node launchd entry\n");
EOF
chmod +x "$NODE_SHEBANG_DSH"
touch -t 200001010000 "$TEST_MEMORY_ROOT/.last-sync"
touch -t 200001010001 "$TEST_DSH_HOME/sessions/session.jsonl.zstd"
env \
  HOME="$TEST_HOME" \
  DSH_HOME="$TEST_DSH_HOME" \
  DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  DSH_BIN="$NODE_SHEBANG_DSH" \
  DPSK_MEMORY_SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  zsh "$TEST_INTEGRATION/dsh-memory-sync" >/dev/null
[[ -f "$TEST_MEMORY_ROOT/handbook/node-launchd-entry.md" ]] || {
  print -u2 -- "minimal PATH node shebang launcher did not apply"
  exit 1
}

/usr/bin/python3 - "$TEST_MEMORY_ROOT/.sync/runs" <<'PY'
import json
import pathlib
import sys

run_files = sorted(pathlib.Path(sys.argv[1]).glob("*.json"))
assert len(run_files) >= 2, run_files
record = json.loads(run_files[0].read_text())
assert record["candidate_sessions"] == 1, record
assert record["processed_sessions"] == 1, record
assert record["skipped_sessions"] == 0, record
PY

MISSING_STDERR="$TEST_ROOT/missing-dsh.stderr"
# Remove the marker so the first-run path reaches the DSH executable check.
rm -f "$TEST_MEMORY_ROOT/.last-sync"
if env \
  HOME="$TEST_HOME" \
  DSH_HOME="$TEST_DSH_HOME" \
  DSH_MEMORY_ROOT="$TEST_MEMORY_ROOT" \
  DSH_BIN="$TEST_BIN/does-not-exist" \
  DPSK_MEMORY_SYNC_HELPER="$TEST_INTEGRATION/sync-apply.py" \
  PATH="$TEST_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
  zsh "$TEST_INTEGRATION/dsh-memory-sync" >/dev/null 2>"$MISSING_STDERR"; then
  print -u2 -- "missing DSH_BIN unexpectedly succeeded"
  exit 1
fi
grep -q -- "DSH executable not found" "$MISSING_STDERR"

if grep -q -- "npx --yes" "$SYNC_SOURCE"; then
  print -u2 -- "sync helper still contains silent npx installation"
  exit 1
fi

print -- "dsh-memory sync environment test passed"
