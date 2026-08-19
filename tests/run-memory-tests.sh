#!/bin/zsh

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  print -u2 -- 'memory tests: not inside a Git repository'
  exit 2
}
cd "$repo_root"

node tests/test_dsh_memory_repository.mjs
node tests/test_dsh_memory_sync_transaction.mjs
node tests/test_dsh_memory_metadata.mjs
node tests/test_dsh_memory_paths.mjs
node tests/test_dsh_memory_redaction.mjs
zsh tests/test_dsh_memory_runtime.sh
zsh tests/test_dsh_memory_ui_settings_row.sh
zsh tests/test_dsh_memory_init.sh
zsh tests/test_dsh_memory_install.sh
zsh tests/test_dsh_memory_sync_disabled.sh
zsh tests/test_dsh_memory_sync_env.sh
zsh tests/test_dsh_memory_sync_dry_run.sh
zsh tests/test_dsh_memory_migrate.sh
