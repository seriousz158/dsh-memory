import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOperationLock,
  clearActiveRun,
  isPreviewExpired,
  listPendingPreviews,
  readActiveRun,
  readOperationLock,
  releaseOperationLock,
  writeActiveRun,
} from "../packages/dsh-memory/lib/operation-lock.js";

const root = await mkdtemp(join(tmpdir(), "dsh-memory-operation-lock-"));

const first = await acquireOperationLock(root, { operation: "sync", runId: "run-1" });
assert.deepEqual(first, { staleRecovered: false });
assert.deepEqual(await readOperationLock(root), {
  operation: "sync",
  pid: process.pid,
  runId: "run-1",
  startedAt: (await readOperationLock(root)).startedAt,
});

await assert.rejects(
  acquireOperationLock(root, { operation: "clear", runId: "run-2" }),
  (error) => error.memoryCode === "operation-in-progress",
);

await releaseOperationLock(root, "run-1");
assert.equal(await readOperationLock(root), null);

await mkdir(join(root, ".sync"), { recursive: true });
await writeFile(join(root, ".sync", "operation.lock"), JSON.stringify({
  operation: "sync",
  pid: -1,
  runId: "stale-run",
  startedAt: "2000-01-01T00:00:00Z",
}) + "\n");
assert.deepEqual(
  await acquireOperationLock(root, { operation: "rollback", runId: "run-3", staleAfterMs: 1 }),
  { staleRecovered: true },
);

await writeActiveRun(root, { runId: "run-3", phase: "applying" });
assert.deepEqual(await readActiveRun(root), { runId: "run-3", phase: "applying" });
assert.equal(await clearActiveRun(root, "wrong-run"), false);
assert.deepEqual(await readActiveRun(root), { runId: "run-3", phase: "applying" });
assert.equal(await clearActiveRun(root, "run-3"), true);
assert.equal(await readActiveRun(root), null);

await mkdir(join(root, ".sync", "previews", "20260820T120000Z-a1b2c3d4"), { recursive: true });
await writeFile(join(root, ".sync", "previews", "20260820T120000Z-a1b2c3d4", "preview.json"), JSON.stringify({
  preview_id: "20260820T120000Z-a1b2c3d4",
  created_at: "2026-08-20T12:00:00Z",
  expires_at: "2999-01-01T00:00:00Z",
}) + "\n");
const previews = await listPendingPreviews(root);
assert.equal(previews.length, 1);
assert.equal(previews[0].preview_id, "20260820T120000Z-a1b2c3d4");
assert.equal(isPreviewExpired(previews[0], Date.parse("2026-08-20T12:01:00Z")), false);
assert.equal(isPreviewExpired({ expires_at: "2020-01-01T00:00:00Z" }, Date.parse("2026-08-20T12:01:00Z")), true);

assert.match(await readFile(join(root, ".sync", "operation.lock"), "utf8"), /run-3/);
await releaseOperationLock(root, "run-3");
console.log("dsh-memory operation lock tests passed");
