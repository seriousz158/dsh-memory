import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository } from "../packages/dsh-memory/lib/index.js";

const execFile = promisify(execFileCallback);
const git = async (root, args) => await execFile("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-memory-tx-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "DSH Memory Test"]);
  await git(root, ["config", "user.email", "dsh-memory-test@example.invalid"]);
  for (const dir of ["handbook", "rollouts", "archive"]) await mkdir(join(root, dir));
  await writeFile(join(root, "summary.md"), "test memory\n");
  await writeFile(join(root, "handbook", "entry.md"), "# legacy entry\nold knowledge\n");
  await writeFile(join(root, ".last-sync"), "0\n");
  await writeFile(join(root, "README.md"), "keep\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

const repository = async (root) => new MemoryRepository({ root, __testOnly: true });

{
  // status() reports journal metadata: no journal yet, legacy file present.
  const root = await fixture();
  const status = await (await repository(root)).status();
  assert.equal(status.ok, true);
  assert.equal(status.value.empty, false);
  assert.equal(status.value.schemaVersion, 1);
  assert.equal(status.value.legacyFileCount, 1);
  assert.equal(status.value.pendingMigration, true);
  assert.equal(status.value.lastRun, null);
}

{
  // runs() on a fresh repository returns an empty list.
  const root = await fixture();
  const runs = await (await repository(root)).runs({ limit: 10 });
  assert.equal(runs.ok, true);
  assert.deepEqual(runs.value.runs, []);
}

{
  // rollback requires the exact confirmation.
  const root = await fixture();
  const service = await repository(root);
  const result = await service.rollback({ runId: "20260819T120000Z-a1b2c3d4", confirmation: "DELETE_MEMORY" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "rollback-invalid-confirmation");
}

{
  // rollback of an unknown run id reports run-not-found.
  const root = await fixture();
  const result = await (await repository(root)).rollback({ runId: "20260819T120000Z-deadbeef", confirmation: "ROLLBACK_MEMORY" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "rollback-run-not-found");
}

{
  // A sync transaction can be rolled back as a whole: build an apply commit
  // with a journal record, then verify rollback restores the pre-sync content.
  const root = await fixture();
  const service = await repository(root);
  const original = await readFile(join(root, "handbook", "entry.md"), "utf8");
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();

  // Simulate the sync host: the pre-sync HEAD is the recovery point, then a
  // payload change is committed as the apply commit.
  const recoveryCommit = head;
  await writeFile(join(root, "handbook", "entry.md"), "synced knowledge\n");
  await git(root, ["add", "handbook/entry.md"]);
  await git(root, ["commit", "-m", "DPSK memory sync applied: run-1"]);
  const applyCommit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const syncRecord = {
    schema_version: 1,
    run_id: "20260819T120000Z-a1b2c3d4",
    operation: "sync",
    status: "applied",
    started_at: "2026-08-19T12:00:00Z",
    finished_at: "2026-08-19T12:01:00Z",
    candidate_sessions: 1,
    processed_sessions: 1,
    skipped_sessions: 0,
    changed_paths: ["handbook/entry.md"],
    recovery_commit: recoveryCommit,
    apply_commit: applyCommit,
    error_code: null,
  };
  await service.writeRun(root, syncRecord);

  // Runs lists the sync run.
  const runs = await service.runs({ limit: 10 });
  assert.equal(runs.ok, true);
  assert.equal(runs.value.runs.some((run) => run.run_id === "20260819T120000Z-a1b2c3d4"), true);

  // Rollback restores the original content via a new commit.
  const rollback = await service.rollback({ runId: "20260819T120000Z-a1b2c3d4", confirmation: "ROLLBACK_MEMORY" });
  assert.equal(rollback.ok, true, JSON.stringify(rollback));
  assert.equal(await readFile(join(root, "handbook", "entry.md"), "utf8"), original);
  const postHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(postHead, applyCommit);
  const log = (await git(root, ["log", "--oneline"])).stdout;
  assert.match(log, /DPSK memory rollback/);

  // Rolling back the same run again now conflicts (HEAD has moved).
  const again = await service.rollback({ runId: "20260819T120000Z-a1b2c3d4", confirmation: "ROLLBACK_MEMORY" });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "rollback-conflict");
}

{
  // clear() invalidates older sync runs: after clear, rollback of a prior run
  // reports not-applicable because the clear commit moved HEAD.
  const root = await fixture();
  const service = await repository(root);
  await writeFile(join(root, "handbook", "entry.md"), "synced knowledge\n");
  await git(root, ["add", "handbook/entry.md"]);
  await git(root, ["commit", "-m", "DPSK memory sync applied: run-2"]);
  const applyCommit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await service.writeRun(root, {
    schema_version: 1,
    run_id: "20260819T130000Z-b2c3d4e5",
    operation: "sync",
    status: "applied",
    started_at: "2026-08-19T13:00:00Z",
    finished_at: "2026-08-19T13:01:00Z",
    candidate_sessions: 1,
    processed_sessions: 1,
    skipped_sessions: 0,
    changed_paths: ["handbook/entry.md"],
    recovery_commit: (await git(root, ["rev-parse", "HEAD~1"])).stdout.trim(),
    apply_commit: applyCommit,
    error_code: null,
  });
  const clear = await service.clear({ confirmation: "DELETE_MEMORY" });
  assert.equal(clear.ok, true);
  const rollback = await service.rollback({ runId: "20260819T130000Z-b2c3d4e5", confirmation: "ROLLBACK_MEMORY" });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.error.code, "rollback-conflict");
}

console.log("dsh-memory sync transaction tests passed");
