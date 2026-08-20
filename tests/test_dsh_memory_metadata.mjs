import assert from "node:assert/strict";
import {
  parseFrontMatter,
  renderFrontMatter,
  MetadataError,
  SCHEMA_VERSION,
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

console.log("dsh-memory metadata tests passed");
