import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository } from "../packages/dsh-memory/lib/index.js";

const execFile = promisify(execFileCallback);
const git = async (root, args) => await execFile("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-memory-migration-api-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "DSH Memory Test"]);
  await git(root, ["config", "user.email", "dsh-memory-test@example.invalid"]);
  for (const dir of ["handbook", "rollouts", "archive"]) await mkdir(join(root, dir));
  await writeFile(join(root, "summary.md"), "navigation\n");
  await writeFile(join(root, "handbook", "legacy-a.md"), "# A\nbody A\n");
  await writeFile(join(root, "rollouts", "legacy-b.md"), "# B\nbody B\n");
  await writeFile(join(root, "archive", "legacy-c.md"), "# C\nbody C\n");
  await writeFile(join(root, "handbook", "structured.md"), "---\nschema_version: 1\nid: structured\n---\nstructured\n");
  await writeFile(join(root, "README.md"), "reference\n");
  await writeFile(join(root, ".last-sync"), "0\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial legacy memory"]);
  return root;
}

const repository = (root) => new MemoryRepository({ root, __testOnly: true });

{
  const root = await fixture();
  const service = repository(root);
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const listed = await service.legacyRecords();
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.value.count, 3);
  assert.deepEqual(listed.value.records.map((record) => record.path), [
    "archive/legacy-c.md",
    "handbook/legacy-a.md",
    "rollouts/legacy-b.md",
  ]);
  for (const record of listed.value.records) {
    assert.match(record.id, /^legacy-[0-9a-f]{16}$/);
    assert.match(record.frontMatter, /^---\nschema_version: 1\nid: legacy-[0-9a-f]{16}\ncreated_at: \d{4}-\d{2}-\d{2}\nupdated_at: \d{4}-\d{2}-\d{2}\n---\n$/);
    assert.equal(Object.hasOwn(record, "content"), false);
  }

  const dry = await service.migrateLegacy({ dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.value.status, "pending");
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.legacyCount, 3);
  assert.deepEqual(dry.value.changedPaths, [
    "archive/legacy-c.md",
    "handbook/legacy-a.md",
    "rollouts/legacy-b.md",
  ]);
  assert.equal((await git(root, ["rev-parse", "HEAD"])).stdout.trim(), head);
  assert.equal(await readFile(join(root, "handbook", "legacy-a.md"), "utf8"), "# A\nbody A\n");
  assert.equal(await readFile(join(root, ".sync", "last-run.json"), "utf8").catch(() => null), null);

  const applied = await service.migrateLegacy({ dryRun: false });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.value.status, "applied");
  assert.equal(applied.value.migratedCount, 3);
  assert.equal(applied.value.recoveryCommit, head);
  assert.match(applied.value.applyCommit, /^[0-9a-f]{40}$/);
  assert.equal((await git(root, ["rev-parse", `${applied.value.applyCommit}^`])).stdout.trim(), head);
  assert.match(await readFile(join(root, "handbook", "legacy-a.md"), "utf8"), /^---\nschema_version: 1\nid: legacy-/);
  assert.match(await readFile(join(root, "handbook", "legacy-a.md"), "utf8"), /# A\nbody A\n$/);

  const status = await service.status();
  assert.equal(status.ok, true);
  assert.equal(status.value.legacyFileCount, 0);
  assert.equal(status.value.pendingMigration, false);
  const runs = await service.runs({ operation: "migrate", status: "applied", limit: 5 });
  assert.equal(runs.ok, true);
  assert.equal(runs.value.runs.length, 1);
  assert.deepEqual(runs.value.runs[0].changed_paths, applied.value.changedPaths);
  assert.equal(runs.value.runs[0].recovery_commit, head);
  assert.equal(runs.value.runs[0].apply_commit, applied.value.applyCommit);
  assert.equal(runs.value.runs[0].operation, "migrate");
  assert.equal(runs.value.runs[0].phase, "complete");
  assert.equal(runs.value.runs[0].duration_ms >= 0, true);
  assert.equal(runs.value.runs[0].rejected_file_count, 0);
  assert.equal(JSON.stringify(runs.value.runs[0]).includes("body A"), false);

  const afterHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const again = await service.migrateLegacy({ dryRun: false });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.value.status, "no_change");
  assert.equal((await git(root, ["rev-parse", "HEAD"])).stdout.trim(), afterHead);
}

{
  const root = await fixture();
  await mkdir(join(root, ".sync"));
  await writeFile(join(root, ".sync", "active-run.json"), JSON.stringify({
    schema_version: 1,
    run_id: "stale-migrate",
    operation: "migrate",
    status: "running",
    phase: "applying",
    pid: -1,
    started_at: "2026-08-20T00:00:00Z",
  }) + "\n");
  const interrupted = await repository(root).migrateLegacy({ dryRun: false });
  assert.deepEqual(interrupted, { ok: false, error: { code: "interrupted-run" } });
  assert.equal(await readFile(join(root, ".sync", "active-run.json"), "utf8").catch(() => null), null);
  const health = await repository(root).health();
  assert.equal(health.ok, true);
  assert.equal(health.value.interruptedRun.status, "interrupted");
  assert.equal(health.value.needsManualRecovery, true);
  assert.equal((await repository(root).status()).value.legacyFileCount, 3);
}

{
  const root = await fixture();
  assert.deepEqual(await repository(root).migrateLegacy(), { ok: false, error: { code: "migration-invalid-request" } });
}

console.log("dsh-memory migration API tests passed");
