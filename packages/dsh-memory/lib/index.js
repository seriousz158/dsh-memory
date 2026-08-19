import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { copyFile, lstat, mkdtemp, realpath, rmdir, unlink } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

const execFile = promisify(execFileCallback);
const NS = settingsNamespace("memory");
const TARGETS = Object.freeze(["summary.md", "handbook", "rollouts", "archive"]);
export const DEFAULT_DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
export const DEFAULT_MEMORY_ROOT = resolve(
  process.env.DSH_MEMORY_ROOT || join(DEFAULT_DSH_HOME, "storages", "memory"),
);
const SAFE_CLEAR_SCRIPT = fileURLToPath(new URL("./safe-clear.py", import.meta.url));
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
function layoutError() { return Object.assign(new Error("unsafe memory layout"), { memoryCode: "unsafe-layout" }); }
function clearError() { return Object.assign(new Error("memory layout changed while clearing"), { memoryCode: "clear-failed" }); }
function memoryError(code) { return Object.assign(new Error("memory operation failed: " + code), { memoryCode: code }); }
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
      return success({ empty: dataFileCount === 0, dataFileCount, targetDirty, recoverable: true });
    } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
  }
  async clear(request) {
    if (request?.confirmation !== "DELETE_MEMORY") return failure("clear-failed");
    let root;
    try { root = await this.inspect(); } catch (error) { return failure(error?.memoryCode ?? "repo-unavailable"); }
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
      await this.replaceCurrentIndex([{ path: "summary.md", mode: "100644", object: emptyObject }]);
      await this.git(["update-ref", "HEAD", clearCommit, head]);
    } catch (error) {
      try { await indexSnapshot?.restore(); } catch {}
      await this.restoreStage(root, stage?.token);
      return failure(error?.memoryCode ?? "commit-failed");
    } finally {
      await indexSnapshot?.dispose();
    }
    try {
      await safeClear(root, "finalize", stage.token);
    } catch {
      // The clear commit and live target paths are durable; retain the
      // FD-anchored staging directory instead of a path-based cleanup.
    }
    return success({ alreadyEmpty: false, clearedFileCount: before.value.dataFileCount, recoveryCommit, clearCommit });
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
  async clear(request) { return await this.repository.clear(request); }
}
decorate(MemoryService, "getSettings", Remote("getSettings"));
decorate(MemoryService, "setEnabled", Remote("setEnabled"));
decorate(MemoryService, "status", Remote("status"));
decorate(MemoryService, "clear", Remote("clear"));

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
