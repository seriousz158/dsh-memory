// DSH desktop compatibility contract.
//
// Always: every @deepseek-ai/dsh-* peer range admits the desktop 0.2 line.
// With DSH_DESKTOP_NODE_MODULES pointing at a real desktop dependency graph
// (CI: tools/install-dsh-contract-deps.mjs 0.2.0-rc.2; locally: the app's
// extracted node_modules), the plugins are additionally loaded against that
// runtime: the app's own peer evaluation must accept them, Config must be a
// volatile SettingsForms schema, the memory section must render literally
// through the real prompt renderer, and the host contract suite must pass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const manifests = [
  join(root, "package.json"),
  join(root, "packages/dsh-memory/package.json"),
  join(root, "packages/dsh-memory-ui/package.json"),
];
for (const path of manifests) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name.startsWith("@deepseek-ai/dsh-")) assert.match(range, />=0\.2\.0-rc\.2 <0\.3\.0/, `${path}: ${name}`);
  }
}
const ui = JSON.parse(await readFile(manifests[2], "utf8"));
assert.equal(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-runtime"), false);

const runtimeModules = process.env.DSH_DESKTOP_NODE_MODULES;
if (!runtimeModules) {
  console.log("DSH desktop manifest contract passed (set DSH_DESKTOP_NODE_MODULES for the runtime contract)");
  process.exit(0);
}

const scratch = await mkdtemp(join(tmpdir(), "dsh-desktop-contract-"));
try {
  await symlink(resolve(runtimeModules), join(scratch, "node_modules"), "dir");
  const skipNodeModules = (path) => !path.split(/[\\/]/).includes("node_modules");
  for (const entry of ["packages", "integrations", "tests"]) {
    await cp(join(root, entry), join(scratch, entry), { recursive: true, filter: skipNodeModules });
  }
  await cp(join(root, "package.json"), join(scratch, "package.json"));
  const probe = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluatePluginCompatibility } from "@deepseek-ai/dsh-app-boot";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { Context } from "@deepseek-ai/cordis";
const runtime = JSON.parse(readFileSync("node_modules/@deepseek-ai/dsh-app-boot/package.json", "utf8")).version;
for (const path of ["package.json", "packages/dsh-memory/package.json", "packages/dsh-memory-ui/package.json"]) {
  assert.equal(evaluatePluginCompatibility(JSON.parse(readFileSync(path, "utf8")), {}, runtime), undefined, path + " rejected by DSH " + runtime);
}
const host = await import("./packages/dsh-memory/lib/index.js");
const config = host.Config({});
assert.equal(typeof config.enabled?.get, "function", "memory.enabled must be a volatile SettingsForms field");
assert.equal(config.enabled.get(), true);
const sections = [];
const ctx = new Context();
ctx.tools = { register() {} };
ctx.inject = (deps, callback) => {
  if (deps[0] === "systemPrompt") callback({ systemPrompt: { section: (s) => { sections.push(s); return () => {}; } }, effect() {} });
};
host.apply(ctx, config);
for (let i = 0; i < 100 && sections.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
assert.equal(sections.length, 1);
const rendered = renderPrompt({ sections, variables: { cwd: "/workspace" } });
assert.equal(rendered.includes("/workspace"), false, "summary text must not be template-expanded");
console.log("runtime " + runtime);
`;
  const env = { ...process.env, DSH_HOME: join(scratch, "dsh-home"), DSH_MEMORY_ROOT: join(scratch, "dsh-home", "storages", "memory") };
  spawnSync(join(scratch, "integrations/dsh/dsh-memory-init"), [], { env, stdio: ["ignore", "ignore", "inherit"] });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(env.DSH_MEMORY_ROOT, "summary.md"), "Keep {{cwd}} literal.\n");
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { cwd: scratch, env, encoding: "utf8" });
    if (result.status !== 0) {
      process.stderr.write(result.stdout + result.stderr);
      throw new Error(`desktop runtime contract failed: node ${args.join(" ")}`);
    }
    return result.stdout.trim();
  };
  const version = run(["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", probe]).split("\n").pop();
  run(["--disable-warning=ExperimentalWarning", "tests/test_dsh_memory_host_contract.mjs"]);
  console.log(`DSH desktop ${version.replace(/^runtime /, "")} memory runtime contract passed`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
