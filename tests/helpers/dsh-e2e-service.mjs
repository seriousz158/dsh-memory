// dsh-e2e-service: boot an isolated DSH web profile for end-to-end UI tests.
//
// The helper builds a throwaway DSH_HOME under the OS temp dir that reuses the
// pinned runtime and shared plugin store of the developer machine (or the
// DSH_RUNTIME_ROOT override), copies the local dsh-memory/dsh-memory-ui
// workspaces into a private module graph, and serves the web app on an
// ephemeral port with a minimal --patch that registers only the two memory
// plugins. The live ~/.dsh (or $DSH_HOME) is never touched, and no provider
// credentials are configured.
//
// A test that imports this module should call startIsolatedService() in a
// before() hook and stopIsolatedService() after the suite.

import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, symlink, mkdir, writeFile, readdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNC_APPLY = join(ROOT, "packages", "dsh-memory", "lib", "sync-apply.py");

// The shared plugin store that contains every @deepseek-ai/* bundle. Defaults
// to the deepseek-harness project runtime; an explicit DSH_RUNTIME_ROOT
// (pointing at a .dsh home with profiles/node_modules) overrides it. The two
// local dsh-memory packages are copied from this checkout below so E2E never
// silently exercises an installed profile copy.
const RUNTIME_ROOT = resolve(
  process.env.DSH_RUNTIME_ROOT
    || join(process.env.HOME || "", "projects", "deepseek-harness", ".dsh"),
);
const RUNTIME_HOME = join(RUNTIME_ROOT, "runtime", "dsh-0.1.0-rc.7");
const DSH_BIN = join(RUNTIME_HOME, "node_modules", ".bin", "dsh");
const SHARED_MODULES = join(RUNTIME_ROOT, "profiles", "node_modules");

let service = null;

function utcString(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function seedLastRun(root, status = "failed") {
  const runId = "20260821T000000Z-e2e00001";
  const startedAt = utcString(-60_000);
  const finishedAt = utcString();
  const record = {
    schema_version: 1,
    run_id: runId,
    operation: "sync",
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    changed_paths: status === "failed" ? ["handbook/fixture.md"] : [],
    recovery_commit: null,
    apply_commit: null,
    error_code: status === "failed" ? "provider-unavailable" : null,
  };
  await mkdir(join(root, ".sync", "runs"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".sync", "runs", `${runId}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await writeFile(join(root, ".sync", "last-run.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function seedPendingPreview(root, index = 2) {
  const previewId = `20260821T00000${index - 1}Z-e2e0000${index}`;
  await execFile("/usr/bin/python3", [SYNC_APPLY, "prepare-preview", "--root", root, "--run-id", previewId]);
  const staging = join(root, ".sync", "previews", previewId, "staging");
  const recordPath = join(staging, "handbook", `e2e-preview-${index}.md`);
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  await writeFile(recordPath, [
    "---",
    "schema_version: 1",
    `id: e2e/preview-${index}`,
    "type: fact",
    "status: active",
    `source_session_digest: e2e-preview-${index}`,
    "created_at: 2026-08-21",
    "updated_at: 2026-08-21",
    "---",
    "",
    "Isolated preview fixture.",
    "",
  ].join("\n"), { mode: 0o600 });
  const metadata = {
    preview_id: previewId,
    created_at: utcString(-60_000),
    expires_at: utcString(60 * 60 * 1000),
    candidate_sessions: 0,
    changed_paths: [`handbook/e2e-preview-${index}.md`],
    status: "pending",
  };
  await execFile("/usr/bin/python3", [
    SYNC_APPLY,
    "write-preview",
    "--root", root,
    "--run-id", previewId,
    "--preview-json", JSON.stringify(metadata),
  ]);
  return previewId;
}

export async function startIsolatedService(options = {}) {
  if (service) return service;
  const home = await mkdtemp(join(tmpdir(), "dsh-memory-e2e-"));
  const profiles = join(home, "profiles");
  await mkdir(profiles, { recursive: true });

  // Reuse the shared plugin store and the pinned per-plugin profiles. The
  // memory packages themselves must come from this checkout; otherwise a
  // stale ~/.dsh profile can make source regressions invisible to CI.
  const nodeModules = join(profiles, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  // Build a throwaway module directory instead of symlinking the shared
  // directory wholesale. DSH resolves package names through this location;
  // overriding the two memory entries here is what makes the E2E exercise
  // the checkout rather than the installed profile copy.
  for (const name of await readdir(SHARED_MODULES)) {
    if (name === "dsh-memory" || name === "dsh-memory-ui") continue;
    await symlink(join(SHARED_MODULES, name), join(nodeModules, name));
  }
  for (const name of ["dsh-memory", "dsh-memory-ui"]) {
    // Copy into the temporary profile so Node resolves the DSH peer packages
    // from the fixture's module graph, not from the checkout's node_modules
    // (which would create duplicate Cordis/React module instances).
    await cp(join(ROOT, "packages", name), join(nodeModules, name), { recursive: true });
  }
  for (const name of ["web", "headless", "dsh-memory", "dsh-memory-ui"]) {
    const source = name === "dsh-memory" || name === "dsh-memory-ui"
      ? join(nodeModules, name)
      : join(RUNTIME_ROOT, "profiles", name);
    await symlink(source, join(profiles, name), "dir");
  }

  // The memory settings UI registers through settings.general.item. A fresh
  // home has no settings yet; seed the onboarding acceptance and memory
  // defaults so the test hits the settings panel directly instead of the
  // first-run notice and provider onboarding flows.
  const settingsFile = join(home, "settings.yaml");
  await writeFile(settingsFile, [
    "ui-onboarding:",
    "  welcomeNoticeVersion: 2026-08-13.1",
    "memory:",
    "  enabled: true",
    "",
  ].join("\n"));

  // Seed an empty memory repository so the memory service reports healthy and
  // the panel shows the true empty states (no legacy records, no previews).
  // The repository must be a Git toplevel containing the four payload targets.
  const memoryRoot = join(home, "storages", "memory");
  await mkdir(join(memoryRoot, "handbook"), { recursive: true });
  await mkdir(join(memoryRoot, "rollouts"), { recursive: true });
  await mkdir(join(memoryRoot, "archive"), { recursive: true });
  await mkdir(join(memoryRoot, ".sync"), { recursive: true, mode: 0o700 });
  await writeFile(join(memoryRoot, "summary.md"), "# 长期记忆总览\n\n（空）\n");
  await writeFile(join(memoryRoot, "README.md"), "# Memory\n\nIsolated E2E fixture.\n");
  await writeFile(join(memoryRoot, ".sync", ".gitignore"), [
    "operation.lock",
    "active-run.json",
    "previews/",
    "usage.json",
    "usage.lock/",
    ".usage.*.tmp",
    "",
  ].join("\n"), { mode: 0o600 });
  await execFile("/usr/bin/git", ["-C", memoryRoot, "init", "-q"]);
  await execFile("/usr/bin/git", ["-C", memoryRoot, "add", "-A"]);
  await execFile("/usr/bin/git", ["-C", memoryRoot, "commit", "-q", "-m", "fixture: empty memory repository"]);

  if (options.seedLastRun) await seedLastRun(memoryRoot, options.seedLastRun === true ? "failed" : options.seedLastRun);
  const previewCount = options.seedPreview === true
    ? Number(options.seedPreviewCount ?? 1)
    : Number(options.seedPreview || 0);
  for (let index = 2; index < 2 + previewCount; index += 1) await seedPendingPreview(memoryRoot, index);


  // Minimal plugin registration: only the memory plugins, no providers.
  await writeFile(join(home, "e2e.patch.yml"), [
    "- insert:",
    "    - id: memory",
    "      name: dsh-memory",
    "    - id: ui-memory",
    "      name: dsh-memory-ui",
    "",
  ].join("\n"));

  const port = options.port || 0;
  const pidFile = join(home, "service.pid");
  // Detached: the caller (a node -e snippet or the test runner) exits after
  // learning the port while the DSH server keeps running; the PID file lets a
  // later process stop it. Logs go to a file so we can still diagnose failures.
  const logFile = join(home, "service.log");
  const child = spawn(DSH_BIN, ["web", "--patch", join(home, "e2e.patch.yml"), "--port", String(port)], {
    env: { ...process.env, DSH_HOME: home, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.unref();
  service = { home, child, port: 0, baseUrl: "", logs: [], pidFile, logFile };
  const logHandle = await import("node:fs/promises").then((fs) => fs.open(logFile, "w"));
  child.stdout.on("data", (chunk) => { service.logs.push(chunk.toString()); void logHandle.write(chunk); });
  child.stderr.on("data", (chunk) => { service.logs.push(chunk.toString()); void logHandle.write(chunk); });

  // Wait for the web server line that carries the chosen port.
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("isolated DSH service did not report a port")), 30_000);
    const poll = () => {
      const match = service.logs.join("").match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        service.port = Number(match[1]);
        service.baseUrl = `http://127.0.0.1:${service.port}`;
        writeFile(pidFile, String(child.pid)).catch(() => {});
        resolveReady();
        return;
      }
      if (child.exitCode !== null) {
        clearTimeout(timeout);
        reject(new Error(`isolated DSH service exited early (${child.exitCode}): ${service.logs.join("")}`));
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });

  // Health: the root document must answer 200 before any page load.
  await waitForHttp(service.baseUrl + "/", 30_000);
  return { ...service, memoryRoot };
}

export function stopIsolatedService() {
  if (!service) return;
  try { process.kill(-service.child.pid, "SIGTERM"); }
  catch { try { service.child.kill("SIGTERM"); } catch { /* already gone */ } }
  service = null;
}

/** Stop a detached service by PID file (for the Python E2E flow). */
export async function stopDetachedService(home) {
  try {
    const { readFile, rm } = await import("node:fs/promises");
    const pid = Number((await readFile(join(home, "service.pid"), "utf8")).trim());
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(-pid, "SIGTERM"); }
      catch { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    }
    await rm(home, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function waitForHttp(url, timeoutMs = 15_000) {
  return new Promise((resolveReady, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolveReady(response);
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`));
      setTimeout(attempt, 250);
    };
    void attempt();
  });
}

export async function cleanupService() {
  if (service) {
    await stopDetachedService(service.home);
    service = null;
  }
}
