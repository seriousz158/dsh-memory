#!/bin/zsh

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  print -u2 -- 'memory tests: not inside a Git repository'
  exit 2
}
cd "$repo_root"

node tests/test_dsh_memory_repository.mjs
node tests/test_dsh_memory_migration_api.mjs
node tests/test_dsh_memory_sync_transaction.mjs
node tests/test_dsh_memory_operation_lock.mjs
node tests/test_dsh_memory_metadata.mjs
node tests/test_dsh_memory_usage.mjs
node tests/test_dsh_memory_context.mjs
node tests/test_dsh_memory_tools.mjs
node tests/test_dsh_memory_marketplace.mjs
python3 tests/test_dsh_memory_sync_failures.py
node tests/test_dsh_memory_paths.mjs
node tests/test_dsh_memory_preview.mjs
node tests/test_dsh_memory_redaction.mjs
zsh tests/test_dsh_memory_runtime.sh
zsh tests/test_dsh_memory_ui_settings_row.sh
zsh tests/test_dsh_memory_init.sh
zsh tests/test_dsh_memory_install.sh
zsh tests/test_dsh_memory_sync_disabled.sh
zsh tests/test_dsh_memory_sync_env.sh
zsh tests/test_dsh_memory_sync_dry_run.sh
zsh tests/test_dsh_memory_sync_lock.sh
zsh tests/test_dsh_memory_sync_preview.sh
zsh tests/test_dsh_memory_sync_no_change.sh
zsh tests/test_dsh_memory_backup.sh
zsh tests/test_dsh_memory_migrate.sh

# Browser E2E against an isolated DSH profile. Requires the Python Playwright
# installation used for browser acceptance; skipped (exit 0) when unavailable.
if command -v python3 >/dev/null 2>&1; then
  python3 tests/test_dsh_memory_e2e_ui.py
else
  print -u2 -- "dsh-memory e2e: python3 unavailable; skipping"
fi
