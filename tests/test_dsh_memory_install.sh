#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
INSTALLER="$PROJECT_DIR/integrations/dsh/install.sh"
PLIST="$PROJECT_DIR/integrations/dsh/dsh-memory-sync.plist.example"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-install.XXXXXX")"
TEST_DSH_HOME="$TEST_ROOT/.dsh"
PATCH_FILE="$TEST_DSH_HOME/cordis.patch.yml"
MEMORY_SENTINEL="$TEST_DSH_HOME/storages/memory/sentinel"

mkdir -p "$TEST_DSH_HOME/storages/memory"
print 'do not remove' > "$MEMORY_SENTINEL"
cat > "$PATCH_FILE" <<'YAML'
# unrelated entries and comments must survive byte-for-byte.
- id: agent-instructions
  disabled: false
- insert:
    - id: other
      name: other-package
      config:
        enabled: true
- id: tail-plugin
  disabled: false
YAML

first_output="$(DSH_HOME="$TEST_DSH_HOME" "$INSTALLER")"
first_checksum="$(shasum -a 256 "$PATCH_FILE" | awk '{print $1}')"
second_output="$(DSH_HOME="$TEST_DSH_HOME" "$INSTALLER")"
second_checksum="$(shasum -a 256 "$PATCH_FILE" | awk '{print $1}')"

test "$first_output" = "$second_output"
test "$first_checksum" = "$second_checksum"
test -f "$MEMORY_SENTINEL"

for package in dsh-memory dsh-memory-ui; do
  link="$TEST_DSH_HOME/profiles/node_modules/$package"
  test -L "$link"
  test "$(cd -P -- "$link" && pwd -P)" = "$PROJECT_DIR/packages/$package"
done
test "$(find "$TEST_DSH_HOME/profiles/node_modules" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')" = "2"

node - "$TEST_DSH_HOME/profiles" "$PROJECT_DIR" <<'NODE'
const { createRequire } = require("node:module");
const path = require("node:path");
const [profiles, project] = process.argv.slice(2);
const fromProfiles = createRequire(path.join(profiles, "install-smoke.cjs"));
if (fromProfiles.resolve("dsh-memory") !== path.join(project, "packages/dsh-memory/lib/index.js")) process.exit(1);
if (fromProfiles.resolve("dsh-memory-ui/client") !== path.join(project, "packages/dsh-memory-ui/lib/client.js")) process.exit(1);
NODE

grep -Fq -- '# unrelated entries and comments must survive byte-for-byte.' "$PATCH_FILE"
grep -Fq -- 'name: other-package' "$PATCH_FILE"
grep -Fq -- 'id: tail-plugin' "$PATCH_FILE"
test "$(grep -c -- '^[[:space:]]*- id: memory$' "$PATCH_FILE")" = "1"
test "$(grep -c -- '^[[:space:]]*- id: ui-memory$' "$PATCH_FILE")" = "1"
test "$(grep -c -- '^[[:space:]]*name: dsh-memory$' "$PATCH_FILE")" = "1"
test "$(grep -c -- '^[[:space:]]*name: dsh-memory-ui$' "$PATCH_FILE")" = "1"

EMPTY_HOME="$TEST_ROOT/empty-home/.dsh"
mkdir -p "$EMPTY_HOME"
print '[]' > "$EMPTY_HOME/cordis.patch.yml"
DSH_HOME="$EMPTY_HOME" "$INSTALLER" >/dev/null
grep -Fq -- 'id: memory' "$EMPTY_HOME/cordis.patch.yml"
grep -Fq -- 'id: ui-memory' "$EMPTY_HOME/cordis.patch.yml"

UNSAFE_HOME="$TEST_ROOT/unsafe-home/.dsh"
mkdir -p "$UNSAFE_HOME/profiles/node_modules"
ln -s "$TEST_ROOT" "$UNSAFE_HOME/profiles/node_modules/dsh-memory"
if DSH_HOME="$UNSAFE_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer accepted an unexpected external package link'
  exit 1
fi
TEST_ROOT_REAL="$(cd -P -- "$TEST_ROOT" && pwd -P)"
test "$(cd -P -- "$UNSAFE_HOME/profiles/node_modules/dsh-memory" && pwd -P)" = "$TEST_ROOT_REAL"

plutil -lint "$PLIST" >/dev/null
grep -Fq -- '<string>dev.dsh.memory-sync</string>' "$PLIST"
grep -Fq -- '<string>-lc</string>' "$PLIST"
grep -Fq -- '$HOME/.local/share/dsh-memory/integrations/dsh/dsh-memory-sync' "$PLIST"
grep -Fq -- '$HOME/.local/share/dsh-memory/logs/memory-sync.log' "$PLIST"
if rg -q -- '/Users/|com\.zjhmacair|deepseek-harness' "$PLIST"; then
  print -u2 -- 'LaunchAgent example contains a source-checkout-specific path'
  exit 1
fi

print "dsh-memory installer tests passed"
