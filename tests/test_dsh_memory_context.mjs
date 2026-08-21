import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository } from "../packages/dsh-memory/lib/index.js";

const execFile = promisify(execFileCallback);
const git = async (root, args) => await execFile("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });
const root = await mkdtemp(join(tmpdir(), "dsh-memory-context-"));
await git(root, ["init"]);
await git(root, ["config", "user.name", "DSH Memory Context Test"]);
await git(root, ["config", "user.email", "dsh-memory-context@example.invalid"]);
for (const dir of ["handbook", "rollouts", "archive", ".sync"]) await mkdir(join(root, dir));
await writeFile(join(root, "summary.md"), "navigation\n");
await writeFile(join(root, ".last-sync"), "0\n");
await writeFile(join(root, ".sync", ".gitignore"), "usage.json\n", { mode: 0o600 });
await writeFile(join(root, "handbook", "alpha.md"), `---
schema_version: 1
id: project/alpha
type: decision
---
Shared architecture decision alpha.
`);
await writeFile(join(root, "rollouts", "beta.md"), `---
schema_version: 1
id: project/beta
type: decision
---
Shared architecture decision beta.
`);
await writeFile(join(root, "archive", "legacy.md"), "Shared legacy note.\n");
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "context fixture"]);

const service = new MemoryRepository({ root, __testOnly: true });
const initial = await service.context();
assert.equal(initial.ok, true);
assert.deepEqual(initial.value.records.map((record) => record.path), [
  "archive/legacy.md",
  "handbook/alpha.md",
  "rollouts/beta.md",
]);
assert.equal(initial.value.records[1].content, "Shared architecture decision alpha.\n");
assert.equal(initial.value.records[1].citation, "[source: handbook/alpha.md · id: project/alpha]");
assert.equal(initial.value.records[1].usage_count, 1);

const searched = await service.context({ query: "architecture", limit: 2 });
assert.equal(searched.ok, true);
assert.deepEqual(searched.value.records.map((record) => record.path), [
  "handbook/alpha.md",
  "rollouts/beta.md",
]);
assert.equal(searched.value.records[0].usage_count, 2);
assert.equal(searched.value.records[1].usage_count, 2);
assert.equal(searched.value.records[0].score > 0, true);

const invalidQuery = await service.context({ query: "" });
assert.deepEqual(invalidQuery, { ok: false, error: { code: "context-invalid-request" } });
const invalidLimit = await service.context({ limit: 21 });
assert.deepEqual(invalidLimit, { ok: false, error: { code: "context-invalid-request" } });

const status = (await git(root, ["status", "--porcelain"])).stdout;
assert.equal(status, "");
assert.match(await readFile(join(root, ".sync", "usage.json"), "utf8"), /usage_count/);
assert.match(await readFile(join(root, ".git", "info", "exclude"), "utf8"), /\.sync\/usage\.json/);

console.log("dsh-memory context tests passed");
