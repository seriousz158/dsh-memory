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
# Force the first-run path: no marker means the sync proceeds to DSH directly.
rm -f "$TEST_MEMORY_ROOT/.last-sync"

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
[[ "$#" -eq 3 && "$1" == "--profile" && "$2" == "headless" && -n "$3" ]]
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
