import { open, mkdir, readFile, unlink, writeFile, lstat, rename, readdir } from "node:fs/promises";
import { join } from "node:path";

const SYNC_DIR = ".sync";
const LOCK_FILE = "operation.lock";
const ACTIVE_FILE = "active-run.json";
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

function operationError(code) {
  return Object.assign(new Error(`memory operation failed: ${code}`), { memoryCode: code });
}

async function ensureSyncDirectory(root) {
  const directory = join(root, SYNC_DIR);
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw operationError("unsafe-layout");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return directory;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function writeJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); }
  catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function acquireOperationLock(root, { operation, runId, staleAfterMs = DEFAULT_STALE_MS }) {
  const directory = await ensureSyncDirectory(root);
  const path = join(directory, LOCK_FILE);
  const lock = {
    operation,
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(lock, null, 2) + "\n", "utf8"); }
      finally { await handle.close(); }
      return { staleRecovered: attempt === 1 };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(path);
      const started = Date.parse(existing?.startedAt ?? "");
      const fresh = Number.isFinite(started) && Date.now() - started < staleAfterMs;
      if (processAlive(existing?.pid) || fresh) throw operationError("operation-in-progress");
      await unlink(path).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw operationError("operation-in-progress");
      });
    }
  }
  throw operationError("operation-in-progress");
}

export async function releaseOperationLock(root, runId) {
  const directory = await ensureSyncDirectory(root);
  const path = join(directory, LOCK_FILE);
  const existing = await readJson(path);
  if (existing !== null && runId !== undefined && existing.runId !== runId) {
    throw operationError("operation-in-progress");
  }
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export async function writeActiveRun(root, record) {
  const directory = await ensureSyncDirectory(root);
  await writeJson(join(directory, ACTIVE_FILE), record);
  return record;
}

export async function readActiveRun(root) {
  return await readJson(join(root, SYNC_DIR, ACTIVE_FILE));
}

export async function readOperationLock(root) {
  return await readJson(join(root, SYNC_DIR, LOCK_FILE));
}

export async function clearActiveRun(root, runId = undefined) {
  const directory = await ensureSyncDirectory(root);
  const path = join(directory, ACTIVE_FILE);
  const existing = await readJson(path);
  if (existing !== null && runId !== undefined && existing.runId !== runId) return false;
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

export async function listPendingPreviews(root) {
  const directory = join(root, SYNC_DIR, "previews");
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw operationError("unsafe-layout");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const previews = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes("/")) continue;
    const metadata = await readJson(join(directory, entry.name, "preview.json"));
    if (metadata?.preview_id === entry.name) previews.push(metadata);
  }
  return previews.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
}

export async function readPreview(root, previewId) {
  if (typeof previewId !== "string" || !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(previewId)) return null;
  return await readJson(join(root, SYNC_DIR, "previews", previewId, "preview.json"));
}

export function isPreviewExpired(preview, now = Date.now()) {
  const expiresAt = Date.parse(preview?.expires_at ?? "");
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export { DEFAULT_STALE_MS };
