import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const USAGE_FILE = ".sync/usage.json";
export const USAGE_SCHEMA_VERSION = 1;
const MAX_USAGE_BYTES = 1024 * 1024;
const USAGE_LOCK = ".sync/usage.lock";
const USAGE_TEMP = ".sync/.usage.*.tmp";
const USAGE_LOCK_TIMEOUT_MS = 30_000;
const PAYLOAD_ROOTS = new Set(["handbook", "rollouts", "archive"]);
const usageQueues = new Map();

function usageError(code) {
  return Object.assign(new Error(`memory usage state is invalid: ${code}`), { memoryCode: code });
}

function isSafeUsagePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/")) return false;
  const parts = path.split("/");
  return parts.length >= 2
    && PAYLOAD_ROOTS.has(parts[0])
    && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
    && path.endsWith(".md");
}

function emptyUsage() {
  return { schema_version: USAGE_SCHEMA_VERSION, records: {} };
}

function validateUsage(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw usageError("usage-invalid");
  if (value.schema_version !== USAGE_SCHEMA_VERSION) throw usageError("usage-invalid");
  if (value.records === null || typeof value.records !== "object" || Array.isArray(value.records)) throw usageError("usage-invalid");
  const records = {};
  for (const [path, entry] of Object.entries(value.records)) {
    if (!isSafeUsagePath(path) || entry === null || typeof entry !== "object" || Array.isArray(entry)
      || !Number.isInteger(entry.usage_count) || entry.usage_count < 0 || entry.usage_count > Number.MAX_SAFE_INTEGER
      || (entry.last_usage !== null && typeof entry.last_usage !== "string")) {
      throw usageError("usage-invalid");
    }
    records[path] = {
      usage_count: entry.usage_count,
      last_usage: entry.last_usage,
    };
  }
  return { schema_version: USAGE_SCHEMA_VERSION, records };
}

async function ensurePrivateDirectory(path) {
  const stat = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) throw usageError("unsafe-layout");
  if (stat === null) await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function ensureGitExclude(root) {
  const gitRoot = join(root, ".git");
  const gitStat = await lstat(gitRoot).catch(() => null);
  if (gitStat === null || gitStat.isSymbolicLink() || !gitStat.isDirectory()) return;
  const infoRoot = join(gitRoot, "info");
  await ensurePrivateDirectory(infoRoot);
  const exclude = join(infoRoot, "exclude");
  const excludeStat = await lstat(exclude).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (excludeStat !== null && (excludeStat.isSymbolicLink() || !excludeStat.isFile())) throw usageError("unsafe-layout");
  const current = await readFile(exclude, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const lines = current.split(/\r?\n/);
  const missing = [USAGE_FILE, USAGE_LOCK, USAGE_TEMP].filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  const suffix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await writeFile(exclude, `${current}${suffix}${missing.join("\n")}\n`, { mode: 0o600 });
  await chmod(exclude, 0o600);
}

async function acquireUsageLock(syncRoot) {
  const lockPath = join(syncRoot, "usage.lock");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + "\n", { mode: 0o600 });
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockStat = await lstat(lockPath).catch(() => null);
      if (lockStat === null) continue;
      const owner = await readFile(join(lockPath, "owner.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
      const ownerPid = Number.isInteger(owner?.pid) ? owner.pid : null;
      let ownerAlive = false;
      if (ownerPid !== null && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          ownerAlive = true;
        } catch (ownerError) {
          ownerAlive = ownerError?.code === "EPERM";
        }
      }
      if (!ownerAlive && Date.now() - lockStat.mtimeMs > USAGE_LOCK_TIMEOUT_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw usageError("usage-busy");
}

async function cleanupUsageTemps(syncRoot) {
  const entries = await readdir(syncRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.name.startsWith(".usage.") || !entry.name.endsWith(".tmp")) continue;
    await rm(join(syncRoot, entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

async function withUsageLock(root, callback) {
  const previous = usageQueues.get(root) ?? Promise.resolve();
  let releaseQueue;
  const queued = new Promise((resolve) => { releaseQueue = resolve; });
  usageQueues.set(root, queued);
  await previous.catch(() => {});
  const syncRoot = join(root, ".sync");
  let lockPath;
  try {
    await ensurePrivateDirectory(syncRoot);
    lockPath = await acquireUsageLock(syncRoot);
    await cleanupUsageTemps(syncRoot);
    return await callback();
  } finally {
    if (lockPath !== undefined) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    releaseQueue();
    if (usageQueues.get(root) === queued) usageQueues.delete(root);
  }
}

export async function readUsage(root) {
  const usagePath = join(root, USAGE_FILE);
  const stat = await lstat(usagePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return emptyUsage();
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_USAGE_BYTES) throw usageError("unsafe-layout");
  const raw = await readFile(usagePath, "utf8");
  try {
    return validateUsage(JSON.parse(raw));
  } catch (error) {
    if (error?.memoryCode) throw error;
    throw usageError("usage-invalid");
  }
}

export async function recordUsage(root, paths, now = new Date()) {
  if (!Array.isArray(paths) || paths.some((path) => !isSafeUsagePath(path))) throw usageError("usage-invalid");
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return await readUsage(root);
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw usageError("usage-invalid");
  return await withUsageLock(root, async () => {
    const syncRoot = join(root, ".sync");
    const usage = await readUsage(root);
    const timestamp = date.toISOString();
    for (const path of uniquePaths) {
      const previous = usage.records[path] ?? { usage_count: 0, last_usage: null };
      usage.records[path] = {
        usage_count: previous.usage_count + 1,
        last_usage: timestamp,
      };
    }
    const usagePath = join(root, USAGE_FILE);
    const temporary = join(syncRoot, `.usage.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(usage)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, usagePath);
      await chmod(usagePath, 0o600);
      await ensureGitExclude(root);
    } catch (error) {
      await rename(temporary, usagePath).catch(() => {});
      throw error;
    }
    return usage;
  });
}

function usageOf(entry, usage) {
  const value = usage?.records?.[entry.path];
  return {
    usage_count: Number.isInteger(value?.usage_count) ? value.usage_count : 0,
    last_usage: typeof value?.last_usage === "string" ? value.last_usage : "",
  };
}

export function sortByUsage(entries, usage) {
  return [...entries].sort((left, right) => {
    const a = usageOf(left, usage);
    const b = usageOf(right, usage);
    return b.usage_count - a.usage_count
      || b.last_usage.localeCompare(a.last_usage)
      || String(left.path).localeCompare(String(right.path));
  });
}

export function usageMetadata(path, usage) {
  return usageOf({ path }, usage);
}

export function formatCitation(path, id = null) {
  return id === null || id === undefined
    ? `[source: ${path}]`
    : `[source: ${path} · id: ${id}]`;
}
