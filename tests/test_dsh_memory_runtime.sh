#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
HOST="$PROJECT_DIR/packages/dsh-memory/lib/index.js"
PACKAGE="$PROJECT_DIR/packages/dsh-memory/package.json"

command -v rg >/dev/null 2>&1 || { print -u2 -- 'dsh-memory runtime tests require rg'; exit 1; }

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
if rg -q -- '\.zcode|browser(?:Path|Root)|request\.(?:path|root)|request\["(?:path|root)"\]' "$HOST"; then
  print -u2 -- 'dsh-memory host exposes a forbidden legacy or browser-selected path.'
  exit 1
fi
if rg -q -- 'git\(\["(rm|restore)' "$HOST"; then
  print -u2 -- 'dsh-memory clear must not mutate the working tree through git rm or git restore.'
  exit 1
fi

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
