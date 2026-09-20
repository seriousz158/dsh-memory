import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(process.env.DSH_RUNTIME_NODE_MODULES || join(root, "node_modules"));
const settings = JSON.parse(await readFile(join(runtime, "@deepseek-ai/dsh-settings/package.json"), "utf8"));
if (process.env.DSH_EXPECTED_VERSION) assert.equal(settings.version, process.env.DSH_EXPECTED_VERSION);
const scratch = await mkdtemp(join(tmpdir(), "dsh-import-contract-"));
await symlink(runtime, join(scratch, "node_modules"), "dir");
const packages = ["dsh-memory", "dsh-memory-ui", "dsh-git-memory"];
for (const name of packages) {
  const destination = join(scratch, name);
  await cp(join(root, "packages", name), destination, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("node_modules") });
  const entry = await import(pathToFileURL(join(destination, "lib/index.js")).href);
  assert.equal(typeof (entry.apply || entry.default), "function", name + " must export a Host plugin");
}
console.log(`Real DSH ${settings.version} import contracts passed: ${packages.join(", ")}`);
