#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
exec node "$SCRIPT_DIR/secret-scan.mjs"
