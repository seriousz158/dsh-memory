/**
 * Host-owned sync transaction: wraps the FD-anchored Python apply helper so the
 * memory synchronizer can stage model edits and apply them to the live root
 * without ever letting headless DSH touch the live memory repository.
 *
 * Every operation returns the same envelope as the Python helper:
 *   { ok: true, value } | { ok: false, error: { code } }
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const execFile = promisify(execFileCallback);
const SYNC_APPLY_SCRIPT = fileURLToPath(new URL("./sync-apply.py", import.meta.url));
export const PYTHON_CANDIDATES = Object.freeze([
  process.env.DPSK_PYTHON3,
  "/opt/homebrew/opt/python@3.11/libexec/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/bin/python3",
  "python3",
].filter(Boolean));

export function syncError(code) {
  return Object.assign(new Error("memory sync failed: " + code), { memoryCode: code });
}

/** Stable machine timestamp for a run id: YYYYMMDDTHHMMSSZ-<hex>. */
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const random = Math.random().toString(16).slice(2, 10);
  return `${stamp}-${random}`;
}

async function invokePython(operation, args = {}) {
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
      if (typeof result?.error?.code === "string") throw syncError(result.error.code);
      throw syncError("sync-failed");
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
          if (typeof failed?.error?.code === "string") throw syncError(failed.error.code);
        } catch (parseError) {
          if (parseError?.memoryCode) throw parseError;
        }
      }
      if (error?.memoryCode) throw error;
      throw syncError("sync-failed");
    }
  }
  throw Object.assign(new Error("Python 3 is unavailable for the memory sync helper"), { memoryCode: "sync-unavailable", cause: unavailable });
}

/**
 * A sync transaction is scoped to a single run id. The caller orchestrates the
 * steps; this class owns the subprocess bridge and the journal read helpers.
 */
export class SyncTransaction {
  constructor(root) {
    this.root = root;
  }

  async stageCopy(staging, manifest) {
    return await invokePython("stage-copy", { root: this.root, staging, manifest });
  }

  async verifyStaging(staging, manifest) {
    return await invokePython("verify-staging", { root: this.root, staging, manifest });
  }

  async diff(staging, manifest) {
    return await invokePython("diff", { staging, manifest });
  }

  async mirrorPayload(staging) {
    return await invokePython("mirror-payload", { root: this.root, staging });
  }

  async apply(staging, manifest, runId, startedAt) {
    return await invokePython("apply", { root: this.root, staging, manifest, "run-id": runId, "started-at": startedAt });
  }

  async recoverActive() {
    return await invokePython("recover-active", { root: this.root });
  }

  async journal(record) {
    const args = {
      root: this.root,
      "run-id": record.runId,
      "operation-name": record.operation ?? "sync",
      status: record.status,
      "started-at": record.startedAt,
      "processed-sessions": record.processedSessions ?? 0,
      "skipped-sessions": record.skippedSessions ?? 0,
      "candidate-sessions": record.candidateSessions ?? 0,
      "changed-paths": (record.changedPaths ?? []).join(","),
      "recovery-commit": record.recoveryCommit,
      "apply-commit": record.applyCommit,
      "error-code": record.errorCode,
      phase: record.phase,
      "staging-digest": record.stagingDigest,
      "duration-ms": record.durationMs,
      "rejected-file-count": record.rejectedFileCount ?? 0,
    };
    return await invokePython("journal", args);
  }

  async finalize(record, lastSync) {
    const args = {
      root: this.root,
      "run-id": record.runId,
      "operation-name": record.operation ?? "sync",
      status: record.status,
      "started-at": record.startedAt,
      "processed-sessions": record.processedSessions ?? 0,
      "skipped-sessions": record.skippedSessions ?? 0,
      "candidate-sessions": record.candidateSessions ?? 0,
      "changed-paths": (record.changedPaths ?? []).join(","),
      "recovery-commit": record.recoveryCommit,
      "apply-commit": record.applyCommit,
      "error-code": record.errorCode,
      phase: record.phase,
      "staging-digest": record.stagingDigest,
      "duration-ms": record.durationMs,
      "rejected-file-count": record.rejectedFileCount ?? 0,
      "last-sync": lastSync,
    };
    return await invokePython("finalize", args);
  }
}

export async function readLastRun(root) {
  try {
    return JSON.parse(await readFile(join(root, ".sync", "last-run.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function listRuns(root) {
  try {
    const entries = await readdir(join(root, ".sync", "runs"));
    return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
  } catch {
    return [];
  }
}
