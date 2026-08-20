import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository, MemorySettingsBridge } from "../packages/dsh-memory/lib/index.js";

const execFile = promisify(execFileCallback);
const git = async (root, args) => await execFile("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-memory-test-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "DSH Memory Test"]);
  await git(root, ["config", "user.email", "dsh-memory-test@example.invalid"]);
  for (const dir of ["handbook", "rollouts", "archive"]) await mkdir(join(root, dir));
  await writeFile(join(root, "summary.md"), "test memory\n");
  for (const dir of ["handbook", "rollouts", "archive"]) await writeFile(join(root, dir, "entry.md"), "test\n");
  await writeFile(join(root, ".last-sync"), "keep\n");
  await writeFile(join(root, "README.md"), "keep\n");
  await writeFile(join(root, "outside.md"), "keep\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function emptyFixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-memory-empty-test-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "DSH Memory Test"]);
  await git(root, ["config", "user.email", "dsh-memory-test@example.invalid"]);
  for (const dir of ["handbook", "rollouts", "archive"]) await mkdir(join(root, dir));
  await writeFile(join(root, "summary.md"), "");
  await writeFile(join(root, ".last-sync"), "keep\n");
  await writeFile(join(root, "README.md"), "keep\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial empty"]);
  return root;
}

const repository = async (root) => new MemoryRepository({ root, __testOnly: true });

{
  const root = await fixture();
  const status = await (await repository(root)).status();
  assert.equal(status.ok, true);
  assert.equal(status.value.empty, false);
  assert.equal(status.value.dataFileCount, 4);
  assert.equal(status.value.pendingPreview, null);
}
{
  const root = await fixture();
  const health = await (await repository(root)).health();
  assert.equal(health.ok, true);
  assert.equal(health.value.rootSafe, true);
  assert.equal(health.value.gitAvailable, true);
  assert.equal(health.value.operationLock, null);
  assert.equal(health.value.activeRun, null);
  assert.equal(health.value.interruptedRun, null);
  assert.equal(health.value.pendingPreviewCount, 0);
  assert.equal(health.value.journalReadable, true);
  assert.equal(health.value.needsManualRecovery, false);
}
{
  const root = await fixture();
  const originalHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const result = await (await repository(root)).clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, true);
  assert.equal(result.value.recoveryCommit, originalHead);
  assert.match(result.value.clearCommit, /^[0-9a-f]{40}$/);
  assert.equal((await git(root, ["rev-parse", `${result.value.clearCommit}^`])).stdout.trim(), originalHead);
  assert.equal(result.value.clearedFileCount, 4);
  assert.equal(await readFile(join(root, "summary.md"), "utf8"), "");
  assert.equal((await readFile(join(root, ".last-sync"), "utf8")).trim(), "keep");
  assert.equal((await readFile(join(root, "README.md"), "utf8")).trim(), "keep");
  for (const dir of ["handbook", "rollouts", "archive"]) assert.deepEqual(await readdir(join(root, dir)), []);
}
{
  const root = await fixture();
  await unlink(join(root, "summary.md"));
  await link(join(root, "README.md"), join(root, "summary.md"));
  const result = await (await repository(root)).clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(root, "summary.md"), "utf8"), "");
  assert.equal((await readFile(join(root, "README.md"), "utf8")).trim(), "keep");
}
{
  const root = await fixture();
  await writeFile(join(root, "handbook", "dirty.md"), "dirty target\n");
  await writeFile(join(root, "outside.md"), "unrelated\n");
  const result = await (await repository(root)).clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, true);
  assert.match(result.value.recoveryCommit, /^[0-9a-f]{40}$/);
  assert.match(result.value.clearCommit, /^[0-9a-f]{40}$/);
  assert.match((await git(root, ["show", result.value.recoveryCommit, "--", "handbook/dirty.md"])).stdout, /dirty target/);
  assert.equal((await readFile(join(root, "outside.md"), "utf8")).trim(), "unrelated");
  const porcelain = (await git(root, ["status", "--porcelain"])).stdout;
  assert.match(porcelain, /outside\.md/);
  assert.doesNotMatch(porcelain, /summary\.md|handbook|rollouts|archive/);
}
{
  const root = await fixture();
  const originalHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(root, "outside.md"), "unrelated\n");
  const result = await (await repository(root)).clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, true);
  assert.equal(result.value.recoveryCommit, originalHead);
  assert.match((await git(root, ["status", "--porcelain"])).stdout, /outside\.md/);
}
{
  const root = await fixture();
  await writeFile(join(root, "outside.md"), "staged outside\n");
  await git(root, ["add", "outside.md"]);
  const result = await (await repository(root)).clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, true);
  assert.match((await git(root, ["diff", "--cached", "--name-only"])).stdout, /outside\.md/);
  assert.equal((await readFile(join(root, "outside.md"), "utf8")).trim(), "staged outside");
}
{
  const root = await emptyFixture();
  const result = await (await repository(root)).clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, true);
  assert.equal(result.value.alreadyEmpty, true);
  assert.equal(result.value.clearCommit, null);
}
{
  const root = await fixture();
  const service = await repository(root);
  await service.clear({ confirmation: "DELETE_MEMORY" });
  const again = await service.clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(again.ok, true);
  assert.equal(again.value.alreadyEmpty, true);
}
{
  const root = await fixture();
  await symlink("/tmp", join(root, "archive", "escape"));
  assert.deepEqual(await (await repository(root)).status(), { ok: false, error: { code: "unsafe-layout" } });
}
{
  const root = await fixture();
  await writeFile(join(root, "summary.md"), "dirty\n");
  await git(root, ["add", "summary.md"]);
  await writeFile(join(root, "outside.md"), "staged outside\n");
  await git(root, ["add", "outside.md"]);
  const stagedBefore = (await git(root, ["diff", "--cached", "--binary"])).stdout;
  await git(root, ["config", "user.name", ""]);
  const result = await (await repository(root)).clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "checkpoint-failed");
  assert.equal((await git(root, ["diff", "--cached", "--binary"])).stdout, stagedBefore);
}
{
  const root = await fixture();
  const service = await repository(root);
  const inspect = service.inspect.bind(service);
  let inspectCount = 0;
  service.inspect = async () => {
    const actual = await inspect();
    inspectCount += 1;
    if (inspectCount === 3) {
      await unlink(join(root, "summary.md"));
      await symlink(join(root, "outside.md"), join(root, "summary.md"));
    }
    return actual;
  };
  const result = await service.clear({ confirmation: "DELETE_MEMORY" });
  assert.deepEqual(result, { ok: false, error: { code: "unsafe-layout" } });
  assert.equal((await readFile(join(root, "outside.md"), "utf8")).trim(), "keep");
}
{
  const root = await fixture();
  const external = await mkdtemp(join(tmpdir(), "dsh-memory-external-test-"));
  await writeFile(join(external, "entry.md"), "outside\n");
  const service = await repository(root);
  const inspect = service.inspect.bind(service);
  let inspectCount = 0;
  service.inspect = async () => {
    const actual = await inspect();
    inspectCount += 1;
    if (inspectCount === 3) {
      await rename(join(root, "handbook"), join(root, "handbook-before-race"));
      await symlink(external, join(root, "handbook"));
    }
    return actual;
  };
  const result = await service.clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsafe-layout");
  assert.equal((await readFile(join(external, "entry.md"), "utf8")).trim(), "outside");
}
{
  const root = await fixture();
  const service = await repository(root);
  const invoke = service.git.bind(service);
  service.git = async (args, options) => (
    args[0] === "commit-tree" && args.includes("DPSK memory cleared")
      ? Promise.reject(new Error("injected clear commit failure"))
      : await invoke(args, options)
  );
  const result = await service.clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "commit-failed");
  assert.equal((await readFile(join(root, "summary.md"), "utf8")).trim(), "test memory");
}
{
  const root = await mkdtemp(join(tmpdir(), "dsh-memory-not-a-repo-test-"));
  assert.deepEqual(await (await repository(root)).status(), { ok: false, error: { code: "repo-unavailable" } });
}
{
  const bridge = new MemorySettingsBridge();
  assert.deepEqual(await bridge.read(), { ok: false, error: { code: "settings-unavailable" } });
}
{
  let value = { enabled: true };
  const scope = { get: () => value, update: async (patch) => { value = { ...value, ...patch }; } };
  const bridge = new MemorySettingsBridge();
  bridge.bind(scope);
  assert.deepEqual(await bridge.read(), { ok: true, value: { enabled: true } });
  assert.deepEqual(await bridge.setEnabled({ enabled: false }), { ok: true, value: { enabled: false } });
  assert.deepEqual(value, { enabled: false });
  bridge.unbind(scope);
  assert.deepEqual(await bridge.setEnabled({ enabled: true }), { ok: false, error: { code: "settings-unavailable" } });
}
{
  const bridge = new MemorySettingsBridge();
  bridge.bind({ get: () => ({ enabled: true }), update: async () => { throw new Error("write rejected"); } });
  assert.deepEqual(await bridge.setEnabled({ enabled: false }), { ok: false, error: { code: "settings-write-failed" } });
  assert.deepEqual(await bridge.setEnabled({ enabled: "false" }), { ok: false, error: { code: "settings-invalid-request" } });
}

console.log("dsh-memory repository tests passed");
