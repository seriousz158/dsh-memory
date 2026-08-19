#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")/../tools" && pwd -P)"
exec node "$SCRIPT_DIR/public-tree-check.mjs"
