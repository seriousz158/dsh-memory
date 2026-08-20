/**
 * Front matter metadata for structured memory records (schema_version 1).
 *
 * New records in handbook/ and rollouts/ carry YAML front matter with stable
 * fields. Missing optional fields are completed by the host with documented
 * defaults; invalid enums, duplicate ids, or out-of-tree source_rollouts
 * references fail closed so a sync can never apply malformed metadata.
 *
 * The parser intentionally handles only the flat subset of YAML that memory
 * records use (scalars and indented list items), so the host plugin has no
 * runtime YAML dependency.
 */
import { isPayloadPath } from "./memory-tree.js";

export const SCHEMA_VERSION = 1;

export const TYPES = Object.freeze([
  "preference",
  "fact",
  "decision",
  "procedure",
  "constraint",
  "observation",
]);

export const STATUSES = Object.freeze([
  "active",
  "candidate",
  "conflicted",
  "superseded",
  "archived",
]);

export const CONFIDENCES = Object.freeze(["high", "medium", "low", "unknown"]);

export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_ITEM_RE = /^[ \t]+-\s+(.+)$/;

export class MetadataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MetadataError";
    this.code = code;
  }
}

function isRecordPath(relativePath) {
  return isPayloadPath(relativePath) && relativePath.endsWith(".md") && relativePath !== "summary.md";
}

function isValidDate(value) {
  return typeof value === "string" && DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function validTags(value) {
  return Array.isArray(value) && value.every((tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 64);
}

function validSourceRollouts(value) {
  if (!Array.isArray(value)) return false;
  return value.every((path) => typeof path === "string" && path.startsWith("rollouts/") && !path.includes("..") && path.endsWith(".md"));
}

function parseScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  if (/^-?\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
  }
  return trimmed;
}

/**
 * Parse the flat front matter subset into a plain object. Malformed lines
 * throw MetadataError with a stable code; callers fail closed.
 */
function parseBlock(block) {
  const result = {};
  const lines = block.split(/\r?\n/);
  let currentKey = null;
  let currentList = null;
  for (const line of lines) {
    if (line.trim() === "" || /^[ \t]*#/.test(line)) continue;
    const listMatch = LIST_ITEM_RE.exec(line);
    if (listMatch && currentKey !== null && currentList !== null) {
      currentList.push(parseScalar(listMatch[1]));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new MetadataError("invalid-metadata", `unparsable front matter line: ${line}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "") throw new MetadataError("invalid-metadata", "front matter has an empty key");
    currentKey = key;
    if (value === "" || value.startsWith("|") || value.startsWith(">")) {
      // A nested mapping or block scalar is not part of the record contract.
      if (value.startsWith("|") || value.startsWith(">")) {
        throw new MetadataError("invalid-metadata", `block scalar is not supported: ${key}`);
      }
      currentList = [];
      result[key] = currentList;
    } else if (value === "[]" || value === "{}") {
      currentList = [];
      result[key] = currentList;
    } else {
      currentList = null;
      if (value === "true") result[key] = true;
      else if (value === "false") result[key] = false;
      else if (value === "null" || value === "~") result[key] = null;
      else result[key] = parseScalar(value);
    }
  }
  return result;
}

/**
 * Parse the front matter of a memory record. Returns null for legacy records
 * (no front matter) and throws MetadataError for malformed metadata.
 */
export function parseFrontMatter(content, relativePath) {
  if (!isRecordPath(relativePath)) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (match === null) return null; // legacy record
  const raw = parseBlock(match[1]);
  if (raw.schema_version !== SCHEMA_VERSION) {
    throw new MetadataError("invalid-schema-version", `${relativePath} has schema_version ${String(raw.schema_version)}`);
  }
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
    throw new MetadataError("invalid-id", `${relativePath} has an invalid id`);
  }
  if (raw.type !== undefined && !TYPES.includes(raw.type)) {
    throw new MetadataError("invalid-metadata", `${relativePath} has an unknown type: ${String(raw.type)}`);
  }
  if (raw.status !== undefined && !STATUSES.includes(raw.status)) {
    throw new MetadataError("invalid-metadata", `${relativePath} has an unknown status: ${String(raw.status)}`);
  }
  if (raw.confidence !== undefined && !CONFIDENCES.includes(raw.confidence)) {
    throw new MetadataError("invalid-metadata", `${relativePath} has an unknown confidence: ${String(raw.confidence)}`);
  }
  for (const field of ["created_at", "updated_at"]) {
    if (raw[field] !== undefined && !isValidDate(raw[field])) {
      throw new MetadataError("invalid-metadata", `${relativePath} has an invalid ${field}`);
    }
  }
  if (raw.tags !== undefined && !validTags(raw.tags)) {
    throw new MetadataError("invalid-metadata", `${relativePath} has invalid tags`);
  }
  if (raw.source_rollouts !== undefined && !validSourceRollouts(raw.source_rollouts)) {
    throw new MetadataError("invalid-metadata", `${relativePath} has out-of-tree source_rollouts`);
  }
  return {
    schema_version: SCHEMA_VERSION,
    id: raw.id,
    type: raw.type ?? "observation",
    status: raw.status ?? "active",
    confidence: raw.confidence ?? "unknown",
    created_at: raw.created_at ?? todayUtc(),
    updated_at: raw.updated_at ?? todayUtc(),
    tags: raw.tags ?? [],
    source_rollouts: raw.source_rollouts ?? [],
  };
}

/** Render canonical front matter for a metadata object. */
export function renderFrontMatter(metadata) {
  const lines = ["---", `schema_version: ${SCHEMA_VERSION}`, `id: ${metadata.id}`, `type: ${metadata.type}`, `status: ${metadata.status}`, `confidence: ${metadata.confidence}`, `created_at: ${metadata.created_at}`, `updated_at: ${metadata.updated_at}`];
  if ((metadata.tags ?? []).length > 0) {
    lines.push("tags:");
    for (const tag of metadata.tags) lines.push(`  - ${tag}`);
  }
  if ((metadata.source_rollouts ?? []).length > 0) {
    lines.push("source_rollouts:");
    for (const path of metadata.source_rollouts) lines.push(`  - ${path}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
