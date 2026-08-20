import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import {
  acquireOperationLock,
  clearActiveRun,
  isPreviewExpired,
  listPendingPreviews,
  processAlive,
  readActiveRun,
  readOperationLock,
  releaseOperationLock,
  writeActiveRun,
} from "./operation-lock.js";

const execFile = promisify(execFileCallback);
const NS = settingsNamespace("memory");
const TARGETS = Object.freeze(["summary.md", "handbook", "rollouts", "archive"]);
export const DEFAULT_DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
export const DEFAULT_MEMORY_ROOT = resolve(
  process.env.DSH_MEMORY_ROOT || join(DEFAULT_DSH_HOME, "storages", "memory"),
);
const SAFE_CLEAR_SCRIPT = fileURLToPath(new URL("./safe-clear.py", import.meta.url));
const SYNC_APPLY_SCRIPT = fileURLToPath(new URL("./sync-apply.py", import.meta.url));
const PYTHON_CANDIDATES = Object.freeze([
  process.env.DPSK_PYTHON3,
  "/opt/homebrew/opt/python@3.11/libexec/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/bin/python3",
  "python3",
].filter(Boolean));
const Config = z.object({ enabled: z.boolean().default(true) });
const MEMORY_SECTION = `长期记忆已开启（DPSK 专属仓库 ${DEFAULT_MEMORY_ROOT}，git 版本化；操作手册见 memory 技能）。

自动行为，用户无需提醒：
1. 每个任务动手前：先读 ${DEFAULT_MEMORY_ROOT}/summary.md，并按关键词 grep handbook/ 检索相关记忆；命中则遵循，无命中直接开始，不要向用户询问"要不要回忆"。
2. 完成重要任务或会话收尾时：自动用子代理执行记忆提取（extract → rollouts/）与整合（consolidate → handbook/ 与 summary.md），随后在仓库内 git add -A && git commit。
3. 用户纠正偏好或告知新约定时：立即更新对应记忆条目。

硬规则：只存证据化结论；禁存凭据（写入 [REDACTED]）；原始会话日志只读；宁缺毋滥。
`;

export const name = "dsh-memory";
export const inject = ["settings"];
let currentSource = () => ({ enabled: true });
let refreshPrompt = () => {};

function failure(code) { return Object.freeze({ ok: false, error: Object.freeze({ code }) }); }
function success(value) { return Object.freeze({ ok: true, value: Object.freeze(value) }); }

async function readFileSafe(path, encoding) {
  return await readFile(path, encoding);
}
async function writeFileSafe(path, data, options) {
  return await writeFile(path, data, options);
}
async function mkdirSafe(path) {
  return await mkdir(path, { recursive: true });
}
function hasFrontMatter(content) {
  return content.startsWith("---\n") || content.startsWith("---\r\n");
}

/** Recursively list files under a payload directory as root-relative paths. */
async function listPayloadFiles(directory, prefix) {
  const { readdir } = await import("node:fs/promises");
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await listPayloadFiles(join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}
function layoutError() { return Object.assign(new Error("unsafe memory layout"), { memoryCode: "unsafe-layout" }); }
function clearError() { return Object.assign(new Error("memory layout changed while clearing"), { memoryCode: "clear-failed" }); }
function memoryError(code) { return Object.assign(new Error("memory operation failed: " + code), { memoryCode: code }); }
function operationRunId(operation) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${operation}-${process.pid}`;
}
function sameEntries(left, right) {
  const normalize = (entries) => entries.map((entry) => entry.mode + "\0" + entry.object + "\0" + entry.path).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
async function statOrUndefined(path) { try { return await lstat(path); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
async function safeClear(root, operation, token = undefined) {
  const args = [SAFE_CLEAR_SCRIPT, operation, "--root", root];
  if (token !== undefined) args.push("--token", token);
  let unavailable;
  for (const python of PYTHON_CANDIDATES) {
    try {
      const output = await execFile(python, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      const result = JSON.parse(output.stdout);
      if (result?.ok === true) return result.value;
      if (typeof result?.error?.code === "string") throw memoryError(result.error.code);
      throw clearError();
    } catch (error) {
      if (error?.code === "ENOENT") {
        unavailable = error;
        continue;
      }
      if (error?.memoryCode) throw error;
      throw clearError();
    }
  }
  throw Object.assign(new Error("Python 3 is unavailable for the memory safety helper"), { memoryCode: "repo-unavailable", cause: unavailable });
}
/** Invoke the FD-anchored sync apply helper for a host-side operation. */
async function invokeSyncApply(operation, args = {}) {
  const argv = [SYNC_APPLY_SCRIPT, operation];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    argv.push(`--${key}`, String(value));
  }
  let unavailable;
  for (const python of PYTHON_CANDIDATES) {
    try {
      const output = await execFile(python, argv, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      const result = JSON.parse(output.stdout);
      if (result?.ok === true) return result.value;
      if (typeof result?.error?.code === "string") throw memoryError(result.error.code);
      throw memoryError("sync-failed");
    } catch (error) {
      if (error?.code === "ENOENT") {
        unavailable = error;
        continue;
      }
      // The helper exits non-zero on SyncError but still writes the error
      // envelope to stdout; recover the machine code instead of collapsing to
      // a generic sync-failed.
      if (typeof error?.stdout === "string") {
        try {
          const failed = JSON.parse(error.stdout);
          if (typeof failed?.error?.code === "string") throw memoryError(failed.error.code);
        } catch (parseError) {
          if (parseError?.memoryCode) throw parseError;
        }
      }
      if (error?.memoryCode) throw error;
      throw memoryError("sync-failed");
    }
  }
  throw Object.assign(new Error("Python 3 is unavailable for the memory sync helper"), { memoryCode: "sync-unavailable", cause: unavailable });
}
/** A browser can never choose this path. Test roots require __testOnly. */
export class MemoryRepository {
  constructor(options = {}) {
    if (options.root !== undefined && options.__testOnly !== true) throw new TypeError("memory root is fixed outside tests");
    this.root = resolve(options.root ?? DEFAULT_MEMORY_ROOT);
  }
  async git(args, options = {}) {
    const { env, ...spawnOptions } = options;
    return await execFile("/usr/bin/git", ["-C", this.root, ...args], {
      encoding: "utf8",
      ...spawnOptions,
      env: env === undefined ? process.env : { ...process.env, ...env },
    });
  }
  async snapshotIndex() {
    const rawIndexPath = (await this.git(["rev-parse", "--git-path", "index"])).stdout.trim();
    const indexPath = resolve(this.root, rawIndexPath);
    const indexRelative = relative(this.root, indexPath);
    if (indexRelative === "" || indexRelative === ".." || indexRelative.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)) throw layoutError();
    const indexStat = await statOrUndefined(indexPath);
    if (indexStat !== undefined && (indexStat.isSymbolicLink() || !indexStat.isFile())) throw layoutError();
    const backupDirectory = await mkdtemp(join(tmpdir(), "dpsk-memory-index-"));
    const backupPath = join(backupDirectory, "index");
    try {
      if (indexStat !== undefined) await copyFile(indexPath, backupPath);
      return {
        restore: async () => {
          if (indexStat === undefined) await unlink(indexPath).catch(() => {});
          else await copyFile(backupPath, indexPath);
        },
        dispose: async () => {
          await unlink(backupPath).catch(() => {});
          await rmdir(backupDirectory).catch(() => {});
        },
      };
    } catch (error) {
      await unlink(backupPath).catch(() => {});
      await rmdir(backupDirectory).catch(() => {});
      throw error;
    }
  }
  async inspect() {
    try {
      const stat = await lstat(this.root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw layoutError();
      const actual = await realpath(this.root);
      // macOS commonly canonicalizes /var to /private/var. The selected root
      // itself still may not be a symlink; use the canonical identity below.
      this.root = actual;
      if (resolve((await this.git(["rev-parse", "--show-toplevel"])).stdout.trim()) !== this.root) throw layoutError();
      for (const target of TARGETS) if (relative(actual, resolve(actual, target)).startsWith("..")) throw layoutError();
      await safeClear(actual, "inspect");
      return actual;
    } catch (error) {
      if (error?.memoryCode) throw error;
      throw Object.assign(new Error("memory repository unavailable"), { memoryCode: "repo-unavailable", cause: error });
    }
  }
  async alternateIndex(callback) {
    const directory = await mkdtemp(join(tmpdir(), "dpsk-memory-alt-index-"));
    const indexPath = join(directory, "index");
    try {
      return await callback({ GIT_INDEX_FILE: indexPath });
    } finally {
      await unlink(indexPath).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
  }
  async targetIndexPaths(options = {}) {
    const raw = (await this.git(["ls-files", "-s", "-z", "--", ...TARGETS], options)).stdout;
    return [...new Set(raw.split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\t") + 1)))];
  }
  async removeTargetIndex(options = {}) {
    for (const path of await this.targetIndexPaths(options)) await this.git(["update-index", "--force-remove", "--", path], options);
  }
  async buildTargetCommit(base, entries, message) {
    return await this.alternateIndex(async (env) => {
      await this.git(["read-tree", base], { env });
      await this.removeTargetIndex({ env });
      for (const entry of entries) await this.git(["update-index", "--add", "--cacheinfo", entry.mode + "," + entry.object + "," + entry.path], { env });
      const tree = (await this.git(["write-tree"], { env })).stdout.trim();
      const baseTree = (await this.git(["rev-parse", base + "^{tree}"])).stdout.trim();
      if (tree === baseTree) return null;
      return (await this.git(["commit-tree", tree, "-p", base, "-m", message])).stdout.trim();
    });
  }
  async replaceCurrentIndex(entries) {
    await this.removeTargetIndex();
    for (const entry of entries) await this.git(["update-index", "--add", "--cacheinfo", entry.mode + "," + entry.object + "," + entry.path]);
  }
  async restoreStage(root, token) {
    if (token === undefined) return;
    try { await safeClear(root, "restore", token); } catch {}
  }
  async status() {
    try {
      const root = await this.inspect();
      const { dataFileCount } = await safeClear(root, "inspect");
      const targetDirty = (await this.git(["status", "--porcelain", "--", ...TARGETS])).stdout.trim().length > 0;
      const { legacyFileCount, pendingMigration } = await this.metadataStats(root);
      const lastRun = await this.readLastRun(root);
      const pendingPreview = (await this.validPendingPreviews(root))[0] ?? null;
      return success({
        empty: dataFileCount === 0,
        dataFileCount,
        targetDirty,
        recoverable: true,
        schemaVersion: 1,
        legacyFileCount,
        pendingMigration,
        lastRun,
        pendingPreview,
      });
    } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
  }

  async validPendingPreviews(root, now = Date.now()) {
    return (await listPendingPreviews(root)).filter((preview) => !isPreviewExpired(preview, now));
  }

  async journalIsReadable(root) {
    try {
      const runIds = await this.listRunIds(root);
      for (const runId of runIds) {
        const record = await this.readRun(root, runId);
        if (record === null || typeof record !== "object") return false;
      }
      const lastRun = await readFileSafe(join(root, ".sync", "last-run.json"), "utf8").catch(() => null);
      if (lastRun !== null) JSON.parse(lastRun);
      return true;
    } catch { return false; }
  }

  async health() {
    try {
      const root = await this.inspect();
      const { dataFileCount } = await safeClear(root, "inspect");
      const payloadDirty = (await this.git(["status", "--porcelain", "--", ...TARGETS])).stdout.trim().length > 0;
      const operationLock = await readOperationLock(root);
      const activeRun = await readActiveRun(root);
      const activeState = activeRun === null ? null : processAlive(activeRun.pid) ? "running" : "interrupted";
      const previews = await this.validPendingPreviews(root);
      const journalReadable = await this.journalIsReadable(root);
      const interruptedRun = activeState === "interrupted"
        ? activeRun
        : (await this.readLastRun(root))?.status === "interrupted" ? await this.readLastRun(root) : null;
      return success({
        memoryRoot: root,
        rootSafe: true,
        gitAvailable: true,
        dataFileCount,
        payloadDirty,
        operationLock: operationLock === null ? null : {
          operation: operationLock.operation ?? null,
          pid: operationLock.pid ?? null,
          runId: operationLock.runId ?? null,
          startedAt: operationLock.startedAt ?? null,
          active: processAlive(operationLock.pid),
        },
        activeRun: activeRun === null ? null : { ...activeRun, state: activeState },
        interruptedRun,
        pendingPreview: previews[0] ?? null,
        pendingPreviewCount: previews.length,
        journalReadable,
        needsManualRecovery: payloadDirty || activeState === "interrupted" || interruptedRun !== null || !journalReadable,
      });
    } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
  }

  async metadataStats(root) {
    let legacyFileCount = 0;
    try {
      const files = await this.payloadFiles(root);
      for (const file of files) {
        if (file === "summary.md") continue; // navigation file, not a memory record
        if (!/\.md$/.test(file)) continue;
        const content = await readFileSafe(join(root, file), "utf8");
        if (!hasFrontMatter(content)) legacyFileCount += 1;
      }
      return { legacyFileCount, pendingMigration: legacyFileCount > 0 };
    } catch {
      return { legacyFileCount: 0, pendingMigration: false };
    }
  }

  async payloadFiles(root) {
    const raw = (await this.git(["ls-files", "-z", "--", ...TARGETS])).stdout;
    return raw.split("\0").filter(Boolean);
  }

  /** Hash of the payload file paths+modes+blobs at a commit (stable id). */
  async payloadTree(commit) {
    const raw = (await this.git(["ls-tree", "-r", "-z", commit, "--", ...TARGETS])).stdout;
    const entries = raw.split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      const [meta, path] = [entry.slice(0, tab), entry.slice(tab + 1)];
      const [, , object] = meta.split(" ");
      return `${object} ${path}`;
    }).sort();
    return entries.join("\n");
  }

  /** Git entries (mode/object/path) for the payload of a commit tree. */
  async treeEntries(commit) {
    const raw = (await this.git(["ls-tree", "-r", "-z", commit, "--", ...TARGETS])).stdout;
    return raw.split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      const [meta, path] = [entry.slice(0, tab), entry.slice(tab + 1)];
      const [mode, , object] = meta.split(" ");
      return { mode, object, path };
    });
  }

  async readLastRun(root) {
    try {
      const raw = await readFileSafe(join(root, ".sync", "last-run.json"), "utf8");
      const parsed = JSON.parse(raw);
      return {
        runId: parsed.run_id ?? null,
        status: parsed.status ?? null,
        changedFileCount: (parsed.changed_paths ?? []).length,
        applyCommit: parsed.apply_commit ?? null,
      };
    } catch { return null; }
  }

  async runs(request = {}) {
    const limit = Number.isInteger(request?.limit) && request.limit > 0 ? request.limit : 20;
    try {
      const root = await this.inspect();
      const runIds = (await this.listRunIds(root)).sort().reverse().slice(0, limit);
      const runs = [];
      for (const runId of runIds) {
        const record = await this.readRun(root, runId);
        if (record && (request?.operation === undefined || record.operation === request.operation)
          && (request?.status === undefined || record.status === request.status)) runs.push(record);
      }
      return success({ runs });
    } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
  }

  async listRunIds(root) {
    try {
      const raw = (await this.git(["ls-files", "-z", "--", ".sync/runs"])).stdout;
      return raw.split("\0").filter(Boolean).map((path) => path.replace(/^\.sync\/runs\//, "").replace(/\.json$/, ""));
    } catch { return []; }
  }

  async readRun(root, runId) {
    try {
      const raw = await readFileSafe(join(root, ".sync", "runs", `${runId}.json`), "utf8");
      return JSON.parse(raw);
    } catch { return null; }
  }

  async rollback(request) {
    if (request?.confirmation !== "ROLLBACK_MEMORY") return failure("rollback-invalid-confirmation");
    if (typeof request?.runId !== "string" || request.runId.length === 0) return failure("rollback-run-not-found");
    const root = await this.inspect().catch(() => null);
    if (root === null) return failure("repo-unavailable");
    const run = await this.readRun(root, request.runId);
    if (run === null) return failure("rollback-run-not-found");
    if (run.status !== "applied" || typeof run.recovery_commit !== "string" || typeof run.apply_commit !== "string") return failure("rollback-not-applicable");
    const head = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    // The apply commit must still be the latest payload write. Journal commits
    // after it only touch .sync, so compare payload trees instead of HEAD.
    const applyPayload = await this.payloadTree(run.apply_commit);
    const headPayload = await this.payloadTree(head);
    if (applyPayload !== headPayload) return failure("rollback-conflict");
    const operationId = operationRunId("rollback");
    let lockAcquired = false;
    try {
      await acquireOperationLock(root, { operation: "rollback", runId: operationId });
      lockAcquired = true;
      const active = {
        schema_version: 1,
        run_id: operationId,
        operation: "rollback",
        status: "running",
        phase: "staging",
        pid: process.pid,
        started_at: new Date().toISOString(),
      };
      await writeActiveRun(root, active);
      // Rollback restores the payload to the recovery commit's tree, then adds
      // the rollback journal record on top. The base is the current HEAD so the
      // rollback commit records a real payload change.
      active.phase = "applying";
      await writeActiveRun(root, active);
      const recoveryEntries = await this.treeEntries(run.recovery_commit);
      const rollbackCommit = await this.buildTargetCommit(head, recoveryEntries, `DPSK memory rollback: ${request.runId}`);
      if (rollbackCommit === null) return failure("rollback-not-applicable");
      const liveEntries = (await safeClear(root, "snapshot-live")).entries;
      await this.replaceCurrentIndex(liveEntries);
      await this.git(["update-ref", "HEAD", rollbackCommit, head]);
      // Restore the live payload worktree from the rollback commit. Only the
      // payload paths are touched; .sync, .last-sync, README, and scripts stay.
      const payloadPaths = (await this.git(["ls-tree", "-r", "--name-only", "-z", rollbackCommit, "--", ...TARGETS])).stdout.split("\0").filter(Boolean);
      const payloadSet = new Set(payloadPaths);
      for (const directory of ["handbook", "rollouts", "archive"]) {
        await mkdirSafe(join(root, directory));
      }
      if (payloadPaths.length > 0) {
        await this.git(["checkout", rollbackCommit, "--", ...payloadPaths]);
      }
      // Remove payload files that exist in the worktree but not in the rollback
      // tree (they were added by the sync run being rolled back).
      for (const directory of ["handbook", "rollouts", "archive"]) {
        const dirRoot = join(root, directory);
        for (const file of await listPayloadFiles(dirRoot, directory)) {
          if (!payloadSet.has(file)) {
            await unlink(join(root, file)).catch(() => {});
            await this.git(["update-index", "--force-remove", "--", file]).catch(() => {});
          }
        }
      }
      active.phase = "finalizing";
      await writeActiveRun(root, active);
      const now = new Date().toISOString();
      const rollbackRecord = {
        schema_version: 1,
        run_id: `${now.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-rollback`,
        operation: "rollback",
        status: "rolled_back",
        started_at: now,
        finished_at: now,
        candidate_sessions: 0,
        processed_sessions: 0,
        skipped_sessions: 0,
        changed_paths: [],
        recovery_commit: head, // the pre-rollback HEAD (the original apply commit)
        apply_commit: rollbackCommit,
        error_code: null,
      };
      await this.writeRun(root, rollbackRecord);
      return success({ rollbackCommit, runId: request.runId });
    } catch (error) {
      return failure(error?.memoryCode ?? "rollback-failed");
    } finally {
      if (lockAcquired) {
        await clearActiveRun(root, operationId).catch(() => {});
        await releaseOperationLock(root, operationId).catch(() => {});
      }
    }
  }

  /** List pending (non-expired) previews, newest first. */
  async previews() {
    try {
      const root = await this.inspect();
      return success({ previews: await this.validPendingPreviews(root) });
    } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
  }

  /**
   * Apply a pending preview's staged payload as a normal sync transaction.
   * The preview is consumed: its payload becomes the live memory tree and the
   * preview record is removed. Returns the same shape as a sync apply.
   */
  async applyPreview(request) {
    if (request?.previewId === undefined || typeof request.previewId !== "string" || request.previewId.length === 0) {
      return failure("preview-invalid-request");
    }
    let root;
    try { root = await this.inspect(); } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
    const operationId = operationRunId("preview-apply");
    let lockAcquired = false;
    try {
      await acquireOperationLock(root, { operation: "preview-apply", runId: operationId });
      lockAcquired = true;
      const startedAt = new Date().toISOString();
      const value = await invokeSyncApply("apply-preview", {
        root,
        "run-id": request.previewId,
        "operation-name": "preview",
        "started-at": startedAt,
      });
      // Consume the preview and journal the apply under the preview id so the
      // run is auditable and rollbackable like any other sync.
      await invokeSyncApply("remove-preview", { root, "run-id": request.previewId }).catch(() => null);
      const record = {
        schema_version: 1,
        run_id: request.previewId,
        operation: "preview",
        status: value.status ?? "applied",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        candidate_sessions: value.candidate_sessions ?? 0,
        processed_sessions: value.processed_sessions ?? 0,
        skipped_sessions: 0,
        changed_paths: value.changed_paths ?? [],
        recovery_commit: value.recovery_commit ?? null,
        apply_commit: value.apply_commit ?? null,
        error_code: null,
      };
      await this.writeRun(root, record);
      return success({ ...value, previewId: request.previewId, journaled: true });
    } catch (error) {
      return failure(error?.memoryCode ?? "preview-apply-failed");
    } finally {
      if (lockAcquired) {
        await clearActiveRun(root, operationId).catch(() => {});
        await releaseOperationLock(root, operationId).catch(() => {});
      }
    }
  }

  /** Remove a pending preview without applying it. */
  async discardPreview(request) {
    if (request?.previewId === undefined || typeof request.previewId !== "string" || request.previewId.length === 0) {
      return failure("preview-invalid-request");
    }
    try {
      const root = await this.inspect();
      const value = await invokeSyncApply("remove-preview", { root, "run-id": request.previewId });
      if (value?.removed !== true) return failure("preview-not-found");
      return success({ removed: true, previewId: request.previewId });
    } catch (error) {
      return failure(error?.memoryCode ?? "preview-not-found");
    }
  }

  async writeRun(root, record) {
    await mkdirSafe(join(root, ".sync", "runs"));
    const body = JSON.stringify(record, null, 2) + "\n";
    await writeFileSafe(join(root, ".sync", "runs", `${record.run_id}.json`), body, { mode: 0o600 });
    const last = {
      run_id: record.run_id,
      operation: record.operation,
      status: record.status,
      started_at: record.started_at,
      finished_at: record.finished_at,
      changed_paths: record.changed_paths ?? [],
      recovery_commit: record.recovery_commit ?? null,
      apply_commit: record.apply_commit ?? null,
      error_code: record.error_code ?? null,
    };
    await writeFileSafe(join(root, ".sync", "last-run.json"), JSON.stringify(last, null, 2) + "\n", { mode: 0o600 });
    await this.git(["add", "--", ".sync"]);
    await this.git(["commit", "-m", `DPSK memory journal: ${record.run_id}`, "--", ".sync"]);
  }
  async clear(request) {
    if (request?.confirmation !== "DELETE_MEMORY") return failure("clear-failed");
    let root;
    try { root = await this.inspect(); } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
    const operationId = operationRunId("clear");
    let lockAcquired = false;
    try {
      await acquireOperationLock(root, { operation: "clear", runId: operationId });
      lockAcquired = true;
      const active = {
        schema_version: 1,
        run_id: operationId,
        operation: "clear",
        status: "running",
        phase: "staging",
        pid: process.pid,
        started_at: new Date().toISOString(),
      };
      await writeActiveRun(root, active);
      const before = await this.status();
      if (!before.ok) return before;
      if (before.value.empty) return success({ alreadyEmpty: true, clearedFileCount: 0, recoveryCommit: null, clearCommit: null });
      let recoveryCommit = null;
      let clearCommit = null;
      let head = null;
      let stage;
      let indexSnapshot;
      let recoveryEntries;
      try {
        recoveryEntries = (await safeClear(root, "snapshot-live")).entries;
        head = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
        recoveryCommit = await this.buildTargetCommit(head, recoveryEntries, "DPSK memory recovery checkpoint");
        if (recoveryCommit === null) recoveryCommit = head;
      } catch (error) {
        return failure(error?.memoryCode ?? "checkpoint-failed");
      }
      active.phase = "validating";
      await writeActiveRun(root, active);
      try {
        root = await this.inspect();
        stage = await safeClear(root, "stage");
        const stagedEntries = (await safeClear(root, "snapshot", stage.token)).entries;
        if (!sameEntries(recoveryEntries, stagedEntries)) throw clearError();
        await safeClear(root, "verify");
        const emptyObject = (await this.git(["hash-object", "-w", "/dev/null"])).stdout.trim();
        clearCommit = await this.buildTargetCommit(recoveryCommit, [{ path: "summary.md", mode: "100644", object: emptyObject }], "DPSK memory cleared");
        if (clearCommit === null) throw clearError();
        indexSnapshot = await this.snapshotIndex();
        active.phase = "applying";
        await writeActiveRun(root, active);
        await this.replaceCurrentIndex([{ path: "summary.md", mode: "100644", object: emptyObject }]);
        await this.git(["update-ref", "HEAD", clearCommit, head]);
      } catch (error) {
        try { await indexSnapshot?.restore(); } catch {}
        await this.restoreStage(root, stage?.token);
        return failure(error?.memoryCode ?? "commit-failed");
      } finally {
        await indexSnapshot?.dispose();
      }
      active.phase = "finalizing";
      await writeActiveRun(root, active);
      try {
        await safeClear(root, "finalize", stage.token);
      } catch {
        // The clear commit and live target paths are durable; retain the
        // FD-anchored staging directory instead of a path-based cleanup.
      }
      return success({ alreadyEmpty: false, clearedFileCount: before.value.dataFileCount, recoveryCommit, clearCommit });
    } catch (error) {
      return failure(error?.memoryCode ?? "clear-failed");
    } finally {
      if (lockAcquired) {
        await clearActiveRun(root, operationId).catch(() => {});
        await releaseOperationLock(root, operationId).catch(() => {});
      }
    }
  }
}

/** Narrow bridge for the local UI: it can only read or write memory.enabled. */
export class MemorySettingsBridge {
  scope = undefined;
  bind(scope) { this.scope = scope; }
  unbind(scope) { if (this.scope === scope) this.scope = undefined; }
  async read() {
    const scope = this.scope;
    if (scope === undefined) return failure("settings-unavailable");
    try { return success({ enabled: scope.get().enabled ?? true }); }
    catch { return failure("settings-unavailable"); }
  }
  async setEnabled(request) {
    if (typeof request?.enabled !== "boolean") return failure("settings-invalid-request");
    const scope = this.scope;
    if (scope === undefined) return failure("settings-unavailable");
    try {
      await scope.update({ enabled: request.enabled });
      return success({ enabled: scope.get().enabled ?? request.enabled });
    } catch { return failure("settings-write-failed"); }
  }
}

// Compact lowering of the standard decorators generated by DSH's typert build.
const REMOTE_INITIALIZERS = [];
const decorate = (ctor, name, decorator) => {
  const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, name);
  decorator(descriptor.value, { kind: "method", name, static: false, private: false, access: { has: (value) => name in value, get: (value) => value[name] }, addInitializer(initializer) { REMOTE_INITIALIZERS.push(initializer); } });
};
export class MemoryService extends TypertRemoteService {
  constructor(ctx, options = {}) {
    super(ctx, "memory");
    for (const initialize of REMOTE_INITIALIZERS) initialize.call(this);
    this.repository = new MemoryRepository(options);
    this.settings = options.settings ?? new MemorySettingsBridge();
  }
  async getSettings() { return await this.settings.read(); }
  async setEnabled(request) { return await this.settings.setEnabled(request); }
  async status() { return await this.repository.status(); }
  async health() { return await this.repository.health(); }
  async clear(request) { return await this.repository.clear(request); }
  async runs(request) { return await this.repository.runs(request); }
  async rollback(request) { return await this.repository.rollback(request); }
  async previews() { return await this.repository.previews(); }
  async applyPreview(request) { return await this.repository.applyPreview(request); }
  async discardPreview(request) { return await this.repository.discardPreview(request); }
}
decorate(MemoryService, "getSettings", Remote("getSettings"));
decorate(MemoryService, "setEnabled", Remote("setEnabled"));
decorate(MemoryService, "status", Remote("status"));
decorate(MemoryService, "health", Remote("health"));
decorate(MemoryService, "clear", Remote("clear"));
decorate(MemoryService, "runs", Remote("runs"));
decorate(MemoryService, "rollback", Remote("rollback"));
decorate(MemoryService, "previews", Remote("previews"));
decorate(MemoryService, "applyPreview", Remote("applyPreview"));
decorate(MemoryService, "discardPreview", Remote("discardPreview"));

export function apply(ctx, entry) {
  const settings = new MemorySettingsBridge();
  const scope = ctx.settings.register(NS, Config, { base: entry });
  settings.bind(scope);
  currentSource = () => scope.get();
  const stopWatching = scope.watch(() => refreshPrompt());
  ctx.effect(() => () => {
    stopWatching();
    settings.unbind(scope);
    currentSource = () => ({ enabled: true });
    refreshPrompt();
  }, "dsh-memory: settings cleanup");
  refreshPrompt();
  new MemoryService(ctx, { settings });
  ctx.inject(["systemPrompt"], (promptCtx) => {
    let disposeSection = null;
    const refresh = () => {
      disposeSection?.(); disposeSection = null;
      if (currentSource().enabled ?? true) disposeSection = promptCtx.systemPrompt.section({ name: "memory", order: 50, text: MEMORY_SECTION });
    };
    refreshPrompt = refresh;
    refresh();
    promptCtx.effect(() => () => { if (refreshPrompt === refresh) refreshPrompt = () => {}; disposeSection?.(); }, "dsh-memory: section cleanup");
  });
}
