// Host seam contract: settings backends (desktop SettingsForms, legacy
// register scope, none), prompt-section safety and refresh ordering, and the
// memory.enabled gate on model-facing tools. Runs against whichever DSH
// packages resolve (repo devDependencies, or DSH_RUNTIME_NODE_MODULES).
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";

const execFile = promisify(execFileCallback);
const testRoot = await mkdtemp(join(tmpdir(), "dsh-memory-host-contract-"));
const dshHome = join(testRoot, ".dsh");
const memoryRoot = join(dshHome, "storages", "memory");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await tick();
  assert.ok(predicate(), "condition not reached");
}

/** A volatile config reference shaped like schemastery 3.18.4 `.volatile()`. */
function volatileRef(value) {
  return { value, get() { return this.value; } };
}

/** Real cordis Context with the optional seams routed by dependency name. */
function hostContext({ settings } = {}) {
  const ctx = new Context();
  const sections = [];
  const registered = [];
  ctx.tools = { register: (definition) => registered.push(definition) };
  ctx.inject = (dependencies, callback) => {
    if (dependencies[0] === "systemPrompt") {
      callback({
        systemPrompt: {
          section(section) {
            assert.equal(sections.some((live) => live.name === section.name), false, `duplicate prompt section ${section.name}`);
            sections.push(section);
            return () => { const index = sections.indexOf(section); if (index >= 0) sections.splice(index, 1); };
          },
        },
        effect: () => {},
      });
    } else if (dependencies[0] === "settings" && settings !== undefined) {
      callback({ settings, effect: () => {} });
    }
  };
  return { ctx, sections, registered };
}

try {
  await mkdir(dshHome, { recursive: true });
  await execFile(join(projectRoot, "integrations", "dsh", "dsh-memory-init"), [], {
    env: { ...process.env, DSH_HOME: dshHome, DSH_MEMORY_ROOT: memoryRoot },
  });
  await writeFile(join(memoryRoot, "summary.md"), "# Summary\nKeep {{cwd}} and {{unknown}} literal.\n", { mode: 0o600 });
  process.env.DSH_HOME = dshHome;
  process.env.DSH_MEMORY_ROOT = memoryRoot;
  const host = await import("../packages/dsh-memory/lib/index.js");

  // Desktop 0.2: SettingsForms only projects an exported Config schema.
  assert.equal(typeof host.Config, "function", "Config must be exported for desktop SettingsForms");
  const resolved = (value) => (typeof value?.get === "function" ? value.get() : value);
  assert.equal(resolved(host.Config({}).enabled), true);
  assert.equal(resolved(host.Config({ enabled: false }).enabled), false);

  // --- Desktop SettingsForms backend: values come from the loader config. ---
  {
    const updates = [];
    const forms = { describe: () => [], async update(ns, patch) { updates.push([ns, patch]); } };
    const { ctx, sections, registered } = hostContext({ settings: forms });
    const config = { enabled: volatileRef(true) };
    host.apply(ctx, config);
    await until(() => sections.length === 1);
    const section = sections[0];
    assert.equal(section.interpolate, false, "untrusted summary must not be template-expanded");
    assert.equal(section.text.includes("{{"), false, "summary braces must be neutralized for hosts that always interpolate");
    assert.equal(section.text.includes(memoryRoot), false, "prompt must not disclose the absolute memory root");

    const source = host.createSettingsSource(ctx, config);
    const bridge = new host.MemorySettingsBridge();
    bridge.bind(source);
    assert.deepEqual(await bridge.read(), { ok: true, value: { enabled: true } });
    const written = await bridge.setEnabled({ enabled: false });
    assert.equal(written.ok, true);
    assert.deepEqual(updates, [["memory", { enabled: false }]]);

    // The loader commits the volatile value and notifies the fiber.
    config.enabled.value = false;
    ctx.emit("loader/volatile-update", [["enabled"]]);
    await until(() => sections.length === 0);
    const disabled = JSON.parse(await registered.find(({ name }) => name === "memory_search").execute({ query: "summary" }, {}));
    assert.equal(disabled.error, "memory-disabled");
    config.enabled.value = true;
    ctx.emit("loader/volatile-update", [["enabled"]]);
    await until(() => sections.length === 1);
    source.dispose();
  }

  // --- No settings service: writes must not report false success. ---
  {
    const { ctx } = hostContext();
    const config = { enabled: volatileRef(true) };
    const source = host.createSettingsSource(ctx, config);
    const bridge = new host.MemorySettingsBridge();
    bridge.bind(source);
    assert.deepEqual(await bridge.read(), { ok: true, value: { enabled: true } });
    const written = await bridge.setEnabled({ enabled: false });
    assert.equal(written.ok, false);
    assert.equal(written.error.code, "settings-unavailable");
    source.dispose();
  }

  // --- Legacy register scope (DSH rc.6/rc.7 web runtime). ---
  {
    const state = { enabled: true };
    const watchers = new Set();
    const legacy = {
      register(ns) {
        assert.equal(ns, "memory");
        return {
          get: () => state,
          watch: (listener) => { watchers.add(listener); return () => watchers.delete(listener); },
          update: async (patch) => { Object.assign(state, patch); for (const listener of watchers) listener(state); },
        };
      },
    };
    const { ctx, sections } = hostContext({ settings: legacy });
    host.apply(ctx, { enabled: true });
    await until(() => sections.length === 1);
    const source = host.createSettingsSource(ctx, { enabled: true });
    const bridge = new host.MemorySettingsBridge();
    bridge.bind(source);
    assert.deepEqual(await bridge.setEnabled({ enabled: false }), { ok: true, value: { enabled: false } });
    await until(() => sections.length === 0);
    source.dispose();
  }

  // --- Refresh ordering: rapid summary changes keep exactly one live section. ---
  {
    const { ctx, sections } = hostContext({ settings: { update: async () => {} } });
    const config = { enabled: volatileRef(true) };
    host.apply(ctx, config);
    await until(() => sections.length === 1);
    for (let index = 0; index < 5; index += 1) ctx.emit("loader/volatile-update", [["enabled"]]);
    await tick(); await tick();
    assert.equal(sections.length, 1);
    // Disabling while a rebuild is in flight must not resurrect the section.
    ctx.emit("loader/volatile-update", [["enabled"]]);
    config.enabled.value = false;
    ctx.emit("loader/volatile-update", [["enabled"]]);
    await tick(); await tick(); await tick();
    assert.equal(sections.length, 0);
  }

  // --- Empty summary: a short notice instead of an empty snapshot block. ---
  {
    await writeFile(join(memoryRoot, "summary.md"), "", { mode: 0o600 });
    const { ctx, sections } = hostContext();
    host.apply(ctx, { enabled: true });
    await until(() => sections.length === 1);
    assert.equal(sections[0].text.includes("<summary_snapshot>"), false);
    assert.match(sections[0].text, /summary\.md 当前为空/);
  }

  // --- Tool schema bounds. ---
  {
    const { ctx, registered } = hostContext();
    host.apply(ctx, { enabled: true });
    const search = registered.find(({ name }) => name === "memory_search");
    assert.deepEqual(search.parameters.properties.scope.enum, ["active", "all", "archive"]);
    assert.equal(search.parameters.properties.limit.type, "integer");
    const result = JSON.parse(await search.execute({ query: "summary", limit: 10000 }, {}));
    assert.ok(result.results === undefined || result.results.length <= 20);
  }
  console.log("dsh-memory host contract tests passed");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
