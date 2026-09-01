import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const project = join(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
const patch = await readFile(join(project, "packages/dsh-git-memory/cordis.patch.yml"), "utf8");

assert.equal(manifest.name, "dsh-git-memory");
assert.equal(manifest.version, "0.8.3");
assert.notEqual(manifest.private, true);
assert.equal(manifest.main, "./packages/dsh-git-memory/lib/index.js");
assert.equal(manifest.exports["."], "./packages/dsh-git-memory/lib/index.js");
assert.equal(manifest.exports["./client"], "./packages/dsh-git-memory/client/client.js");
assert.equal(manifest.exports["./cordis.patch.yml"], "./packages/dsh-git-memory/cordis.patch.yml");
assert.deepEqual(manifest.dsh?.bundle, { patch: "./packages/dsh-git-memory/cordis.patch.yml" });
assert.equal(manifest.dsh?.client?.platform, "web");
assert.deepEqual(manifest.dsh?.client?.inject, [
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-ui-settings",
]);
assert.match(patch, /id:\s*memory\s*\n\s+name:\s+dsh-git-memory/);

const sourceClient = await readFile(join(project, "packages/dsh-memory-ui/lib/client.js"), "utf8");
const publicClient = await readFile(join(project, "packages/dsh-git-memory/client/client.js"), "utf8");
assert.equal(
  publicClient,
  sourceClient.replace('  id: "dsh-memory-ui",', '  id: "dsh-git-memory",'),
  "public client bundle must be generated from the source UI bundle",
);
assert.match(publicClient, /id:\s*"dsh-git-memory"/);
assert.doesNotMatch(publicClient, /id:\s*"dsh-memory-ui"/);

const { stdout } = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: project });
const pack = JSON.parse(stdout)[0];
const files = new Set((pack.files ?? []).map(({ path }) => path));
for (const required of [
  "LICENSE",
  "README.md",
  "package.json",
  "packages/dsh-git-memory/cordis.patch.yml",
  "packages/dsh-git-memory/client/client.js",
  "packages/dsh-git-memory/lib/index.js",
  "packages/dsh-git-memory/lib/sync-apply.py",
]) assert(files.has(required), `npm pack is missing ${required}`);
for (const file of files) assert(!file.startsWith(".dsh/"), `npm pack leaked DSH state: ${file}`);

const host = await import(join(project, "packages/dsh-git-memory/lib/index.js"));
assert.equal(host.name, "dsh-memory");
assert.deepEqual(host.inject, ["settings", "tools"]);

console.log(`dsh-memory marketplace bundle tests passed (${files.size} package files)`);
