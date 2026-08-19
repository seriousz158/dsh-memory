#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

die() {
  print -u2 -- "dsh-memory install: $*"
  exit 1
}

[[ "$DSH_HOME" = /* ]] || die "DSH_HOME must be an absolute path"
[[ ! -L "$DSH_HOME" ]] || die "refusing a symlink DSH_HOME"
command -v node >/dev/null 2>&1 || die "Node.js is required"

umask 077
mkdir -p "$DSH_HOME"
[[ -d "$DSH_HOME" && ! -L "$DSH_HOME" ]] || die "refusing a non-directory or symlink DSH_HOME"
DSH_HOME_REAL="$(cd -- "$DSH_HOME" && pwd -P)"

ensure_child_directory() {
  local parent="$1"
  local child_name="$2"
  local child="$parent/$child_name"
  local parent_real
  local child_real

  [[ -d "$parent" && ! -L "$parent" ]] || die "refusing a non-directory or symlink parent: $parent"
  if [[ -e "$child" || -L "$child" ]]; then
    [[ -d "$child" && ! -L "$child" ]] || die "refusing a non-directory or symlink directory: $child"
  else
    mkdir "$child"
  fi
  parent_real="$(cd -- "$parent" && pwd -P)"
  child_real="$(cd -- "$child" && pwd -P)"
  [[ "$child_real" == "$parent_real/$child_name" ]] || die "refusing directory outside DSH_HOME: $child"
}

ensure_child_directory "$DSH_HOME_REAL" profiles
ensure_child_directory "$DSH_HOME_REAL/profiles" node_modules
PROFILE_NODE_MODULES="$DSH_HOME_REAL/profiles/node_modules"
PATCH_FILE="$DSH_HOME_REAL/cordis.patch.yml"
[[ ! -L "$PATCH_FILE" ]] || die "refusing a symlink cordis.patch.yml"

package_real_path() {
  local package_name="$1"
  local package_path="$REPOSITORY_ROOT/packages/$package_name"
  local package_real

  [[ -f "$package_path/package.json" ]] || die "package is missing: $package_path"
  package_real="$(cd -- "$package_path" && pwd -P)"
  case "$package_real" in
    "$REPOSITORY_ROOT"/*) ;;
    *) die "refusing package target outside repository: $package_path" ;;
  esac
  print -r -- "$package_real"
}

preflight_package_link() {
  local package_name="$1"
  local package_real="$(package_real_path "$package_name")"
  local link_path="$PROFILE_NODE_MODULES/$package_name"

  if [[ -L "$link_path" ]]; then
    local raw_target="$(readlink "$link_path")"
    local resolved_target
    if [[ "$raw_target" = /* ]]; then
      [[ -d "$raw_target" ]] || die "refusing dangling package link: $link_path"
      resolved_target="$(cd -- "$raw_target" && pwd -P)"
    else
      [[ -d "$(dirname -- "$link_path")/$raw_target" ]] || die "refusing dangling package link: $link_path"
      resolved_target="$(cd -- "$(dirname -- "$link_path")/$raw_target" && pwd -P)"
    fi
    [[ "$resolved_target" == "$package_real" ]] || die "refusing unexpected package link: $link_path"
    return
  fi

  [[ ! -e "$link_path" ]] || die "refusing to replace existing path: $link_path"
}

typeset -a CREATED_PACKAGE_LINKS
CREATED_PACKAGE_LINKS=()

ensure_package_link() {
  local package_name="$1"
  local package_real="$(package_real_path "$package_name")"
  local link_path="$PROFILE_NODE_MODULES/$package_name"

  preflight_package_link "$package_name"
  [[ -L "$link_path" ]] && return
  ln -s "$package_real" "$link_path"
  CREATED_PACKAGE_LINKS+=("$link_path")
}

preflight_package_link dsh-memory
preflight_package_link dsh-memory-ui

PATCH_TEMP="$DSH_HOME_REAL/.cordis.patch.yml.tmp-$$-${RANDOM}"
[[ ! -e "$PATCH_TEMP" && ! -L "$PATCH_TEMP" ]] || die "could not reserve Cordis patch temporary path"

cleanup_install() {
  local exit_code="$1"
  local link_path

  if (( exit_code != 0 )); then
    for link_path in "${CREATED_PACKAGE_LINKS[@]}"; do
      [[ -L "$link_path" ]] && rm -f -- "$link_path"
    done
  fi
  if [[ -n "${PATCH_TEMP:-}" && ( -e "$PATCH_TEMP" || -L "$PATCH_TEMP" ) ]]; then
    rm -f -- "$PATCH_TEMP"
  fi
  return "$exit_code"
}
trap 'cleanup_install $?' EXIT

node - "$PATCH_FILE" "$PATCH_TEMP" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const patchPath = process.argv[2];
const temporaryPath = process.argv[3];
const targets = [
  { id: "memory", name: "dsh-memory" },
  { id: "ui-memory", name: "dsh-memory-ui" },
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rootInsertEntries(document) {
  return document.flatMap((operation) => (
    isPlainObject(operation) && Array.isArray(operation.insert) ? operation.insert : []
  ));
}

function validateDocument(document) {
  if (!Array.isArray(document)) throw new Error("Cordis patch must have a sequence root");
  for (const operation of document) {
    if (isPlainObject(operation) && Object.hasOwn(operation, "insert") && !Array.isArray(operation.insert)) {
      throw new Error("Cordis root insert operation must contain a sequence");
    }
  }
  const entries = rootInsertEntries(document);
  for (const target of targets) {
    const matchingIds = entries.filter((entry) => isPlainObject(entry) && entry.id === target.id);
    if (matchingIds.length > 1) throw new Error(`duplicate Cordis insert id: ${target.id}`);
    if (matchingIds.length === 1 && matchingIds[0].name !== target.name) {
      throw new Error(`Cordis insert ${target.id} has unexpected package name`);
    }
    const matchingNames = entries.filter((entry) => isPlainObject(entry) && entry.name === target.name);
    if (matchingNames.some((entry) => entry.id !== target.id)) {
      throw new Error(`Cordis package ${target.name} is registered under an unexpected id`);
    }
  }
  return entries;
}

function rootInsertBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^-\s+insert:\s*(?:#.*)?$/.test(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !/^-\s+/.test(lines[end])) end += 1;
    blocks.push({ start: index, end });
    index = end - 1;
  }
  return blocks;
}

function insertionIndent(lines, block) {
  const candidates = [];
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = lines[index].match(/^( +)-\s+/);
    if (match) candidates.push(match[1]);
  }
  if (candidates.length === 0) return "  ";
  return candidates.reduce((shortest, candidate) => (
    candidate.length < shortest.length ? candidate : shortest
  ));
}

let source;
let mode = 0o600;
try {
  source = fs.readFileSync(patchPath, "utf8");
  mode = fs.statSync(patchPath).mode & 0o777;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  source = "[]\n";
}

const lines = source.split("\n");
let document;
try {
  document = yaml.load(source);
} catch (error) {
  throw new Error(`Cordis patch is not valid YAML: ${error.message}`);
}
const entries = validateDocument(document);
const missing = targets.filter((target) => !entries.some((entry) => entry.id === target.id));

let output = source;
if (missing.length > 0) {
  const blocks = rootInsertBlocks(lines);
  const rootInsertCount = document.filter((operation) => isPlainObject(operation) && Object.hasOwn(operation, "insert")).length;
  if (blocks.length !== rootInsertCount) {
    throw new Error("Cordis root insert layout is unsupported; use a block-style root insert operation");
  }
  const additionsFor = (entryIndent) => missing.flatMap((target) => [
    `${entryIndent}- id: ${target.id}`,
    `${entryIndent}  name: ${target.name}`,
  ]);
  if (document.length === 0 && source.trim() === "[]") {
    const emptyIndex = lines.findIndex((line) => line.trim() === "[]");
    lines.splice(emptyIndex, 1, "- insert:", ...additionsFor("    "));
  } else if (blocks.length > 0) {
    const block = blocks[0];
    lines.splice(block.end, 0, ...additionsFor(insertionIndent(lines, block)));
  } else {
    const insertAt = source.endsWith("\n") ? lines.length - 1 : lines.length;
    lines.splice(insertAt, 0, "- insert:", ...additionsFor("  "));
  }
  output = lines.join("\n");
}

let verified;
try {
  verified = yaml.load(output);
} catch (error) {
  throw new Error(`generated Cordis patch is not valid YAML: ${error.message}`);
}
const verifiedEntries = validateDocument(verified);
for (const target of targets) {
  if (verifiedEntries.filter((entry) => entry.id === target.id && entry.name === target.name).length !== 1) {
    throw new Error(`failed to install root Cordis entry: ${target.id}`);
  }
}

fs.mkdirSync(path.dirname(patchPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(temporaryPath, output, { encoding: "utf8", flag: "wx", mode });
fs.chmodSync(temporaryPath, mode);
NODE

DSH_HOME="$DSH_HOME_REAL" "$SCRIPT_DIR/dsh-memory-init" >/dev/null
ensure_package_link dsh-memory
ensure_package_link dsh-memory-ui
mv -f -- "$PATCH_TEMP" "$PATCH_FILE"
PATCH_TEMP=""
trap - EXIT

print "Installed dsh-memory and dsh-memory-ui. Restart DSH to load them."
