import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const project = fileURLToPath(new URL("..", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "dsh-memory-paths-"));
const hostModule = join(fixture, "dsh-memory", "lib", "index.js");

await mkdir(dirname(hostModule), { recursive: true });
await cp(join(project, "packages/dsh-memory/lib/index.js"), hostModule);
await cp(
  join(project, "packages/dsh-memory/lib/operation-lock.js"),
  join(fixture, "dsh-memory", "lib", "operation-lock.js"),
);
await cp(
  join(project, "packages/dsh-memory/lib/memory-metadata.js"),
  join(fixture, "dsh-memory", "lib", "memory-metadata.js"),
);
await cp(
  join(project, "packages/dsh-memory/lib/memory-tree.js"),
  join(fixture, "dsh-memory", "lib", "memory-tree.js"),
);
await cp(
  join(project, "packages/dsh-memory/lib/memory-usage.js"),
  join(fixture, "dsh-memory", "lib", "memory-usage.js"),
);
await cp(
  join(project, "packages/dsh-memory/lib/legacy-migration.js"),
  join(fixture, "dsh-memory", "lib", "legacy-migration.js"),
);
await cp(
  join(project, "packages/dsh-memory/lib/sync-transaction.js"),
  join(fixture, "dsh-memory", "lib", "sync-transaction.js"),
);
await writeFile(join(fixture, "dsh-memory", "package.json"), '{"type":"module"}\n');

const stubs = {
  "@deepseek-ai/schemastery": "export default { boolean: () => ({ default: () => ({}) }), object: () => ({}) };\n",
  "@deepseek-ai/dsh-typert-protocol": "export const Remote = () => () => {}; export class TypertRemoteService { constructor() {} }\n",
  "@deepseek-ai/dsh-settings": "export const settingsNamespace = (name) => name;\n",
};
for (const [name, source] of Object.entries(stubs)) {
  const packageRoot = join(fixture, "dsh-memory", "node_modules", ...name.split("/"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), '{"type":"module","exports":"./index.js"}\n');
  await writeFile(join(packageRoot, "index.js"), source);
}

async function rootsFor(env) {
  const program = [
    `import { DEFAULT_DSH_HOME, DEFAULT_MEMORY_ROOT } from ${JSON.stringify(pathToFileURL(hostModule).href)};`,
    "console.log(JSON.stringify({ DEFAULT_DSH_HOME, DEFAULT_MEMORY_ROOT }));",
  ].join("\n");
  const { stdout } = await execFile(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(stdout);
}

const dshHome = join(fixture, "custom-home", ".dsh");
const fromHome = await rootsFor({ DSH_HOME: dshHome, DSH_MEMORY_ROOT: "" });
assert.equal(fromHome.DEFAULT_DSH_HOME, dshHome);
assert.equal(fromHome.DEFAULT_MEMORY_ROOT, join(dshHome, "storages", "memory"));

const override = join(fixture, "isolated-memory");
const overridden = await rootsFor({ DSH_HOME: dshHome, DSH_MEMORY_ROOT: override });
assert.equal(overridden.DEFAULT_DSH_HOME, dshHome);
assert.equal(overridden.DEFAULT_MEMORY_ROOT, override);
assert.doesNotMatch(overridden.DEFAULT_MEMORY_ROOT, /\.zcode(?:\/|$)/);

console.log("dsh-memory path isolation tests passed");
