import assert from "node:assert/strict";
import {
  parseFrontMatter,
  renderFrontMatter,
  MetadataError,
  SCHEMA_VERSION,
  ID_RE,
  topicKey,
  resolveTopicConflict,
  isExpired,
  auditRecords,
  AUDIT_INVALID_METADATA_LIMIT,
} from "../packages/dsh-memory/lib/memory-metadata.js";

const canonical = `---
schema_version: 1
id: preference-response-language
type: preference
status: active
confidence: high
created_at: 2026-08-19
updated_at: 2026-08-19
tags:
  - language
source_rollouts:
  - rollouts/2026-08-19-session-001.md
---
正文
`;

{
  const metadata = parseFrontMatter(canonical, "handbook/preferences.md");
  assert.equal(metadata.id, "preference-response-language");
  assert.equal(metadata.type, "preference");
  assert.equal(metadata.status, "active");
  assert.equal(metadata.confidence, "high");
  assert.deepEqual(metadata.tags, ["language"]);
  assert.deepEqual(metadata.source_rollouts, ["rollouts/2026-08-19-session-001.md"]);
}

{
  // Legacy record (no front matter) parses to null.
  assert.equal(parseFrontMatter("# plain markdown\ncontent\n", "handbook/legacy.md"), null);
}

{
  // summary.md is not a record and never parses.
  assert.equal(parseFrontMatter("---\nschema_version: 1\nid: x\n---\n", "summary.md"), null);
}

{
  // Missing optional fields get defaults.
  const metadata = parseFrontMatter("---\nschema_version: 1\nid: minimal-record\n---\n", "rollouts/2026-08-19-session.md");
  assert.equal(metadata.type, "observation");
  assert.equal(metadata.status, "active");
  assert.equal(metadata.confidence, "unknown");
  assert.deepEqual(metadata.tags, []);
  assert.match(metadata.created_at, /^\d{4}-\d{2}-\d{2}$/);
}

{
  // Invalid schema version fails closed.
  assert.throws(() => parseFrontMatter("---\nschema_version: 2\nid: x\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-schema-version");
}

{
  // Invalid id fails closed.
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: UPPER\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-id");
}

{
  // Unknown enum values fail closed.
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\ntype: banana\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-metadata");
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\nstatus: floating\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-metadata");
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\nconfidence: sure\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-metadata");
}

{
  // Invalid dates fail closed.
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\ncreated_at: not-a-date\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-metadata");
}

{
  // Out-of-tree source_rollouts fail closed.
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\nsource_rollouts:\n  - ../outside.md\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-metadata");
}

{
  // Malformed YAML line fails closed.
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\n: broken\n---\n", "handbook/x.md"), (error) => error instanceof MetadataError && error.code === "invalid-metadata");
}

{
  // Round trip: rendered metadata parses back identically.
  const source = parseFrontMatter(canonical, "handbook/preferences.md");
  const rendered = renderFrontMatter(source) + "正文\n";
  const reparsed = parseFrontMatter(rendered, "handbook/preferences.md");
  assert.deepEqual(reparsed, source);
}

{
  assert.equal(SCHEMA_VERSION, 1);
}

{
  // v0.4: namespaced ids are accepted, multi-segment and malformed ones fail.
  assert.equal(ID_RE.test("project/codegen"), true);
  assert.equal(ID_RE.test("user/preferences"), true);
  assert.equal(ID_RE.test("plain"), true);
  assert.equal(ID_RE.test("a/b/c"), false);
  assert.equal(ID_RE.test("Bad/Id"), false);
  assert.equal(ID_RE.test("/leading"), false);
  assert.equal(ID_RE.test("trailing/"), false);
  assert.equal(parseFrontMatter("---\nschema_version: 1\nid: project/codegen\n---\n", "handbook/project.md").id, "project/codegen");
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: a/b/c\n---\n", "handbook/x.md"), (error) => error.code === "invalid-id");
}

{
  // v0.4: provenance fields parse, render, and round-trip.
  const source = parseFrontMatter(`---
schema_version: 1
id: project/codegen
type: decision
created_by: sync-agent
source_hash: sha256-abc123
review_after: 2026-09-01
expires_at: 2026-12-31
---
body`, "handbook/project.md");
  assert.equal(source.created_by, "sync-agent");
  assert.equal(source.source_hash, "sha256-abc123");
  assert.equal(source.review_after, "2026-09-01");
  assert.equal(source.expires_at, "2026-12-31");
  const rendered = renderFrontMatter(source);
  assert.match(rendered, /created_by: sync-agent/);
  assert.match(rendered, /source_hash: sha256-abc123/);
  assert.match(rendered, /expires_at: 2026-12-31/);
  const reparsed = parseFrontMatter(rendered + "body\n", "handbook/project.md");
  assert.equal(reparsed.created_by, "sync-agent");
  // Missing provenance defaults to null.
  const plain = parseFrontMatter("---\nschema_version: 1\nid: plain\n---\n", "handbook/p.md");
  assert.equal(plain.source_hash, null);
  assert.equal(plain.created_by, null);
  // Invalid provenance fails closed.
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\nsource_hash: ''\n---\n", "handbook/x.md"), (error) => error.code === "invalid-metadata");
  assert.throws(() => parseFrontMatter("---\nschema_version: 1\nid: x\nexpires_at: not-a-date\n---\n", "handbook/x.md"), (error) => error.code === "invalid-metadata");
}

{
  // v0.4: deterministic topic key is type + namespace.
  assert.equal(topicKey({ id: "project/codegen", type: "decision" }), "decision:project");
  assert.equal(topicKey({ id: "plain", type: "preference" }), "preference:");
  assert.equal(topicKey({ id: "a/b", type: "fact" }), "fact:a");
  // Conflict resolution: active beats candidate, newest updated_at wins,
  // expired records never win, smallest id breaks ties.
  const candidates = [
    { id: "ns/topic", type: "fact", status: "candidate", updated_at: "2026-08-05" },
    { id: "ns/topic", type: "fact", status: "active", updated_at: "2026-08-01" },
    { id: "ns/topic", type: "fact", status: "active", updated_at: "2026-08-03", expires_at: "2020-01-01" },
    { id: "ns/topic", type: "fact", status: "active", updated_at: "2026-08-03" },
  ];
  const winner = resolveTopicConflict(candidates);
  assert.equal(winner.status, "active");
  assert.equal(winner.updated_at, "2026-08-03");
  assert.equal(winner.expires_at, undefined);
  // All expired -> no winner.
  const stale = candidates.map((record) => ({ ...record, expires_at: "2020-01-01" }));
  assert.equal(resolveTopicConflict(stale), null);
  // isExpired projection.
  assert.equal(isExpired({ expires_at: "2020-01-01" }), true);
  assert.equal(isExpired({ expires_at: "2999-01-01" }), false);
  assert.equal(isExpired({}), false);
}

{
  // v0.8.3: flow-style collections are rejected with a stable code; empty
  // flow collections and canonical block lists stay valid.
  assert.throws(
    () => parseFrontMatter("---\nschema_version: 1\nid: x\ntags: [a, b]\n---\n", "handbook/x.md"),
    (error) => error instanceof MetadataError && error.code === "flow-style-metadata",
  );
  assert.throws(
    () => parseFrontMatter("---\nschema_version: 1\nid: x\nsource_rollouts: {a: 1}\n---\n", "handbook/x.md"),
    (error) => error instanceof MetadataError && error.code === "flow-style-metadata",
  );
  const emptyFlow = parseFrontMatter("---\nschema_version: 1\nid: x\ntags: []\n---\n", "handbook/x.md");
  assert.deepEqual(emptyFlow.tags, []);
  const blockList = parseFrontMatter("---\nschema_version: 1\nid: x\ntags:\n  - a\n  - b\n---\n", "handbook/x.md");
  assert.deepEqual(blockList.tags, ["a", "b"]);
}

{
  // v0.8.3: the shared metadata audit reports valid/legacy/invalid records,
  // duplicate ids, and truncates the invalid list to the documented limit.
  const valid = (id) => `---\nschema_version: 1\nid: ${id}\n---\n正文\n`;
  const audit = auditRecords([
    { path: "handbook/a.md", content: valid("rec-a") },
    { path: "handbook/b.md", content: valid("rec-b") },
    { path: "handbook/legacy.md", content: "# plain markdown\nlegacy record\n" },
    { path: "handbook/bad.md", content: "---\nschema_version: 2\nid: rec-bad\n---\n" },
    { path: "handbook/flow.md", content: "---\nschema_version: 1\nid: rec-flow\ntags: [x]\n---\n" },
    { path: "handbook/gone.md", content: null },
    { path: "handbook/dup.md", content: valid("rec-a") },
  ]);
  assert.equal(audit.metadataValid, false);
  assert.equal(audit.validMetadataCount, 3); // rec-a, rec-b, dup
  assert.equal(audit.legacyMetadataCount, 1);
  assert.equal(audit.invalidMetadataCount, 4); // bad + flow + gone + dup
  assert.equal(audit.duplicateIdCount, 1);
  assert.ok(audit.invalidMetadata.length <= AUDIT_INVALID_METADATA_LIMIT);
  const byPath = new Map(audit.invalidMetadata.map((entry) => [entry.path, entry.code]));
  assert.equal(byPath.get("handbook/bad.md"), "invalid-schema-version");
  assert.equal(byPath.get("handbook/flow.md"), "flow-style-metadata");
  assert.equal(byPath.get("handbook/gone.md"), "unreadable");
  assert.equal(byPath.get("handbook/dup.md"), "duplicate-id");
}

{
  // v0.8.3: a fully valid corpus audits clean; legacy records grandfather.
  const audit = auditRecords([
    { path: "handbook/a.md", content: "---\nschema_version: 1\nid: rec-a\n---\n" },
    { path: "handbook/legacy.md", content: "# plain markdown\n" },
  ]);
  assert.equal(audit.metadataValid, true);
  assert.equal(audit.validMetadataCount, 1);
  assert.equal(audit.invalidMetadataCount, 0);
  assert.equal(audit.legacyMetadataCount, 1);
  assert.deepEqual(audit.invalidMetadata, []);
}

{
  // v0.8.3: the invalid list is truncated to AUDIT_INVALID_METADATA_LIMIT
  // while the count reflects every invalid record.
  const flood = [];
  for (let i = 0; i < AUDIT_INVALID_METADATA_LIMIT + 10; i += 1) {
    flood.push({ path: `handbook/flood-${i}.md`, content: "---\nschema_version: 9\nid: x\n---\n" });
  }
  const audit = auditRecords(flood);
  assert.equal(audit.metadataValid, false);
  assert.equal(audit.invalidMetadataCount, AUDIT_INVALID_METADATA_LIMIT + 10);
  assert.equal(audit.invalidMetadata.length, AUDIT_INVALID_METADATA_LIMIT);
}

console.log("dsh-memory metadata tests passed");
