#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostRoot = join(projectRoot, "packages", "dsh-memory", "lib");
const bundleRoot = join(projectRoot, "packages", "dsh-git-memory");
const publicHostRoot = join(bundleRoot, "lib");
const sourceClient = join(projectRoot, "packages", "dsh-memory-ui", "lib", "client.js");
const publicClient = join(bundleRoot, "client", "client.js");
const hostFiles = [
  "index.js",
  "legacy-migration.js",
  "memory-metadata.js",
  "memory-tree.js",
  "memory-usage.js",
  "operation-lock.js",
  "search-index.js",
  "safe-clear.py",
  "sync-apply.py",
  "sync-transaction.js",
];

async function expectedFiles() {
  const files = new Map();
  for (const file of hostFiles) files.set(join("lib", file), await readFile(join(hostRoot, file)));
  const source = (await readFile(sourceClient, "utf8"));
  const marker = '  id: "dsh-memory-ui",';
  if (source.split(marker).length !== 2) throw new Error(`expected exactly one client factory id marker in ${relative(projectRoot, sourceClient)}`);
  files.set(join("client", "client.js"), Buffer.from(source.replace(marker, '  id: "dsh-git-memory",'), "utf8"));
  return files;
}

const checkOnly = process.argv.includes("--check");
const expected = await expectedFiles();
const mismatches = [];
for (const [relativePath, content] of expected) {
  const target = join(bundleRoot, relativePath);
  let current;
  try { current = await readFile(target); } catch { current = undefined; }
  if (current === undefined || !current.equals(content)) {
    mismatches.push(relativePath);
    if (!checkOnly) await writeFile(target, content);
  }
}
if (checkOnly && mismatches.length > 0) {
  console.error(`marketplace bundle drift: ${mismatches.join(", ")}`);
  process.exit(1);
}
if (!checkOnly) console.log(`marketplace bundle synchronized (${expected.size} files)`);
