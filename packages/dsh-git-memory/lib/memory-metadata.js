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

/**
 * A record id is a lowercase slug, optionally namespaced with `/`:
 *   project/codegen-style     (namespace/name)
 *   user/preferences          (namespace/name)
 * Each segment is `[a-z0-9][a-z0-9-]*`; at most one namespace separator.
 */
export const ID_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;

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
    // Canonical records use block lists (tags:\n  - item). Flow-style
    // collections are rejected with a stable code so the staging validator and
    // the metadata audit report the same, actionable diagnosis.
    if ((value.startsWith("[") && value !== "[]") || (value.startsWith("{") && value !== "{}")) {
      throw new MetadataError("flow-style-metadata", `${key} must use a canonical block list, not a flow collection`);
    }
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
  for (const field of ["source_hash", "created_by", "content_hash", "source_session_digest", "supersedes", "conflicts_with"]) {
    if (raw[field] !== undefined && (typeof raw[field] !== "string" || raw[field].length === 0 || raw[field].length > 128)) {
      throw new MetadataError("invalid-metadata", `${relativePath} has an invalid ${field}`);
    }
  }
  for (const field of ["review_after", "expires_at"]) {
    if (raw[field] !== undefined && !isValidDate(raw[field])) {
      throw new MetadataError("invalid-metadata", `${relativePath} has an invalid ${field}`);
    }
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
    source_hash: raw.source_hash ?? null,
    content_hash: raw.content_hash ?? null,
    source_session_digest: raw.source_session_digest ?? null,
    created_by: raw.created_by ?? null,
    supersedes: raw.supersedes ?? null,
    conflicts_with: raw.conflicts_with ?? null,
    review_after: raw.review_after ?? null,
    expires_at: raw.expires_at ?? null,
  };
}

/** Render canonical front matter for a metadata object. */
export function renderFrontMatter(metadata) {
  const lines = ["---", `schema_version: ${SCHEMA_VERSION}`, `id: ${metadata.id}`, `type: ${metadata.type}`, `status: ${metadata.status}`, `confidence: ${metadata.confidence}`, `created_at: ${metadata.created_at}`, `updated_at: ${metadata.updated_at}`];
  if (metadata.source_hash !== undefined && metadata.source_hash !== null) lines.push(`source_hash: ${metadata.source_hash}`);
  if (metadata.content_hash !== undefined && metadata.content_hash !== null) lines.push(`content_hash: ${metadata.content_hash}`);
  if (metadata.source_session_digest !== undefined && metadata.source_session_digest !== null) lines.push(`source_session_digest: ${metadata.source_session_digest}`);
  if (metadata.created_by !== undefined && metadata.created_by !== null) lines.push(`created_by: ${metadata.created_by}`);
  if (metadata.supersedes !== undefined && metadata.supersedes !== null) lines.push(`supersedes: ${metadata.supersedes}`);
  if (metadata.conflicts_with !== undefined && metadata.conflicts_with !== null) lines.push(`conflicts_with: ${metadata.conflicts_with}`);
  if (metadata.review_after !== undefined && metadata.review_after !== null) lines.push(`review_after: ${metadata.review_after}`);
  if (metadata.expires_at !== undefined && metadata.expires_at !== null) lines.push(`expires_at: ${metadata.expires_at}`);
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

/**
 * Lazy expiry projection: a record with an `expires_at` earlier than `now`
 * is considered expired without rewriting the file. Expired records are
 * excluded from active views and conflict resolution, but their front matter
 * is untouched until a later consolidation explicitly archives or removes
 * them.
 */
export function isExpired(metadata, now = Date.now()) {
  const expiresAt = metadata?.expires_at;
  if (typeof expiresAt !== "string") return false;
  const parsed = Date.parse(`${expiresAt}T00:00:00Z`);
  return Number.isFinite(parsed) && parsed <= now;
}

/** Human-readable remaining validity for a record, or null when not expiring. */
export function expiresInDays(metadata, now = Date.now()) {
  const expiresAt = metadata?.expires_at;
  if (typeof expiresAt !== "string") return null;
  const parsed = Date.parse(`${expiresAt}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.ceil((parsed - now) / 86_400_000));
}

/**
 * Deterministic conflict key: records about the same topic share it, so the
 * host can decide which of several candidates wins without model judgment.
 * The topic is the record's type plus its namespace (the id's first segment,
 * or the empty namespace for a plain id).
 */
export function topicKey(metadata) {
  const type = metadata?.type ?? "observation";
  const slash = typeof metadata?.id === "string" ? metadata.id.indexOf("/") : -1;
  const namespace = slash === -1 ? "" : metadata.id.slice(0, slash);
  return `${type}:${namespace}`;
}

/**
 * Explicit-only conflict resolution (v0.9.1). Given records that share a
 * topicKey, a winner emerges only through explicit declarations — implicit
 * "newest wins" ordering is gone because it silently discarded knowledge:
 *   1. expired records never win (lazy expiry projection);
 *   2. records whose own status is superseded or archived are projected out;
 *   3. a record named in another eligible record's `supersedes` is excluded
 *      (explicit supersession);
 *   4. records linked by `conflicts_with` block each other: neither side can
 *      win until an operator resolves the conflict explicitly;
 *   5. exactly one contender remains -> that record wins; zero or multiple
 *      contenders -> null (unresolved, surfaced as a conflict instead of
 *      being silently resolved by file order or recency).
 * Returns the winning record, or null when resolution is not explicit.
 */
export function resolveTopicConflict(records, now = Date.now()) {
  const eligible = records.filter(
    (record) => !isExpired(record, now) && record.status !== "superseded" && record.status !== "archived",
  );
  if (eligible.length === 0) return null;
  const byId = new Map(eligible.map((record) => [record.id, record]));
  const excluded = new Set();
  const linkedIds = (record, field) =>
    [record[field]].filter((id) => typeof id === "string" && id.length > 0 && byId.has(id));
  for (const record of eligible) {
    for (const id of linkedIds(record, "supersedes")) excluded.add(id);
  }
  for (const record of eligible) {
    for (const id of linkedIds(record, "conflicts_with")) {
      excluded.add(record.id);
      excluded.add(id);
    }
  }
  const contenders = eligible.filter((record) => !excluded.has(record.id));
  return contenders.length === 1 ? contenders[0] : null;
}

export const AUDIT_INVALID_METADATA_LIMIT = 20;

/**
 * Shared metadata audit over structured records (schema_version 1).
 *
 * Scans every record-shaped payload document and reports:
 *   - per-file validation failures (schema, fields, duplicate ids);
 *   - legacy records (no front matter) which are counted but never invalid;
 *   - duplicate structured ids across the corpus.
 *
 * The audit is report-only: callers decide whether invalid metadata blocks a
 * write path (staging validation stays fail-closed) or only surfaces in
 * status/health and search warnings. Legacy records grandfather as valid.
 *
 * @param {Array<{ path: string, content: string }>} records
 * @returns {{ metadataValid: boolean, validMetadataCount: number, invalidMetadataCount: number, legacyMetadataCount: number, duplicateIdCount: number, invalidMetadata: Array<{ path: string, code: string }> }}
 */
export function auditRecords(records) {
  let validCount = 0;
  let legacyCount = 0;
  const invalid = [];
  let invalidCount = 0;
  const seenIds = new Map();
  let duplicateIdCount = 0;
  for (const record of records) {
    if (record.content === null || record.content === undefined) {
      // The file could not be read at all; that is an invalid record, not a
      // legacy one, so it surfaces in the audit instead of disappearing.
      invalidCount += 1;
      if (invalid.length < AUDIT_INVALID_METADATA_LIMIT) invalid.push({ path: record.path, code: "unreadable" });
      continue;
    }
    if (!hasRecordFrontMatter(record.content)) {
      legacyCount += 1;
      continue;
    }
    try {
      const metadata = parseFrontMatter(record.content, record.path);
      if (metadata === null) {
        // Not a record path (defensive; callers pre-filter).
        continue;
      }
      validCount += 1;
      const first = seenIds.get(metadata.id);
      if (first !== undefined) {
        duplicateIdCount += 1;
        invalidCount += 1;
        if (invalid.length < AUDIT_INVALID_METADATA_LIMIT) {
          invalid.push({ path: record.path, code: "duplicate-id" });
        }
      } else {
        seenIds.set(metadata.id, record.path);
      }
    } catch (error) {
      const code = error instanceof MetadataError ? error.code : "invalid-metadata";
      invalidCount += 1;
      if (invalid.length < AUDIT_INVALID_METADATA_LIMIT) invalid.push({ path: record.path, code });
    }
  }
  return {
    metadataValid: invalidCount === 0,
    validMetadataCount: validCount,
    invalidMetadataCount: invalidCount,
    legacyMetadataCount: legacyCount,
    duplicateIdCount,
    invalidMetadata: invalid,
  };
}

function hasRecordFrontMatter(content) {
  return content.startsWith("---\n") || content.startsWith("---\r\n");
}
