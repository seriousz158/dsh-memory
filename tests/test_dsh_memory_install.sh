#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
INSTALLER="$PROJECT_DIR/integrations/dsh/install.sh"
INITIALIZER="$PROJECT_DIR/integrations/dsh/dsh-memory-init"
PLIST="$PROJECT_DIR/integrations/dsh/dsh-memory-sync.plist.example"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-memory-install.XXXXXX")"
TEST_DSH_HOME="$TEST_ROOT/.dsh"
PATCH_FILE="$TEST_DSH_HOME/cordis.patch.yml"
MEMORY_SENTINEL="$TEST_DSH_HOME/storages/memory/sentinel"

DSH_HOME="$TEST_DSH_HOME" "$INITIALIZER" >/dev/null
MEMORY_HEAD_BEFORE="$(git -C "$TEST_DSH_HOME/storages/memory" rev-parse HEAD)"
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
test "$(git -C "$TEST_DSH_HOME/storages/memory" rev-parse HEAD)" = "$MEMORY_HEAD_BEFORE"

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
test -d "$EMPTY_HOME/storages/memory/.git"

TWO_SPACE_HOME="$TEST_ROOT/two-space-home/.dsh"
mkdir -p "$TWO_SPACE_HOME"
cat > "$TWO_SPACE_HOME/cordis.patch.yml" <<'YAML'
- insert:
  - id: other
    name: other-package
YAML
DSH_HOME="$TWO_SPACE_HOME" "$INSTALLER" >/dev/null
test "$(grep -c -- '^  - id: memory$' "$TWO_SPACE_HOME/cordis.patch.yml")" = "1"
test "$(grep -c -- '^  - id: ui-memory$' "$TWO_SPACE_HOME/cordis.patch.yml")" = "1"
test "$(grep -c -- '^    name: dsh-memory$' "$TWO_SPACE_HOME/cordis.patch.yml")" = "1"
test "$(grep -c -- '^    name: dsh-memory-ui$' "$TWO_SPACE_HOME/cordis.patch.yml")" = "1"
if grep -q -- '^    - id: memory$' "$TWO_SPACE_HOME/cordis.patch.yml"; then
  print -u2 -- 'installer changed a two-space Cordis insert list to a mixed indentation layout'
  exit 1
fi

NESTED_HOME="$TEST_ROOT/nested-home/.dsh"
mkdir -p "$NESTED_HOME"
cat > "$NESTED_HOME/cordis.patch.yml" <<'YAML'
- id: other-plugin
  name: other-package
  config:
    nestedOperations:
      - insert:
          - id: nested-only
            name: nested-package
YAML
DSH_HOME="$NESTED_HOME" "$INSTALLER" >/dev/null
node - "$NESTED_HOME/cordis.patch.yml" <<'NODE'
const fs = require("node:fs");
const yaml = require("js-yaml");
const document = yaml.load(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(document)) process.exit(1);
const rootEntries = document.flatMap((operation) => Array.isArray(operation?.insert) ? operation.insert : []);
for (const [id, name] of [["memory", "dsh-memory"], ["ui-memory", "dsh-memory-ui"]]) {
  if (rootEntries.filter((entry) => entry?.id === id && entry?.name === name).length !== 1) process.exit(1);
}
const nested = document[0]?.config?.nestedOperations?.[0]?.insert ?? [];
if (nested.some((entry) => entry?.id === "memory" || entry?.id === "ui-memory")) process.exit(1);
NODE

INVALID_HOME="$TEST_ROOT/invalid-home/.dsh"
mkdir -p "$INVALID_HOME"
print 'root: mapping' > "$INVALID_HOME/cordis.patch.yml"
if DSH_HOME="$INVALID_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer accepted a non-list Cordis patch root'
  exit 1
fi
test ! -e "$INVALID_HOME/profiles/node_modules/dsh-memory"
test ! -e "$INVALID_HOME/profiles/node_modules/dsh-memory-ui"
test ! -e "$INVALID_HOME/storages/memory"

UNSAFE_HOME="$TEST_ROOT/unsafe-home/.dsh"
mkdir -p "$UNSAFE_HOME/profiles/node_modules"
ln -s "$TEST_ROOT" "$UNSAFE_HOME/profiles/node_modules/dsh-memory"
if DSH_HOME="$UNSAFE_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer accepted an unexpected external package link'
  exit 1
fi
TEST_ROOT_REAL="$(cd -P -- "$TEST_ROOT" && pwd -P)"
test "$(cd -P -- "$UNSAFE_HOME/profiles/node_modules/dsh-memory" && pwd -P)" = "$TEST_ROOT_REAL"

PARTIAL_HOME="$TEST_ROOT/partial-home/.dsh"
PARTIAL_CONFLICT="$TEST_ROOT/partial-conflict"
PARTIAL_STDERR="$TEST_ROOT/partial-install.stderr"
mkdir -p "$PARTIAL_HOME/profiles/node_modules" "$PARTIAL_CONFLICT"
ln -s "$PARTIAL_CONFLICT" "$PARTIAL_HOME/profiles/node_modules/dsh-memory-ui"
if DSH_HOME="$PARTIAL_HOME" "$INSTALLER" >/dev/null 2>"$PARTIAL_STDERR"; then
  print -u2 -- 'installer accepted an unexpected second package link'
  exit 1
fi
test ! -e "$PARTIAL_HOME/storages/memory"
test ! -e "$PARTIAL_HOME/profiles/node_modules/dsh-memory"
test -L "$PARTIAL_HOME/profiles/node_modules/dsh-memory-ui"
test "$(cd -P -- "$PARTIAL_HOME/profiles/node_modules/dsh-memory-ui" && pwd -P)" = "$(cd -P -- "$PARTIAL_CONFLICT" && pwd -P)"
if find "$PARTIAL_HOME" -name '.cordis.patch.yml.tmp-*' -print -quit | grep -q .; then
  print -u2 -- 'installer left a temporary Cordis patch after link preflight failed'
  exit 1
fi
if grep -q -- 'read-only variable: status' "$PARTIAL_STDERR"; then
  print -u2 -- 'installer cleanup trap failed after link preflight failed'
  exit 1
fi

PARENT_SYMLINK_HOME="$TEST_ROOT/parent-symlink-home/.dsh"
PARENT_SYMLINK_TARGET="$TEST_ROOT/outside-profiles"
mkdir -p "$PARENT_SYMLINK_HOME" "$PARENT_SYMLINK_TARGET"
ln -s "$PARENT_SYMLINK_TARGET" "$PARENT_SYMLINK_HOME/profiles"
if DSH_HOME="$PARENT_SYMLINK_HOME" "$INSTALLER" >/dev/null 2>&1; then
  print -u2 -- 'installer followed a profiles parent symlink outside DSH_HOME'
  exit 1
fi
test ! -e "$PARENT_SYMLINK_TARGET/node_modules/dsh-memory"
test ! -e "$PARENT_SYMLINK_TARGET/node_modules/dsh-memory-ui"

plutil -lint "$PLIST" >/dev/null
grep -Fq -- '<string>dev.dsh.memory-sync</string>' "$PLIST"
grep -Fq -- '<string>-lc</string>' "$PLIST"
grep -Fq -- 'DSH_HOME="$HOME/.dsh" DSH_MEMORY_ROOT="$HOME/.dsh/storages/memory" exec' "$PLIST"
grep -Fq -- '$HOME/.local/share/dsh-memory/integrations/dsh/dsh-memory-sync' "$PLIST"
grep -Fq -- '$HOME/.local/share/dsh-memory/logs/memory-sync.log' "$PLIST"
if rg -q -- '/Users/|com\.zjhmacair|deepseek-harness' "$PLIST"; then
  print -u2 -- 'LaunchAgent example contains a source-checkout-specific path'
  exit 1
fi

print "dsh-memory installer tests passed"
