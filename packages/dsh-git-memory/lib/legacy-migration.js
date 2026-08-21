/**
 * Pure legacy-record discovery and front matter generation.
 *
 * Migration deliberately does not infer record type, status, confidence, or
 * body content. It only adds the minimum schema fields needed for a later
 * consolidation to treat an old Markdown file as structured memory.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseFrontMatter } from "./memory-metadata.js";
import { isPayloadPath } from "./memory-tree.js";

const LEGACY_ROOTS = Object.freeze(["handbook", "rollouts", "archive"]);

export function legacyId(path) {
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 16);
  return `legacy-${digest}`;
}

export function migrationFrontMatter(path, mtime) {
  const date = mtime.toISOString().slice(0, 10);
  return [
    "---",
    "schema_version: 1",
    `id: ${legacyId(path)}`,
    `created_at: ${date}`,
    `updated_at: ${date}`,
    "---",
    "",
  ].join("\n");
}

export function migratedContent(record) {
  return migrationFrontMatter(record.path, record.mtime) + record.content;
}

async function walk(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * Scan a validated memory root and return records with content for the host
 * transaction. Callers must not expose the returned content to a browser.
 */
export async function scanLegacyRecords(root) {
  const records = [];
  for (const directory of LEGACY_ROOTS) {
    const rootPath = join(root, directory);
    let files;
    try {
      files = await walk(rootPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const path = relative(root, file);
      if (!isPayloadPath(path)) continue;
      const content = await readFile(file, "utf8");
      if (parseFrontMatter(content, path) !== null) continue;
      records.push({
        path,
        content,
        mtime: (await stat(file)).mtime,
      });
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

/** Metadata-only shape safe to return through the DSH remote API. */
export function legacyRecordSummary(record) {
  const date = record.mtime.toISOString().slice(0, 10);
  return Object.freeze({
    path: record.path,
    id: legacyId(record.path),
    frontMatter: migrationFrontMatter(record.path, record.mtime),
    createdAt: date,
    updatedAt: date,
    bytes: Buffer.byteLength(record.content, "utf8"),
  });
}
