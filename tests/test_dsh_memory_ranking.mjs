// Raw lexical rank must follow the lexical score, not file-name order: a
// strongly matching record whose file name sorts late must still win.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository } from "../packages/dsh-memory/lib/index.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "dsh-memory-ranking-"));
const git = async (args) => await execFile("/usr/bin/git", ["-C", root, ...args]);
try {
  await git(["init", "-q"]);
  await git(["config", "user.name", "DSH Memory Ranking"]);
  await git(["config", "user.email", "dsh-memory-ranking@example.invalid"]);
  for (const dir of ["handbook", "rollouts", "archive", ".sync"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "summary.md"), "navigation\n");
  await writeFile(join(root, ".last-sync"), "0\n");
  const record = (id, body) => `---\nschema_version: 1\nid: ${id}\ntype: procedure\nupdated_at: 2026-10-01\n---\n\n${body}\n`;
  // Weak match: the keyword appears once inside unrelated prose.
  await writeFile(join(root, "handbook", "a-weekly-notes.md"), record("notes/weekly",
    "Weekly notes about lunch menus, office plants, travel plans, printer toner, parking, and once a deploy freeze reminder."));
  // Strong match: id, type-adjacent title, and body all about the keyword.
  await writeFile(join(root, "handbook", "z-deploy-checklist.md"), record("ops/deploy-checklist",
    "deploy checklist: deploy from a tagged commit, deploy with migrations first, verify the deploy health checks."));
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "fixture"]);
  const repository = new MemoryRepository({ root, __testOnly: true });
  const result = await repository.search({ query: "deploy" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.results[0].path, "handbook/z-deploy-checklist.md", JSON.stringify(result.value.results.map((entry) => [entry.path, entry.score])));
  console.log(`dsh-memory ranking tests passed (${result.value.retrieval.mode})`);
} finally {
  await rm(root, { recursive: true, force: true });
}
