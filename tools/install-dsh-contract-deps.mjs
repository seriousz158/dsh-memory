#!/usr/bin/env node
// CI-only dependency overlay: pin the complete DSH peer graph to one tested RC.
// Conflicts remain failures; never suppress peer checks.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version || "")) throw new Error("pass an exact DSH version");
const names = new Set();
for (const p of ["package.json", ...readdirSync("packages").map(n => `packages/${n}/package.json`)]) {
  let d; try { d = JSON.parse(readFileSync(p)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  for (const n of [...Object.keys(d.devDependencies || {}), ...Object.keys(d.peerDependencies || {})])
    if (n.startsWith("@deepseek-ai/dsh-")) names.add(n);
}
const fetched = new Set();
// cordis and schemastery move with each DSH release (0.1.x pins 4.0.2/3.18.2,
// 0.2.x needs ~4.0.4/~3.18.4); take the ranges the DSH packages declare.
const runtimeRanges = new Map();
while ([...names].some(n => !fetched.has(n))) {
  const batch = [...names].filter(n => !fetched.has(n)).slice(0, 8);
  await Promise.all(batch.map(async name => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`registry metadata unavailable: ${name}@${version} (${response.status})`);
    const d = await response.json();
    if (d.name !== name || d.version !== version) throw new Error("registry metadata identity mismatch");
    const declared = { ...(d.peerDependencies || {}), ...(d.dependencies || {}) };
    for (const [n, range] of Object.entries(declared)) {
      if (n.startsWith("@deepseek-ai/dsh-")) names.add(n);
      if ((n === "@deepseek-ai/cordis" || n === "@deepseek-ai/schemastery") && !runtimeRanges.has(n)) runtimeRanges.set(n, range);
    }
    fetched.add(name);
  }));
}
console.log(`Installing ${names.size} DSH contract packages pinned to ${version}`);
for (const n of ["@deepseek-ai/cordis", "@deepseek-ai/schemastery"])
  if (!runtimeRanges.has(n)) throw new Error(`no DSH ${version} package declares ${n}`);
const runtime = [...runtimeRanges].map(([n, range]) => `${n}@${range}`);
console.log(`Runtime peers: ${runtime.join(", ")}`);
const args = ["install", "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", ...runtime, ...[...names].sort().map(n => `${n}@${version}`)];
const result = spawnSync("npm", args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
