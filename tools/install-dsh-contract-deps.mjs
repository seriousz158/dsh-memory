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
while ([...names].some(n => !fetched.has(n))) {
  const batch = [...names].filter(n => !fetched.has(n)).slice(0, 8);
  await Promise.all(batch.map(async name => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`registry metadata unavailable: ${name}@${version} (${response.status})`);
    const d = await response.json();
    if (d.name !== name || d.version !== version) throw new Error("registry metadata identity mismatch");
    for (const n of [...Object.keys(d.dependencies || {}), ...Object.keys(d.peerDependencies || {})])
      if (n.startsWith("@deepseek-ai/dsh-")) names.add(n);
    fetched.add(name);
  }));
}
console.log(`Installing ${names.size} DSH contract packages pinned to ${version}`);
const args = ["install", "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", "@deepseek-ai/cordis@4.0.2", "@deepseek-ai/schemastery@3.18.2", ...[...names].sort().map(n => `${n}@${version}`)];
const result = spawnSync("npm", args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
