import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository } from "../packages/dsh-memory/lib/index.js";
import { legacyId } from "../packages/dsh-memory/lib/legacy-migration.js";

const execFile = promisify(execFileCallback);
const git = async (root, args) => await execFile("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });
const root = await mkdtemp(join(tmpdir(), "dsh-memory-context-"));
await git(root, ["init"]);
await git(root, ["config", "user.name", "DSH Memory Context Test"]);
await git(root, ["config", "user.email", "dsh-memory-context@example.invalid"]);
for (const dir of ["handbook", "rollouts", "archive", ".sync"]) await mkdir(join(root, dir));
await writeFile(join(root, "summary.md"), "navigation\n");
await writeFile(join(root, ".last-sync"), "0\n");
await writeFile(join(root, ".sync", ".gitignore"), "usage.json\nusage.lock/\n.usage.*.tmp\n", { mode: 0o600 });
await writeFile(join(root, "handbook", "alpha.md"), `---
schema_version: 1
id: project/alpha
type: decision
tags:
  - architecture
---
Shared architecture decision alpha.
`);
await writeFile(join(root, "rollouts", "beta.md"), `---
schema_version: 1
id: project/beta
type: decision
tags:
  - architecture
---
Shared architecture decision beta.
`);
await writeFile(join(root, "archive", "gamma.md"), "gamma architecture\n");
await writeFile(join(root, "archive", "legacy.md"), "Shared legacy note.\n");
await writeFile(join(root, "archive", "long.md"), "长".repeat(2500));
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "context fixture"]);

const service = new MemoryRepository({ root, __testOnly: true });
const initial = await service.context();
assert.equal(initial.ok, true);
assert.deepEqual(initial.value.records.map((record) => record.path), [
  "handbook/alpha.md",
  "rollouts/beta.md",
]);
const alpha = initial.value.records.find((record) => record.path === "handbook/alpha.md");
assert.equal(alpha.content, "Shared architecture decision alpha.\n");
assert.equal(alpha.citation, "[source: handbook/alpha.md · id: project/alpha]");
assert.equal(alpha.usage_count, 1);
assert.equal(alpha.generation, 1);
assert.match(alpha.content_hash, /^sha256:/);

const hiddenArchive = await service.context({ query: "gamma", limit: 1 });
assert.equal(hiddenArchive.ok, true);
assert.equal(hiddenArchive.value.count, 0);
for (let index = 0; index < 3; index += 1) await service.context({ query: "gamma", scope: "archive", limit: 1 });

const searched = await service.context({ query: "architecture", limit: 2 });
assert.equal(searched.ok, true);
assert.deepEqual(searched.value.records.map((record) => record.path), [
  "handbook/alpha.md",
  "rollouts/beta.md",
]);
assert.equal(searched.value.records[0].usage_count, 2);
assert.equal(searched.value.records[1].usage_count, 2);
assert.equal(searched.value.records[0].score > 0, true);

const archiveContext = await service.context({ scope: "archive", limit: 10 });
const legacy = archiveContext.value.records.find((record) => record.path === "archive/legacy.md");
assert.equal(legacy.id, legacyId("archive/legacy.md"));
assert.equal(legacy.logical_id, legacyId("archive/legacy.md"));
assert.equal(legacy.source_rollouts.length, 0);
const long = archiveContext.value.records.find((record) => record.path === "archive/long.md");
assert.equal(long.truncated, true);
assert.equal(Buffer.byteLength(long.content, "utf8") <= 4096, true);
assert.doesNotMatch(long.content, /�/);

const legacySearch = await service.search({ query: "legacy", scope: "archive", limit: 1 });
assert.equal(legacySearch.ok, true);
assert.equal(legacySearch.value.results[0].id, legacyId("archive/legacy.md"));
assert.match(legacySearch.value.results[0].content_hash, /^sha256:/);
assert.equal(legacySearch.value.results[0].generation, 1);

const invalidQuery = await service.context({ query: "" });
assert.deepEqual(invalidQuery, { ok: false, error: { code: "context-invalid-request" } });
const invalidLimit = await service.context({ limit: 21 });
assert.deepEqual(invalidLimit, { ok: false, error: { code: "context-invalid-request" } });

const status = (await git(root, ["status", "--porcelain"])).stdout;
assert.equal(status, "");
assert.match(await readFile(join(root, ".sync", "usage.json"), "utf8"), /usage_count/);
assert.match(await readFile(join(root, ".git", "info", "exclude"), "utf8"), /\.sync\/usage\.json/);

await writeFile(join(root, "summary.md"), "x".repeat(12 * 1024 + 1));
const health = await service.health();
assert.equal(health.ok, true);
assert.equal(health.value.summaryWithinBudget, false);
assert.equal(health.value.summaryBytes, 12 * 1024 + 1);
assert.equal(health.value.needsManualRecovery, true);

await mkdir(join(root, ".sync", "runs"), { recursive: true });
await writeFile(join(root, ".sync", "last-run.json"), JSON.stringify({
  run_id: "20260824T010000Z-failed001",
  status: "failed",
  changed_paths: [],
}));
await writeFile(join(root, ".sync", "runs", "20260824T010001Z-skip0001.json"), JSON.stringify({
  run_id: "20260824T010001Z-skip0001",
  status: "skipped-retry",
  error_code: "child-exit",
  candidate_digest: "sha256:test",
}));
const statusResult = await service.status();
assert.equal(statusResult.ok, true);
assert.equal(statusResult.value.lastRun.status, "failed");
assert.equal(statusResult.value.retrySuppressed.errorCode, "child-exit");

console.log("dsh-memory context tests passed");
