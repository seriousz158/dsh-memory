// v0.9.0 derived SQLite search index.
//
// The index is a cache derived from the payload tree at HEAD; its validity
// stamp is sha256(payloadTree(HEAD)) so every applied sync commit (which
// changes HEAD) invalidates it. The database lives at .sync/search-index.sqlite
// (mode 0600, git-excluded), is built into a temporary file and atomically
// renamed into place, and is opened read-only on the query path. When SQLite
// or FTS5 is unavailable, or the index cannot be built or read, callers fall
// back to the full scan with retrieval.mode = "scan" and indexState =
// "degraded"; search results stay correct, only the ranking components shrink.
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const SEARCH_INDEX_SCHEMA_VERSION = 1;
export const SEARCH_INDEX_FILE = ".sync/search-index.sqlite";
export const SEARCH_INDEX_TEMP_PREFIX = ".search-index.";
export const SEARCH_INDEX_TEMP_SUFFIX = ".tmp";
export const RRF_K = 60;
export const RRF_WEIGHTS = Object.freeze({ raw: 2.0, fts: 1.0, coverage: 1.0, usage: 0.25 });

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const LATIN_WORD = /[a-z0-9_][a-z0-9_-]*/g;

let sqlitePromise = null;

async function loadSqlite() {
  if (sqlitePromise === null) {
    sqlitePromise = import("node:sqlite").then((module) => module.DatabaseSync);
  }
  return await sqlitePromise;
}

export async function isSqliteAvailable() {
  try {
    await loadSqlite();
    return true;
  } catch {
    return false;
  }
}

/** sha256 over "blob-object path" lines of the payload tree at a commit. */
export function stampOf(payloadTreeText) {
  return `sha256:${createHash("sha256").update(payloadTreeText, "utf8").digest("hex")}`;
}

/**
 * Derived index terms for one record: lowercase latin words plus CJK
 * character bigrams (a lone CJK character is kept as a unigram). The query
 * side reuses this function so index and query token spaces always match.
 */
export function derivedTerms(text) {
  const tokens = [];
  const lower = String(text).toLowerCase();
  for (const word of lower.match(LATIN_WORD) ?? []) tokens.push(word);
  for (const run of String(text).match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens.join(" ");
}

/** Split a query into the FTS signals the index can answer. */
export function tokenizeQuery(query) {
  const trimmed = String(query).trim();
  const words = new Set();
  const bigrams = new Set();
  const phrases = [];
  const lower = trimmed.toLowerCase();
  for (const word of lower.match(LATIN_WORD) ?? []) {
    if (word.length >= 2) words.add(word);
    if (word.length >= 3) phrases.push(word);
  }
  for (const run of trimmed.match(CJK_RUN) ?? []) {
    if (run.length >= 3) phrases.push(run);
    if (run.length === 1) {
      bigrams.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) bigrams.add(run.slice(index, index + 2));
  }
  if ([...trimmed].length >= 3) phrases.push(trimmed);
  return { words: [...words], bigrams: [...bigrams], phrases };
}

function ftsMatchOr(terms) {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function ftsMatchPlain(terms) {
  return terms.join(" OR ");
}

async function ensureIndexGitExcludes(root) {
  const excludePath = join(root, ".git", "info", "exclude");
  const current = await (await import("node:fs/promises")).readFile(excludePath, "utf8").catch(() => "");
  const lines = current.split(/\r?\n/);
  const wanted = [".sync/search-index.sqlite", `.sync/${SEARCH_INDEX_TEMP_PREFIX}*${SEARCH_INDEX_TEMP_SUFFIX}`];
  const missing = wanted.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  const suffix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(excludePath, `${current}${suffix}${missing.join("\n")}\n`, { mode: 0o600 });
  await chmod(excludePath, 0o600).catch(() => {});
}

/**
 * Build the index from eligible records and atomically replace the previous
 * database. `records` items: {path, id, type, tags, updatedAt, rawBody,
 * searchable} — `searchable` is the raw-scan scoring text, `rawBody` the
 * front-matter-free body used for snippets and exact-substring tiers.
 */
export async function buildSearchIndex(root, records, stamp, warnings = []) {
  const DatabaseSync = await loadSqlite();
  const syncRoot = join(root, ".sync");
  const finalPath = join(syncRoot, "search-index.sqlite");
  const temporary = join(syncRoot, `${SEARCH_INDEX_TEMP_PREFIX}${process.pid}.${randomUUID()}${SEARCH_INDEX_TEMP_SUFFIX}`);
  let db;
  try {
    db = new DatabaseSync(temporary);
    db.exec("PRAGMA journal_mode=DELETE;");
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE records(
        path TEXT PRIMARY KEY,
        id TEXT,
        type TEXT,
        tags TEXT,
        updated_at TEXT,
        raw_body TEXT,
        searchable TEXT
      );
      CREATE VIRTUAL TABLE content_fts USING fts5(path UNINDEXED, body, tokenize='trigram');
      CREATE VIRTUAL TABLE terms_fts USING fts5(path UNINDEXED, terms, tokenize='unicode61');
      CREATE TABLE invalid_metadata(path TEXT PRIMARY KEY, code TEXT NOT NULL);
    `);
    const insertRecord = db.prepare(
      "INSERT INTO records(path, id, type, tags, updated_at, raw_body, searchable) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertContent = db.prepare("INSERT INTO content_fts(path, body) VALUES (?, ?)");
    const insertTerms = db.prepare("INSERT INTO terms_fts(path, terms) VALUES (?, ?)");
    const insertWarning = db.prepare("INSERT INTO invalid_metadata(path, code) VALUES (?, ?)");
    db.exec("BEGIN");
    for (const record of records) {
      const tags = JSON.stringify(record.tags ?? []);
      insertRecord.run(record.path, record.id, record.type, tags, record.updatedAt, record.rawBody, record.searchable);
      insertContent.run(record.path, record.searchable);
      insertTerms.run(record.path, derivedTerms(record.searchable));
    }
    for (const warning of warnings) insertWarning.run(warning.path, warning.code);
    db.exec("COMMIT");
    db.exec(`
      INSERT INTO meta(key, value) VALUES ('schema_version', '${SEARCH_INDEX_SCHEMA_VERSION}');
      INSERT INTO meta(key, value) VALUES ('stamp', '${stamp.replaceAll("'", "''")}');
      INSERT INTO meta(key, value) VALUES ('built_at', '${new Date().toISOString()}');
    `);
    db.close();
    db = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, finalPath);
    await chmod(finalPath, 0o600).catch(() => {});
    await ensureIndexGitExcludes(root).catch(() => {});
  } catch (error) {
    try { db?.close(); } catch {}
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Open the index read-only. Returns:
 *   { db, stampMatches }         — database opened
 *   null                         — no index file present
 * and throws on a corrupt or schema-mismatched database (caller rebuilds).
 */
export async function openSearchIndex(root, expectedStamp) {
  const path = join(root, SEARCH_INDEX_FILE);
  const stat = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("search-index: unsafe layout");
  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schemaVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    if (Number(schemaVersion) !== SEARCH_INDEX_SCHEMA_VERSION) throw new Error("search-index: schema mismatch");
    const stamp = db.prepare("SELECT value FROM meta WHERE key = 'stamp'").get()?.value ?? "";
    return { db, stampMatches: stamp === expectedStamp };
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

/**
 * Query the index. Returns { ranksByPath, coverageByPath, stamp } where
 * ranksByPath is a 1-based best-effort FTS rank (trigram matches first, then
 * term matches) and coverageByPath maps paths to the fraction of query tokens
 * matched. Returns null when the query produces no usable FTS signals.
 */
export function querySearchIndex(db, query) {
  const { words, bigrams, phrases } = tokenizeQuery(query);
  const ranksByPath = new Map();
  const coverageTokens = new Map();
  const totalTokens = words.length + bigrams.length;
  const consider = (list) => {
    for (const path of list) if (!ranksByPath.has(path)) ranksByPath.set(path, ranksByPath.size + 1);
  };
  if (phrases.length > 0) {
    const rows = db.prepare("SELECT path, bm25(content_fts) AS r FROM content_fts WHERE content_fts MATCH ? ORDER BY r").all(ftsMatchOr(phrases));
    consider(rows.map((row) => row.path));
  }
  if (words.length > 0 || bigrams.length > 0) {
    const termTokens = [...words, ...bigrams];
    for (const token of termTokens) {
      const rows = db.prepare("SELECT path FROM terms_fts WHERE terms_fts MATCH ?").all(ftsMatchPlain([token]));
      for (const row of rows) {
        if (!coverageTokens.has(row.path)) coverageTokens.set(row.path, new Set());
        coverageTokens.get(row.path).add(token);
      }
    }
    const rows = db.prepare("SELECT path, bm25(terms_fts) AS r FROM terms_fts WHERE terms_fts MATCH ? ORDER BY r").all(ftsMatchPlain(termTokens));
    consider(rows.map((row) => row.path));
  }
  const coverageByPath = new Map();
  for (const [path, matched] of coverageTokens) {
    coverageByPath.set(path, totalTokens === 0 ? 0 : matched.size / totalTokens);
  }
  return { ranksByPath, coverageByPath };
}

/** Close a handle returned by openSearchIndex. */
export function closeSearchIndex(handle) {
  try { handle?.db?.close(); } catch {}
}
