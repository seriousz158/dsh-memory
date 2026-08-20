#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
CLIENT="$PROJECT_DIR/packages/dsh-memory-ui/lib/client.js"
PACKAGE="$PROJECT_DIR/packages/dsh-memory-ui/package.json"

grep -Fq -- 'ctx.remote.$mount(remote)' "$CLIENT"
grep -Fq -- 'ctx.inject(["remote.memory"], (memoryCtx) => {' "$CLIENT"
grep -Fq -- 'const memory = memoryCtx.remote.memory;' "$CLIENT"
grep -Fq -- 'const operationResult = (value) => {' "$CLIENT"
grep -Fq -- 'memory.getSettings()' "$CLIENT"
grep -Fq -- 'memory.setEnabled({ enabled: value })' "$CLIENT"
grep -Fq -- 'memory.status()' "$CLIENT"
grep -Fq -- 'memory.clear({ confirmation: "DELETE_MEMORY" })' "$CLIENT"
grep -Fq -- 'stage === 2 && phrase !== "删除记忆"' "$CLIENT"
grep -Fq -- 'className: "dshmu_title", children: "记忆管理"' "$CLIENT"
grep -Fq -- '~/.dsh/storages/memory' "$CLIENT"
if rg -q -- '~?/?\.zcode/memory|DSH_MEMORY_ROOT|memoryRoot|rootPath' "$CLIENT"; then
  print -u2 -- 'dsh-memory-ui must not expose a legacy or browser-selected memory path.'
  exit 1
fi
node -e '
const p=require(process.argv[1]);
const peers=["@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-settings","react"];
if (p.private !== true || p.version !== "0.3.1" || p.exports?.["./client"] !== "./lib/client.js" || p.main !== "./lib/index.js" || peers.some((name) => !p.peerDependencies?.[name])) process.exit(1);
' "$PACKAGE"
node --check "$CLIENT"
print "dsh-memory UI settings row tests passed"
