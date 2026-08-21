import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";

const execFile = promisify(execFileCallback);
const testRoot = await mkdtemp(join(tmpdir(), "dsh-memory-tools-"));
const dshHome = join(testRoot, ".dsh");
const memoryRoot = join(dshHome, "storages", "memory");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const initializer = join(projectRoot, "integrations", "dsh", "dsh-memory-init");

try {
  await mkdir(dshHome, { recursive: true });
  await execFile(initializer, [], {
    env: { ...process.env, DSH_HOME: dshHome, DSH_MEMORY_ROOT: memoryRoot },
  });
  await writeFile(join(memoryRoot, "summary.md"), "# Summary fixture\nUse this summary snapshot in the startup prompt.\n", { mode: 0o600 });
  const recordPath = join(memoryRoot, "handbook", "tool-record.md");
  await writeFile(recordPath, `---
schema_version: 1
id: tool-record
type: decision
updated_at: 2026-08-21
---

Tool registration fixture for memory context.
`, { mode: 0o600 });
  await execFile("/usr/bin/git", ["-C", memoryRoot, "add", "handbook/tool-record.md"]);
  await execFile("/usr/bin/git", ["-C", memoryRoot, "commit", "-m", "Add tool fixture"]);

  process.env.DSH_HOME = dshHome;
  process.env.DSH_MEMORY_ROOT = memoryRoot;
  const { apply } = await import("../packages/dsh-memory/lib/index.js");
  const registered = [];
  const sections = [];
  const context = new Context();
  context.settings = {
    register() {
      const state = { enabled: true };
      return {
        get: () => state,
        watch: () => () => {},
        update: async (patch) => Object.assign(state, patch),
      };
    },
  };
  context.tools = { register: (definition) => registered.push(definition) };
  context.inject = (dependencies, callback) => {
    if (dependencies[0] === "systemPrompt") {
      callback({
        systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
        effect: () => {},
      });
    }
  };
  apply(context, {});
  for (let attempt = 0; attempt < 20 && sections.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sections.length, 1);
  assert.match(sections[0].text, /<summary_snapshot>/);
  assert.match(sections[0].text, /Use this summary snapshot/);
  assert.match(sections[0].text, /DPSK MEMORY: UNTRUSTED CONTEXT/);

  assert.deepEqual(registered.map(({ name }) => name), ["memory_search", "memory_context"]);
  const search = registered.find(({ name }) => name === "memory_search");
  const contextTool = registered.find(({ name }) => name === "memory_context");
  const signal = new AbortController().signal;
  const searchResult = JSON.parse(await search.execute({ query: "tool registration" }, { signal }));
  assert.equal(searchResult.count, 1);
  assert.equal(searchResult.results[0].path, "handbook/tool-record.md");
  assert.equal(searchResult.results[0].citation, "[source: handbook/tool-record.md · id: tool-record]");

  const contextResult = JSON.parse(await contextTool.execute({ query: "tool registration", limit: 5 }, { signal }));
  assert.equal(contextResult.count, 1);
  assert.equal(contextResult.records[0].path, "handbook/tool-record.md");
  assert.equal(contextResult.records[0].usage_count, 1);
  const usage = JSON.parse(await readFile(join(memoryRoot, ".sync", "usage.json"), "utf8"));
  assert.equal(usage.records["handbook/tool-record.md"].usage_count, 1);
  console.log("dsh-memory tool registration tests passed");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
