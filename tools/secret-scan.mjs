#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);

const gitBuffer = (args) => execFileSync("git", args, { cwd: root, encoding: "buffer" });
const nullSeparated = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);
const parseIndexRecords = () => nullSeparated(gitBuffer(["ls-files", "--stage", "-z"])).map((record) => {
  const tab = record.indexOf("\t");
  const [mode, object, stage] = record.slice(0, tab).split(" ");
  return { mode, object, stage, file: record.slice(tab + 1) };
});
const indexRecords = parseIndexRecords();
const tracked = [...new Set(indexRecords.map((record) => record.file))].sort();
const untracked = nullSeparated(gitBuffer(["ls-files", "--others", "--exclude-standard", "-z"]));
const candidates = [...new Set([...tracked, ...untracked])].sort();

if (candidates.length === 0) {
  console.error("secret scan: repository has no source candidates");
  process.exit(2);
}

const findings = [];
const addFinding = (source, file, label, line = null) => {
  if (!findings.some((finding) => (
    finding.source === source
    && finding.file === file
    && finding.label === label
    && finding.line === line
  ))) {
    findings.push({ source, file, label, line });
  }
};
const slash = "/";
const localPathRoots = [
  `${slash}Users${slash}`,
  `${slash}home${slash}`,
  `${slash}root${slash}`,
  `${slash}private${slash}var${slash}`,
];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const localPathPattern = new RegExp(
  `(?:^|[\\s'"\`=(])((?:${localPathRoots.map(escapeRegex).join("|")})[^\\s'"\`<>]*)`,
  "g",
);
const userHomePattern = new RegExp(
  `(?:${escapeRegex(localPathRoots[0])}|${escapeRegex(localPathRoots[1])})[A-Za-z0-9._-]+${escapeRegex(slash)}`,
);
const rootPathPattern = new RegExp(`${escapeRegex(localPathRoots[2])}|${escapeRegex(localPathRoots[3])}`);
const providerKeyPattern = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi;
const githubTokenPattern = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi;
const awsAccessKeyPattern = /\b(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g;
const bearerPattern = /\bbearer[ \t]+(?!\[REDACTED\]|<REDACTED>)[A-Za-z0-9._~+/=-]{8,}/gi;
const privateKeyPattern = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const sensitiveFieldPattern = String.raw`(?:
  api[_-]?key
  |authorization
  |password
  |passwd
  |pwd
  |secret
  |token
  |_?auth[_-]?token
  |(?:client|access|refresh|oauth|bearer|registry|service|session|credential)[_-]?(?:secret|token|key)
  |private[_-]?key
)`.replace(/\s+/g, "");
const assignmentTriviaPattern = String.raw`(?:[ \t\r\n]|/\*[\s\S]*?\*/|//[^\r\n]*(?:\r?\n|$))*`;
const sensitiveKeyPattern = String.raw`(?:(?:[A-Za-z_$][A-Za-z0-9_$]*${assignmentTriviaPattern})?\[${assignmentTriviaPattern}["']${sensitiveFieldPattern}["']${assignmentTriviaPattern}\]|["']?${sensitiveFieldPattern}["']?)`;
const sensitiveValuePattern = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+(?:\[REDACTED\]|<REDACTED>|[^\s,;}\]]+)|\[REDACTED\]|<REDACTED>|[^,;}\s#]+)`;
const sensitiveAssignmentStart = String.raw`(?<![A-Za-z0-9_$])`;
const sensitiveColonAssignment = new RegExp(
  String.raw`${sensitiveAssignmentStart}${sensitiveKeyPattern}${assignmentTriviaPattern}:(?!:)\s*${assignmentTriviaPattern}(${sensitiveValuePattern})`,
  "gi",
);
const typeAnnotationPattern = String.raw`(?:${assignmentTriviaPattern}:\s*[A-Za-z_$][A-Za-z0-9_$.\[\]<>|, ?]*?)?`;
const sensitiveEqualsAssignment = new RegExp(
  String.raw`${sensitiveAssignmentStart}${sensitiveKeyPattern}${typeAnnotationPattern}${assignmentTriviaPattern}=(?![=>])\s*${assignmentTriviaPattern}(${sensitiveValuePattern})`,
  "gi",
);
const sensitiveFallback = new RegExp(
  String.raw`^${assignmentTriviaPattern}(?:\?\?|\|\|)${assignmentTriviaPattern}(${sensitiveValuePattern})`,
  "i",
);
const querySecretPattern = /[?&](?:access_token|api[_-]?key|auth|password|passwd|pwd|token)=([^&#\s"']+)/gi;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function isReferenceOrPlaceholder(value, { quoted = false, allowBareCodeReference = false } = {}) {
  const normalized = value.trim().replace(/[;,.)`]+$/, "");
  if (/^(?:\[REDACTED\]|<REDACTED>)$/i.test(normalized)) return true;
  if (quoted) return normalized === "";
  if (/^(?:undefined|null|none|true|false)$/i.test(normalized)) return true;
  if (allowBareCodeReference && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/.test(normalized)) return true;
  if (/^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]\r\n]+\])|os\.environ\[[^\]\r\n]+\]|getenv\([^\r\n)]*\)|(?:config|env|args)\.[A-Za-z_$][A-Za-z0-9_$]*)$/i.test(normalized)) return true;
  if (/^Bearer\s+(?:\[REDACTED\]|<REDACTED>)$/i.test(normalized)) return true;
  return false;
}

function quotedValueEnd(value, quote) {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return index;
  }
  return -1;
}

function assignmentValue(raw) {
  const trimmed = raw.trim();
  if (/^Bearer\s+/i.test(trimmed)) {
    const bearerValue = trimmed.slice(7).trim();
    if (/^(?:\[REDACTED\]|<REDACTED>)/i.test(bearerValue)) {
      return { value: "Bearer [REDACTED]", quoted: false };
    }
    return { value: `Bearer ${bearerValue.split(/[\s,;`)}\]]/, 1)[0] ?? ""}`, quoted: false };
  }
  if (/^['"]/.test(trimmed)) {
    const end = quotedValueEnd(trimmed, trimmed[0]);
    return {
      value: end >= 0 ? trimmed.slice(1, end) : trimmed.slice(1),
      quoted: true,
    };
  }
  return { value: trimmed.split(/[\s,;`)}\]]/, 1)[0] ?? "", quoted: false };
}

function hasLiteralFallback(text, offset, allowBareCodeReference) {
  let remaining = text.slice(offset);
  while (true) {
    const match = sensitiveFallback.exec(remaining);
    if (match === null) return false;
    const value = assignmentValue(match[1]);
    if (!isReferenceOrPlaceholder(value.value, { ...value, allowBareCodeReference })) return true;
    remaining = remaining.slice(match[0].length);
  }
}

function decodeText(source, file, content) {
  if (content.includes(0)) {
    addFinding(source, file, "binary source candidate");
    return null;
  }
  try {
    return textDecoder.decode(content);
  } catch {
    addFinding(source, file, "binary source candidate");
    return null;
  }
}

function firstPatternOffset(pattern, text) {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  return match?.index;
}

function scanText(source, file, text) {
  const allowBareCodeReference = /\.(?:[cm]?[jt]sx?|py)$/i.test(file);
  for (const [label, pattern] of [
    ["provider key", providerKeyPattern],
    ["GitHub token", githubTokenPattern],
    ["AWS access key", awsAccessKeyPattern],
    ["Bearer token", bearerPattern],
    ["private key header", privateKeyPattern],
  ]) {
    const offset = firstPatternOffset(pattern, text);
    if (offset !== undefined) addFinding(source, file, label, lineNumber(text, offset));
  }

  querySecretPattern.lastIndex = 0;
  for (const match of text.matchAll(querySecretPattern)) {
    if (!isReferenceOrPlaceholder(match[1])) {
      addFinding(source, file, "query-string credential", lineNumber(text, match.index));
      break;
    }
  }

  localPathPattern.lastIndex = 0;
  for (const match of text.matchAll(localPathPattern)) {
    const path = match[1];
    if (userHomePattern.test(path) || rootPathPattern.test(path)) {
      addFinding(source, file, "machine-specific absolute path", lineNumber(text, match.index));
      break;
    }
  }

  for (const pattern of [sensitiveColonAssignment, sensitiveEqualsAssignment]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = assignmentValue(match[1]);
      const valueIsSafe = isReferenceOrPlaceholder(value.value, { ...value, allowBareCodeReference });
      const hasUnsafeFallback = valueIsSafe && hasLiteralFallback(
        text,
        match.index + match[0].length,
        allowBareCodeReference,
      );
      if (!valueIsSafe || hasUnsafeFallback) {
        addFinding(source, file, "literal credential assignment", lineNumber(text, match.index));
        return;
      }
    }
  }
}

function scanWorkingTree() {
  for (const file of candidates) {
    const absolute = resolve(root, file);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      if (tracked.includes(file)) addFinding("working-tree", file, "tracked source is missing from the working tree");
      continue;
    }
    if (stat.isSymbolicLink()) {
      addFinding("working-tree", file, "symbolic-link source candidate");
      continue;
    }
    if (!stat.isFile()) {
      addFinding("working-tree", file, "non-file source candidate");
      continue;
    }
    const text = decodeText("working-tree", file, readFileSync(absolute));
    if (text !== null) scanText("working-tree", file, text);
  }
}

function scanIndex() {
  for (const record of indexRecords) {
    if (record.mode === "120000") {
      addFinding("index", record.file, "tracked symbolic link");
      continue;
    }
    if (record.mode !== "100644" && record.mode !== "100755") {
      addFinding("index", record.file, "non-regular indexed source");
      continue;
    }
    let content;
    try {
      content = gitBuffer(["show", `:${record.file}`]);
    } catch {
      addFinding("index", record.file, "unable to read indexed source");
      continue;
    }
    const text = decodeText("index", record.file, content);
    if (text !== null) scanText("index", record.file, text);
  }
}

scanWorkingTree();
scanIndex();

if (findings.length > 0) {
  for (const finding of findings) {
    const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    console.error(`secret scan: ${finding.label} in ${finding.source}: ${location}`);
  }
  console.error("secret scan: FAILED");
  process.exit(1);
}

console.log(`secret scan: passed (${tracked.length} tracked and ${untracked.length} untracked candidates checked)`);
