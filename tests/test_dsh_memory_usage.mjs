import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  USAGE_FILE,
  formatCitation,
  readUsage,
  recordUsage,
  sortByUsage,
} from "../packages/dsh-memory/lib/memory-usage.js";
import { legacyId } from "../packages/dsh-memory/lib/legacy-migration.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "dsh-memory-usage-"));
await mkdir(join(root, ".sync"), { mode: 0o700 });
await mkdir(join(root, "handbook"), { mode: 0o700 });
await writeFile(join(root, ".sync", ".gitignore"), "usage.json\n", { mode: 0o600 });
await mkdir(join(root, ".sync", ".usage.dead.tmp"), { mode: 0o700 });

const first = new Date("2026-08-21T01:00:00.000Z");
await recordUsage(root, ["handbook/alpha.md", "rollouts/beta.md"], first);
await assert.rejects(() => stat(join(root, ".sync", ".usage.dead.tmp")), (error) => error?.code === "ENOENT");
await recordUsage(root, ["handbook/alpha.md"], new Date("2026-08-21T02:00:00.000Z"));

const usage = await readUsage(root);
assert.equal(usage.schema_version, 1);
assert.deepEqual(usage.records["handbook/alpha.md"], {
  logical_id: legacyId("handbook/alpha.md"),
  generation: 1,
  content_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  usage_count: 2,
  last_usage: "2026-08-21T02:00:00.000Z",
  prior_usage_count: 0,
  decay_factor: 0.5,
});
assert.deepEqual(usage.records["rollouts/beta.md"], {
  logical_id: legacyId("rollouts/beta.md"),
  generation: 1,
  content_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  usage_count: 1,
  last_usage: "2026-08-21T01:00:00.000Z",
  prior_usage_count: 0,
  decay_factor: 0.5,
});

await writeFile(join(root, "handbook/alpha.md"), "changed content\n");
await recordUsage(root, ["handbook/alpha.md"], new Date("2026-08-21T04:00:00.000Z"));
const changed = (await readUsage(root)).records["handbook/alpha.md"];
assert.equal(changed.generation, 2);
assert.equal(changed.usage_count, 1);
assert.equal(changed.prior_usage_count, 2);
assert.equal(changed.logical_id, legacyId("handbook/alpha.md"));

const usagePath = join(root, USAGE_FILE);
assert.equal((await stat(usagePath)).mode & 0o777, 0o600);
assert.doesNotMatch(await readFile(usagePath, "utf8"), /正文|transcript|prompt|credential/);

const sorted = sortByUsage([
  { path: "rollouts/beta.md" },
  { path: "handbook/alpha.md" },
  { path: "archive/unused.md" },
], usage);
assert.deepEqual(sorted.map((entry) => entry.path), [
  "handbook/alpha.md",
  "rollouts/beta.md",
  "archive/unused.md",
]);

assert.equal(formatCitation("handbook/alpha.md", "project/alpha"), "[source: handbook/alpha.md · id: project/alpha]");
assert.equal(formatCitation("rollouts/beta.md", null), "[source: rollouts/beta.md]");

await chmod(usagePath, 0o644);
await recordUsage(root, ["archive/unused.md"], new Date("2026-08-21T03:00:00.000Z"));
assert.equal((await stat(usagePath)).mode & 0o777, 0o600);

await Promise.all(Array.from({ length: 8 }, (_, index) => recordUsage(
  root,
  ["archive/unused.md"],
  new Date(`2026-08-21T03:00:0${index}.000Z`),
)));
assert.equal((await readUsage(root)).records["archive/unused.md"].usage_count, 9);

const usageModule = pathToFileURL(join(process.cwd(), "packages/dsh-memory/lib/memory-usage.js")).href;
const childProgram = `import { recordUsage } from ${JSON.stringify(usageModule)}; await recordUsage(${JSON.stringify(root)}, ["handbook/alpha.md"]);`;
await Promise.all(Array.from({ length: 4 }, () => execFile(process.execPath, ["--input-type=module", "--eval", childProgram], { encoding: "utf8" })));
assert.equal((await readUsage(root)).records["handbook/alpha.md"].usage_count, 5);

await writeFile(usagePath, JSON.stringify({ schema_version: 1, records: { "../escape.md": { usage_count: 1, last_usage: null } } }));
await assert.rejects(() => readUsage(root), (error) => error?.memoryCode === "usage-invalid");

console.log("dsh-memory usage tests passed");
