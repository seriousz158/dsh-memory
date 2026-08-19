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

ensure_package_link() {
  local package_name="$1"
  local package_path="$REPOSITORY_ROOT/packages/$package_name"
  local package_real
  local link_path="$PROFILE_NODE_MODULES/$package_name"

  [[ -f "$package_path/package.json" ]] || die "package is missing: $package_path"
  package_real="$(cd -- "$package_path" && pwd -P)"
  case "$package_real" in
    "$REPOSITORY_ROOT"/*) ;;
    *) die "refusing package target outside repository: $package_path" ;;
  esac

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
  ln -s "$package_real" "$link_path"
}

ensure_package_link dsh-memory
ensure_package_link dsh-memory-ui

node - "$PATCH_FILE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const patchPath = process.argv[2];
const targets = [
  { id: "memory", name: "dsh-memory" },
  { id: "ui-memory", name: "dsh-memory-ui" },
];

function scalar(raw) {
  const match = raw.match(/^\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function leadingWhitespace(line) {
  return line.match(/^\s*/)[0];
}

function startsSequenceAt(line, indent) {
  return line.startsWith(indent) && line.slice(indent.length).match(/^-\s/);
}

function inspect(lines) {
  const blocks = [];
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const insertMatch = lines[index].match(/^(\s*)-\s+insert:\s*(?:#.*)?$/);
    if (!insertMatch) continue;
    const blockIndent = insertMatch[1];
    let end = index + 1;
    while (end < lines.length && !startsSequenceAt(lines[end], blockIndent)) end += 1;
    const idCandidates = [];
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const idMatch = lines[cursor].match(/^(\s*)-\s+id:(.*)$/);
      if (idMatch && idMatch[1].length > blockIndent.length) {
        idCandidates.push({ cursor, indent: idMatch[1], raw: idMatch[2] });
      }
    }
    const entryIndentLength = idCandidates.length
      ? Math.min(...idCandidates.map((candidate) => candidate.indent.length))
      : blockIndent.length + 2;
    const entryIndent = idCandidates.find((candidate) => candidate.indent.length === entryIndentLength)?.indent
      ?? `${blockIndent}  `;
    const block = {
      start: index,
      end,
      blockIndent,
      entryIndent,
      propertyIndent: `${entryIndent}  `,
    };
    blocks.push(block);
    const directEntries = idCandidates.filter((candidate) => candidate.indent.length === entryIndentLength);
    for (let position = 0; position < directEntries.length; position += 1) {
      const candidate = directEntries[position];
      const cursor = candidate.cursor;
      let entryEnd = cursor + 1;
      const next = directEntries[position + 1];
      if (next) entryEnd = next.cursor;
      else entryEnd = end;
      const id = scalar(candidate.raw);
      let name;
      let propertyIndent;
      const nameCandidates = [];
      for (let line = cursor + 1; line < entryEnd; line += 1) {
        const nameMatch = lines[line].match(/^(\s*)name:(.*)$/);
        if (nameMatch && nameMatch[1].length > entryIndentLength) {
          nameCandidates.push({ indent: nameMatch[1], raw: nameMatch[2] });
        }
      }
      if (nameCandidates.length > 0) {
        const propertyIndentLength = Math.min(...nameCandidates.map((candidate) => candidate.indent.length));
        const directName = nameCandidates.find((candidate) => candidate.indent.length === propertyIndentLength);
        name = scalar(directName.raw);
        propertyIndent = directName.indent;
      }
      if (propertyIndent) block.propertyIndent = propertyIndent;
      entries.push({ id, name, start: cursor, end: entryEnd });
    }
    index = end - 1;
  }
  return { blocks, entries };
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
const parsed = inspect(lines);
for (const target of targets) {
  const matchingIds = parsed.entries.filter((entry) => entry.id === target.id);
  if (matchingIds.length > 1) throw new Error(`duplicate Cordis insert id: ${target.id}`);
  if (matchingIds.length === 1 && matchingIds[0].name !== target.name) {
    throw new Error(`Cordis insert ${target.id} has unexpected package name`);
  }
  const matchingNames = parsed.entries.filter((entry) => entry.name === target.name);
  if (matchingNames.some((entry) => entry.id !== target.id)) {
    throw new Error(`Cordis package ${target.name} is registered under an unexpected id`);
  }
}

const missing = targets.filter((target) => !parsed.entries.some((entry) => entry.id === target.id));
if (missing.length === 0) process.exit(0);

const meaningful = lines
  .map((line, index) => ({ line: line.trim(), index }))
  .filter(({ line }) => line !== "" && !line.startsWith("#"));

if (meaningful.length === 1 && meaningful[0].line === "[]") {
  const additions = missing.flatMap((target) => [
    `    - id: ${target.id}`,
    `      name: ${target.name}`,
  ]);
  lines.splice(meaningful[0].index, 1, "- insert:", ...additions);
} else if (parsed.blocks.length > 0) {
  const block = parsed.blocks[0];
  const additions = missing.flatMap((target) => [
    `${block.entryIndent}- id: ${target.id}`,
    `${block.propertyIndent}name: ${target.name}`,
  ]);
  lines.splice(block.end, 0, ...additions);
} else {
  if (meaningful.some(({ line }) => !line.startsWith("- ") && !line.startsWith("-\t"))) {
    throw new Error("Cordis patch has an unsupported non-list root layout");
  }
  const additions = missing.flatMap((target) => [
    `    - id: ${target.id}`,
    `      name: ${target.name}`,
  ]);
  const insertAt = source.endsWith("\n") ? lines.length - 1 : lines.length;
  lines.splice(insertAt, 0, "- insert:", ...additions);
}

const output = lines.join("\n");
const verified = inspect(output.split("\n"));
for (const target of targets) {
  const matches = verified.entries.filter((entry) => entry.id === target.id && entry.name === target.name);
  if (matches.length !== 1) throw new Error(`failed to install Cordis entry: ${target.id}`);
}

fs.mkdirSync(path.dirname(patchPath), { recursive: true, mode: 0o700 });
const temporary = `${patchPath}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(temporary, output, { encoding: "utf8", flag: "wx", mode });
fs.chmodSync(temporary, mode);
fs.renameSync(temporary, patchPath);
NODE

print "Installed dsh-memory and dsh-memory-ui. Restart DSH to load them."
