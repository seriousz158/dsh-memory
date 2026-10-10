#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
HOST="$PROJECT_DIR/packages/dsh-memory/lib/index.js"
PACKAGE="$PROJECT_DIR/packages/dsh-memory/package.json"

# Forbidden-pattern guard: POSIX grep -E is always present (CI runners lack
# rg). Exit 1 means "no match"; any other non-zero status is a grep error and
# must fail the test instead of silently passing the guard.
forbid_pattern() {
  local pattern="$1" message="$2" rc=0
  grep -Eq -- "$pattern" "$HOST" || rc=$?
  if (( rc == 0 )); then
    print -u2 -- "$message"
    exit 1
  elif (( rc != 1 )); then
    print -u2 -- "dsh-memory runtime: grep failed ($rc) for pattern: $pattern"
    exit 1
  fi
}

# Behavioral module contract instead of exact source text: refactors that keep
# the exported surface intact must not break this test.
DSH_HOME=/nonexistent-dsh-home DSH_MEMORY_ROOT= node --input-type=module -e '
const host = await import(process.argv[1]);
const fail = (message) => { console.error("dsh-memory runtime: " + message); process.exit(1); };
if (host.DEFAULT_DSH_HOME !== "/nonexistent-dsh-home") fail("DEFAULT_DSH_HOME must honor DSH_HOME");
if (host.DEFAULT_MEMORY_ROOT !== "/nonexistent-dsh-home/storages/memory") fail("memory root must default under DSH_HOME");
if (JSON.stringify(host.inject) !== JSON.stringify(["tools"])) fail("tools must be the only required seam");
if (typeof host.apply !== "function" || typeof host.Config !== "function") fail("apply and Config must be exported");
if (typeof host.createSettingsSource !== "function") fail("createSettingsSource must be exported");
if (host.Config({}).enabled !== true && host.Config({}).enabled?.get?.() !== true) fail("memory.enabled must default to true");
const remotes = ["getSettings", "setEnabled", "status", "health", "clear", "runs", "rollback", "previews", "applyPreview", "discardPreview", "search", "context"];
for (const name of remotes) if (typeof host.MemoryService.prototype[name] !== "function") fail("missing remote " + name);
' "$HOST"

# Prompt and clear-path invariants that are not observable through exports.
grep -Fq -- 'interpolate: false' "$HOST"
grep -Fq -- 'UNTRUSTED CONTEXT' "$HOST"
grep -Fq -- 'SUMMARY_INJECT_MAX_BYTES' "$HOST"
grep -Fq -- 'safe-clear.py' "$HOST"
grep -Fq -- 'unsafe-layout' "$HOST"
grep -Fq -- 'checkpoint-failed' "$HOST"
forbid_pattern '\.zcode|browser(Path|Root)|request\.(path|root)|request\["(path|root)"\]' \
  'dsh-memory host exposes a forbidden legacy or browser-selected path.'
forbid_pattern 'git\(\["(rm|restore)' \
  'dsh-memory clear must not mutate the working tree through git rm or git restore.'


node -e '
const p=require(process.argv[1]);
const peers=["@deepseek-ai/dsh-settings","@deepseek-ai/dsh-typert-protocol","@deepseek-ai/dsh-tools","@deepseek-ai/schemastery"];
if (p.private !== true || typeof p.version !== "string" || p.version.length === 0 || p.exports?.["."] !== "./lib/index.js" || p.type !== "module" || peers.some((name) => !p.peerDependencies?.[name])) process.exit(1);
' "$PACKAGE"
node --check "$HOST"
for script in safe-clear.py sync-apply.py; do
  python3 -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$PROJECT_DIR/packages/dsh-memory/lib/$script"
done
print "dsh-memory runtime tests passed"
