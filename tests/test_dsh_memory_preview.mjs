import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository } from "../packages/dsh-memory/lib/index.js";

const execFile = promisify(execFileCallback);
const git = async (root, args) => await execFile("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-memory-preview-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "DSH Memory Test"]);
  await git(root, ["config", "user.email", "dsh-memory-test@example.invalid"]);
  for (const dir of ["handbook", "rollouts", "archive"]) await mkdir(join(root, dir));
  await writeFile(join(root, "summary.md"), "base memory\n");
  await writeFile(join(root, ".last-sync"), "0\n");
  await writeFile(join(root, "README.md"), "keep\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

const repository = async (root) => new MemoryRepository({ root, __testOnly: true });

/** Seed a pending preview via the sync-apply helper, bypassing the UI path. */
async function seedPreview(root, previewId, changedPath, content, createdAt = "2026-08-20T14:00:00Z") {
  const helper = join(process.cwd(), "packages/dsh-memory/lib/sync-apply.py");
  await execFile("/usr/bin/python3", [helper, "prepare-preview", "--root", root, "--run-id", previewId]);
  const previewRoot = join(root, ".sync", "previews", previewId);
  await mkdir(join(previewRoot, "staging", "handbook"), { recursive: true });
  await writeFile(join(previewRoot, "staging", changedPath), content);
  await writeFile(join(previewRoot, "preview.json"), JSON.stringify({
    preview_id: previewId,
    created_at: createdAt,
    expires_at: "2099-01-01T00:00:00Z",
    candidate_sessions: 1,
    changed_paths: [changedPath],
    status: "pending",
  }) + "\n");
  return previewRoot;
}

{
  // previews() lists pending previews newest first.
  const root = await fixture();
  const service = await repository(root);
  await seedPreview(root, "20260820T140000Z-aaaa0001", "handbook/p1.md", "one\n", "2026-08-20T14:00:00Z");
  await seedPreview(root, "20260820T150000Z-bbbb0002", "handbook/p2.md", "two\n", "2026-08-20T15:00:00Z");
  const list = await service.previews();
  assert.equal(list.ok, true);
  assert.equal(list.value.previews.length, 2);
  assert.equal(list.value.previews[0].preview_id, "20260820T150000Z-bbbb0002");
  assert.equal(list.value.previews[1].preview_id, "20260820T140000Z-aaaa0001");
}

{
  // applyPreview applies the staged payload and consumes the preview.
  const root = await fixture();
  const service = await repository(root);
  const previewId = "20260820T140000Z-cafe0001";
  await seedPreview(root, previewId, "handbook/api.md", "api preview\n");
  const applied = await service.applyPreview({ previewId });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.value.status, "applied");
  assert.deepEqual(applied.value.changed_paths, ["handbook/api.md"]);
  assert.equal(await readFile(join(root, "handbook", "api.md"), "utf8"), "api preview\n");
  // The preview is consumed.
  const after = await service.previews();
  assert.equal(after.value.previews.length, 0);
  // The apply is journaled as operation: preview.
  const runs = await service.runs({ operation: "preview", limit: 5 });
  assert.equal(runs.value.runs.some((run) => run.run_id === previewId && run.status === "applied"), true);
}

{
  // Re-applying a consumed preview fails.
  const root = await fixture();
  const service = await repository(root);
  const previewId = "20260820T140000Z-cafe0002";
  await seedPreview(root, previewId, "handbook/api.md", "once\n");
  await service.applyPreview({ previewId });
  const again = await service.applyPreview({ previewId });
  assert.equal(again.ok, false);
}

{
  // discardPreview removes a pending preview without applying.
  const root = await fixture();
  const service = await repository(root);
  const previewId = "20260820T140000Z-cafe0003";
  await seedPreview(root, previewId, "handbook/discard.md", "discard me\n");
  const discarded = await service.discardPreview({ previewId });
  assert.equal(discarded.ok, true);
  assert.equal(await readFile(join(root, "handbook", "discard.md"), "utf8").catch(() => "missing"), "missing");
  const after = await service.previews();
  assert.equal(after.value.previews.length, 0);
  const missing = await service.discardPreview({ previewId });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "preview-not-found");
}

{
  // Expired previews are not listed and cannot be applied.
  const root = await fixture();
  const service = await repository(root);
  const previewId = "20260820T140000Z-cafe0004";
  const previewRoot = await seedPreview(root, previewId, "handbook/expired.md", "stale\n");
  await writeFile(join(previewRoot, "preview.json"), JSON.stringify({
    preview_id: previewId,
    created_at: "2020-01-01T00:00:00Z",
    expires_at: "2020-02-01T00:00:00Z",
    candidate_sessions: 1,
    changed_paths: ["handbook/expired.md"],
    status: "pending",
  }) + "\n");
  const list = await service.previews();
  assert.equal(list.value.previews.length, 0);
  const applied = await service.applyPreview({ previewId });
  assert.equal(applied.ok, false);
  assert.equal(applied.error.code, "preview-expired");
}

{
  // Invalid preview id requests are rejected.
  const root = await fixture();
  const service = await repository(root);
  assert.deepEqual(await service.applyPreview({}), { ok: false, error: { code: "preview-invalid-request" } });
  assert.deepEqual(await service.discardPreview({ previewId: 42 }), { ok: false, error: { code: "preview-invalid-request" } });
}

console.log("dsh-memory preview tests passed");
