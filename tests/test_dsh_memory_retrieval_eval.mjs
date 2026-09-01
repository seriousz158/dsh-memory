// v0.9.0 retrieval evaluation: a labeled query corpus over a mixed
// Chinese/English memory fixture. Every case asserts recall against the
// hybrid retrieval pipeline; index-state and degradation behavior are
// asserted separately. The evaluation must pass in both retrieval modes
// (hybrid with the SQLite derived index, and the degraded pure scan), so
// results stay correct wherever node:sqlite or FTS5 is unavailable.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryRepository } from "../packages/dsh-memory/lib/index.js";
import { stampOf } from "../packages/dsh-memory/lib/search-index.js";

const execFile = promisify(execFileCallback);
const git = async (root, args) => await execFile("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8" });

const root = await mkdtemp(join(tmpdir(), "dsh-memory-retrieval-eval-"));
await git(root, ["init"]);
await git(root, ["config", "user.name", "DSH Memory Retrieval Eval"]);
await git(root, ["config", "user.email", "dsh-memory-eval@example.invalid"]);
for (const dir of ["handbook", "rollouts", "archive", ".sync"]) await mkdir0(join(root, dir));
async function mkdir0(path) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}
await writeFile(join(root, "summary.md"), "navigation\n");
await writeFile(join(root, ".last-sync"), "0\n");

function record(dir, name, id, type, tags, body) {
  return { dir, name, id, type, tags, body };
}

const CORPUS = [
  record("handbook", "cjk-db-index.md", "infra/db-index", "decision", ["database", "performance"],
    "数据库索引优化实践：B-tree 与 LSM-tree 的取舍，写放大与读放大的平衡。Database index optimization tradeoffs between B-tree and LSM-tree.\n"),
  record("handbook", "cjk-cache.md", "infra/cache", "decision", ["cache"],
    "缓存失效策略：旁路缓存与延迟双删，缓存穿透、缓存击穿、缓存雪崩的防线设计。\n"),
  record("handbook", "launchd-setup.md", "ops/launchd", "procedure", ["macos", "scheduling"],
    "launchd agent scheduling for the memory sync: StartCalendarInterval in the plist, throttle intervals, and keppalive rules.\n"),
  record("handbook", "git-workflow.md", "ops/git", "decision", ["git", "workflow"],
    "git workflow: short-lived branches, stacked PRs, rebase policy, and squash merges for release trains.\n"),
  record("handbook", "redaction-policy.md", "sec/redaction", "constraint", ["security"],
    "credential redaction policy: bearer tokens, sk- API keys, and AWS access keys are replaced with [REDACTED] before any model call.\n"),
  record("handbook", "zstd-streaming.md", "infra/zstd", "procedure", ["compression"],
    "zstd streaming decompression with bounded memory; the decoder fails closed when the payload exceeds the decompressed budget.\n"),
  record("handbook", "fts-rrf.md", "infra/fts-rrf", "decision", ["search", "sqlite"],
    "SQLite FTS5 trigram tokenizer combined with bigram derived terms, fused by reciprocal rank fusion for hybrid lexical retrieval.\n"),
  record("handbook", "release-checklist.md", "ops/release", "procedure", ["release"],
    "release checklist: version bump across packages, lockfile refresh, marketplace bundle sync, and the changelog entry.\n"),
  record("handbook", "cjk-session-rules.md", "conv/zh-rules", "constraint", ["会话", "规范"],
    "中文会话规范：长会话摘要压缩规则，会话日志在空闲一小时后进入候选窗口。\n"),
  record("handbook", "perf-budget.md", "perf/budget", "decision", ["performance"],
    "performance budget: p95 search latency stays under 50ms at ten thousand records.\n"),
  record("handbook", "usage-decay.md", "perf/decay", "decision", ["usage"],
    "usage decay: prior_usage_count decays by a 0.5 factor per generation so fresh generations rank first.\n"),
  record("handbook", "cjk-concurrency.md", "infra/lock", "decision", ["并发", "lock"],
    "中文并发控制：operation lock 采用目录锁，持有者消失且超过 30 秒后回收。\n"),
  record("rollouts", "migrate-legacy.md", "mig/legacy", "procedure", ["migration"],
    "legacy migration scans untracked markdown files and mints record ids from their paths.\n"),
  record("rollouts", "preview-apply.md", "sync/preview", "procedure", ["preview"],
    "preview staging is copied under .sync/previews and the operator applies it later via applyPreview.\n"),
  record("rollouts", "chunked-delivery.md", "sync/chunks", "procedure", ["sync"],
    "分块交付：候选会话按分块送入模型，未交付分块通过 pending-candidates v2 的 next_chunk 断点续传。\n"),
  record("rollouts", "watermark-hold.md", "sync/watermark", "procedure", ["sync"],
    "the watermark holds past rejected, deferred, and truncated windows until every candidate is fully resolved.\n"),
  record("rollouts", "cjk-atomic-replace.md", "sync/atomic", "procedure", ["原子性"],
    "中文原子替换：先把临时文件写完，再用 rename 原子替换目标，失败时清理临时文件。\n"),
  record("rollouts", "token-redaction.md", "sec/query-redaction", "procedure", ["security"],
    "query-string secrets such as ?api_key= and ?token= are redacted inside transcripts.\n"),
  record("rollouts", "rrf-weights.md", "perf/rrf", "decision", ["search"],
    "RRF weights: raw 2.0, FTS 1.0, coverage 1.0, usage 0.25, with the standard k=60 reciprocal constant.\n"),
  record("rollouts", "launchd-restart.md", "ops/restart", "procedure", ["deployment"],
    "restarting the launchd agent inside a safe window requires a backup first and a scan-only acceptance afterwards.\n"),
  record("archive", "old-zstd-tmp.md", "old/zstd-tmp", "observation", ["deprecated"],
    "deprecated: zstd temp files under /tmp were replaced by the staging worktree.\n"),
  record("archive", "superseded-index.md", "old/mem-index", "observation", ["deprecated"],
    "superseded in-memory index approach, replaced by the SQLite derived index.\n"),
  record("archive", "cjk-old-chunks.md", "old/chunks", "observation", ["废弃"],
    "旧版分块方案已废弃：整批截断改为逐候选交付。\n"),
  record("archive", "legacy-fs.md", "old/fs-scan", "observation", ["legacy"],
    "plain filesystem scan with no index, O(N) work per query.\n"),
  record("archive", "old-decay.md", "old/decay", "observation", ["legacy"],
    "old decay formula archived after the usage schema v2 migration.\n"),
  record("archive", "deprecated-lock.md", "old/lock", "observation", ["deprecated"],
    "deprecated flock-based lock replaced by the mkdir directory lock.\n"),
];

for (const entry of CORPUS) {
  const front = [
    "---",
    "schema_version: 1",
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    "tags:",
    ...entry.tags.map((tag) => `  - ${tag}`),
    "---",
    "",
  ].join("\n");
  await writeFile(join(root, entry.dir, entry.name), `${front}${entry.body}`);
}
await git(root, ["add", "."]);
await writeFile(join(root, ".sync", ".gitignore"), "usage.json\nusage.lock/\n.usage.*.tmp\nsearch-index.sqlite\n.search-index.*.tmp\n");
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "retrieval eval fixture"]);

const service = new MemoryRepository({ root, __testOnly: true });
const expectedStamp = stampOf((await git(root, ["ls-tree", "-r", "-z", "HEAD", "--", "summary.md", "handbook", "rollouts", "archive"])).stdout
  .split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [meta, path] = [entry.slice(0, tab), entry.slice(tab + 1)];
    const [, , object] = meta.split(" ");
    return `${object} ${path}`;
  }).sort().join("\n"));

// ---------------------------------------------------------------- cases ----
// Each case: query, optional scope, optional top1 (exact winner), and the
// paths that must appear within `within` (default 3) results.
const CASES = [
  { q: "数据库索引优化实践", top1: "handbook/cjk-db-index.md" },
  { q: "延迟双删", top1: "handbook/cjk-cache.md" },
  { q: "reciprocal rank fusion", top1: "handbook/fts-rrf.md" },
  { q: "pending-candidates v2", top1: "rollouts/chunked-delivery.md" },
  { q: "StartCalendarInterval", top1: "handbook/launchd-setup.md" },
  { q: "[REDACTED]", top1: "handbook/redaction-policy.md" },
  { q: "旁路缓存", top1: "handbook/cjk-cache.md" },
  { q: "写放大", top1: "handbook/cjk-db-index.md" },
  { q: "rename 原子替换", top1: "rollouts/cjk-atomic-replace.md" },
  { q: "mkdir directory lock", top1: "archive/deprecated-lock.md", scope: "archive" },
  { q: "缓存", expect: ["handbook/cjk-cache.md"] },
  { q: "雪崩", expect: ["handbook/cjk-cache.md"] },
  { q: "索引", expect: ["handbook/cjk-db-index.md"] },
  { q: "并发控制", expect: ["handbook/cjk-concurrency.md"] },
  { q: "目录锁", expect: ["handbook/cjk-concurrency.md"] },
  { q: "会话日志", expect: ["handbook/cjk-session-rules.md"] },
  { q: "摘要压缩", expect: ["handbook/cjk-session-rules.md"] },
  { q: "分块", expect: ["rollouts/chunked-delivery.md"] },
  { q: "废弃", scope: "archive", expect: ["archive/cjk-old-chunks.md"] },
  { q: "旧版分块", scope: "archive", expect: ["archive/cjk-old-chunks.md"] },
  { q: "launchd", expect: ["handbook/launchd-setup.md", "rollouts/launchd-restart.md"] },
  { q: "watermark", top1: "rollouts/watermark-hold.md" },
  { q: "trigram", expect: ["handbook/fts-rrf.md"] },
  { q: "checklist", top1: "handbook/release-checklist.md" },
  { q: "preview", expect: ["rollouts/preview-apply.md"] },
  { q: "decay", expect: ["handbook/usage-decay.md"] },
  { q: "flock", scope: "archive", expect: ["archive/deprecated-lock.md"] },
  { q: "untracked", expect: ["rollouts/migrate-legacy.md"] },
  { q: "applyPreview", expect: ["rollouts/preview-apply.md"] },
  { q: "zstd", top1: "handbook/zstd-streaming.md" },
  { q: "constraint", expect: ["handbook/redaction-policy.md", "handbook/cjk-session-rules.md"] },
  { q: "deployment", expect: ["rollouts/launchd-restart.md"] },
  { q: "sec/redaction", top1: "handbook/redaction-policy.md" },
  { q: "perf/budget", top1: "handbook/perf-budget.md" },
  { q: "procedure", expect: ["handbook/launchd-setup.md"] },
  { q: "数据库 OR 索引", expect: ["handbook/cjk-db-index.md"] },
  { q: "cache eviction policy", expect: ["handbook/cjk-cache.md"] },
  { q: "database index optimization", expect: ["handbook/cjk-db-index.md"] },
  { q: "memory sync scheduling", expect: ["handbook/launchd-setup.md"] },
  { q: "usage decay generation", top1: "handbook/usage-decay.md" },
  { q: "search latency budget", expect: ["handbook/perf-budget.md"] },
  { q: "sqlite", expect: ["handbook/fts-rrf.md"] },
  { q: "rebase stacked", expect: ["handbook/git-workflow.md"] },
  { q: "token", expect: ["rollouts/token-redaction.md"] },
  { q: "backup", expect: ["rollouts/launchd-restart.md"] },
  { q: "50ms", top1: "handbook/perf-budget.md" },
  { q: "zstd", scope: "archive", expect: ["archive/old-zstd-tmp.md"] },
  { q: "decay", scope: "archive", expect: ["archive/old-decay.md"] },
  { q: "lock", scope: "archive", expect: ["archive/deprecated-lock.md"] },
  { q: "chunks", scope: "archive", expect: ["archive/cjk-old-chunks.md"] },
  { q: "streaming", expect: ["handbook/zstd-streaming.md"] },
  { q: "迁移 untracked 文件", expect: ["rollouts/migrate-legacy.md"] },
];

let caseIndex = 0;
for (const testCase of CASES) {
  caseIndex += 1;
  const response = await service.search({ query: testCase.q, scope: testCase.scope ?? "active", limit: 10 });
  assert.equal(response.ok, true, `case ${caseIndex} (${testCase.q}) failed: ${JSON.stringify(response.error)}`);
  const paths = response.value.results.map((entry) => entry.path);
  if (testCase.top1 !== undefined) {
    assert.equal(paths[0], testCase.top1, `case ${caseIndex} top1 (${testCase.q}): got ${paths.slice(0, 3).join(", ")}`);
  }
  for (const expected of testCase.expect ?? []) {
    assert.ok(paths.slice(0, 3).includes(expected), `case ${caseIndex} recall (${testCase.q}): ${expected} not in top3, got ${paths.slice(0, 5).join(", ")}`);
  }
  assert.ok(response.value.retrieval, `case ${caseIndex}: retrieval metadata missing`);
  assert.ok(["hybrid", "scan"].includes(response.value.retrieval.mode));
  if (response.value.retrieval.mode === "hybrid") {
    assert.ok(["fresh", "rebuilt"].includes(response.value.retrieval.indexState));
    for (const entry of response.value.results) {
      assert.ok(entry.score_components, `case ${caseIndex}: score_components missing`);
      const components = entry.score_components;
      const sum = components.raw + components.fts + components.coverage + components.usage;
      assert.ok(Math.abs(sum - entry.score) < 1e-9, `case ${caseIndex}: fused score mismatch`);
    }
  } else {
    assert.equal(response.value.retrieval.indexState, "degraded");
  }
}

// Archive scope must hide active records and vice versa.
const activeOnly = await service.search({ query: "zstd" });
assert.ok(activeOnly.value.results.every((entry) => !entry.path.startsWith("archive/")));
const archiveOnly = await service.search({ query: "zstd", scope: "archive" });
assert.ok(archiveOnly.value.results.every((entry) => entry.path.startsWith("archive/")));

// Exact-substring tier outranks usage reinforcement: after repeatedly using a
// non-exact candidate, the exact-substring record still ranks first.
for (let index = 0; index < 5; index += 1) {
  await service.context({ query: "trigram", limit: 1 });
}
const exactBeatsUsage = await service.search({ query: "trigram tokenizer combined" });
assert.equal(exactBeatsUsage.value.results[0].path, "handbook/fts-rrf.md");

// memory_search never records usage: usage.json stays byte-identical across
// searches.
await service.context({ query: "缓存", limit: 1 });
const usageBefore = await readFile(join(root, ".sync", "usage.json"), "utf8");
await service.search({ query: "缓存" });
await service.search({ query: "launchd" });
const usageAfter = await readFile(join(root, ".sync", "usage.json"), "utf8");
assert.equal(usageAfter, usageBefore);

// The derived index exists, is 0600, is untracked (git-excluded), and its
// stamp matches sha256(payloadTree(HEAD)).
const indexPath = join(root, ".sync", "search-index.sqlite");
const indexStat = await lstat(indexPath);
assert.equal(indexStat.isFile(), true);
assert.equal((indexStat.mode & 0o777), 0o600);
const statusAfterSearch = (await git(root, ["status", "--porcelain"])).stdout;
assert.equal(statusAfterSearch, "", `working tree dirty after search: ${statusAfterSearch}`);

const hybridProbe = await service.search({ query: "缓存" });
if (hybridProbe.value.retrieval.mode === "hybrid") {
  assert.equal(hybridProbe.value.retrieval.stamp, expectedStamp);
}

// A new commit invalidates the stamp: the next search rebuilds, and the one
// after that is fresh again.
await writeFile(join(root, "handbook", "retrieval-extra.md"), `---
schema_version: 1
id: infra/retrieval-extra
type: procedure
tags:
  - search
---
retrieval evaluation corpus extension: slop-resistant lexical ranking for a small memory corpus.
`);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "extend retrieval fixture"]);
const rebuilt = await service.search({ query: "slop-resistant" });
if (rebuilt.value.retrieval.mode === "hybrid") {
  assert.equal(rebuilt.value.retrieval.indexState, "rebuilt");
  assert.equal(rebuilt.value.results[0].path, "handbook/retrieval-extra.md");
  const freshAgain = await service.search({ query: "slop-resistant" });
  assert.equal(freshAgain.value.retrieval.indexState, "fresh");
} else {
  assert.equal(rebuilt.value.results[0].path, "handbook/retrieval-extra.md");
}

// v0.9.1: the default (active) scope excludes status-superseded records;
// they remain retrievable through an explicit "all" scope.
await writeFile(join(root, "handbook", "superseded-note.md"), `---
schema_version: 1
id: infra/superseded-note
type: observation
status: superseded
---
superseded zzz-exclusive caching guidance that must not surface by default.
`);
await git(root, ["add", "."]);
await git(root, ["commit", "-m", "add superseded fixture"]);
{
  const active = await service.search({ query: "zzz-exclusive" });
  assert.equal(active.ok, true);
  assert.equal(active.value.results.some((entry) => entry.path === "handbook/superseded-note.md"), false);
  const all = await service.search({ query: "zzz-exclusive", scope: "all" });
  assert.equal(all.ok, true);
  assert.ok(all.value.results.some((entry) => entry.path === "handbook/superseded-note.md"));
}

// Degraded mode: a corrupt index plus an unwritable .sync directory forces
// the pure-scan fallback with correct results.
// Corrupt the SQLite header (not the tail: SQLite tolerates trailing junk
// and would keep serving a "fresh" index), then make .sync unwritable so
// the rebuild attempt fails and retrieval must fall back to the pure scan.
const indexBytes = await readFile(indexPath);
await writeFile(
  indexPath,
  Buffer.concat([Buffer.from("corrupt-header-junk-"), indexBytes.subarray(32)]),
);
await chmod(join(root, ".sync"), 0o500);
try {
  const degraded = await service.search({ query: "缓存" });
  assert.equal(degraded.value.retrieval.mode, "scan");
  assert.equal(degraded.value.retrieval.indexState, "degraded");
  assert.ok(degraded.value.results.slice(0, 3).some((entry) => entry.path === "handbook/cjk-cache.md"));
} finally {
  await chmod(join(root, ".sync"), 0o700);
}

console.log(`dsh-memory retrieval evaluation passed (${CASES.length} labeled cases, corpus ${CORPUS.length} records)`);
