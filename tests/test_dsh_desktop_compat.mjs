import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const expected = process.env.DSH_DESKTOP_VERSION || "0.1.7-rc.1";
const paths = [
  join(root, "package.json"),
  join(root, "packages/dsh-memory/package.json"),
  join(root, "packages/dsh-memory-ui/package.json"),
];
for (const path of paths) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name.startsWith("@deepseek-ai/dsh-")) {
      assert.match(range, new RegExp(expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), `${path}: ${name}`);
    }
  }
}
const ui = JSON.parse(await readFile(paths[2], "utf8"));
assert.equal(ui.dsh.client.inject.includes("@deepseek-ai/dsh-client-runtime"), false);
console.log(`DSH desktop ${expected} memory compatibility contract passed`);
