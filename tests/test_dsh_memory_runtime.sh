#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
HOST="$PROJECT_DIR/packages/dsh-memory/lib/index.js"
PACKAGE="$PROJECT_DIR/packages/dsh-memory/package.json"

grep -Fq -- 'export const DEFAULT_DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));' "$HOST"
grep -Fq -- 'process.env.DSH_MEMORY_ROOT || join(DEFAULT_DSH_HOME, "storages", "memory")' "$HOST"
grep -Fq -- 'export const inject = ["settings"]' "$HOST"
grep -Fq -- 'const scope = ctx.settings.register(NS, Config' "$HOST"
grep -Fq -- 'ctx.inject(["systemPrompt"]' "$HOST"
grep -Fq -- 'new MemoryService(ctx, { settings })' "$HOST"
grep -Fq -- 'Remote("status")' "$HOST"
grep -Fq -- 'Remote("clear")' "$HOST"
grep -Fq -- 'safe-clear.py' "$HOST"
grep -Fq -- 'safeClear(root, "stage")' "$HOST"
grep -Fq -- 'alternateIndex' "$HOST"
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

node -e 'const p=require(process.argv[1]); if (p.private === true || p.exports?.["."] !== "./lib/index.js" || p.type !== "module") process.exit(1)' "$PACKAGE"
node --check "$HOST"
python3 -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$PROJECT_DIR/packages/dsh-memory/lib/safe-clear.py"
print "dsh-memory runtime tests passed"
