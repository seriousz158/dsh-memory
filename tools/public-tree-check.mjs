#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);

const gitBuffer = (args) => execFileSync("git", args, { cwd: root, encoding: "buffer" });
const gitText = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const nullSeparated = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);
const parseIndexRecords = () => nullSeparated(gitBuffer(["ls-files", "--stage", "-z"])).map((record) => {
  const tab = record.indexOf("\t");
  const [mode, object, stage] = record.slice(0, tab).split(" ");
  return { mode, object, stage, file: record.slice(tab + 1) };
});
const indexRecords = parseIndexRecords();
const tracked = [...new Set(indexRecords.map((record) => record.file))].sort();
const untracked = nullSeparated(gitBuffer(["ls-files", "--others", "--exclude-standard", "-z"]));
const candidates = [...new Set([...tracked, ...untracked])].sort();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const allowed = new Set([
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".gitignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package-lock.json",
  "package.json",
  "docs/api.md",
  "docs/compatibility.md",
  "docs/installation.md",
  "docs/privacy-and-recovery.md",
  "docs/release-checklist.md",
  "examples/dsh/cordis.patch.yml.example",
  "examples/dsh/settings.yaml.example",
  "integrations/dsh/dsh-memory-backup",
  "integrations/dsh/dsh-memory-init",
  "integrations/dsh/dsh-memory-migrate",
  "integrations/dsh/dsh-memory-sync",
  "integrations/dsh/dsh-memory-sync.plist.example",
  "integrations/dsh/install.sh",
  "packages/dsh-memory/package.json",
  "packages/dsh-memory/.npmignore",
  "packages/dsh-memory/LICENSE",
  "packages/dsh-memory/lib/index.js",
  "packages/dsh-memory/lib/legacy-migration.js",
  "packages/dsh-memory/lib/memory-metadata.js",
  "packages/dsh-memory/lib/memory-usage.js",
  "packages/dsh-memory/lib/memory-tree.js",
  "packages/dsh-memory/lib/operation-lock.js",
  "packages/dsh-memory/lib/safe-clear.py",
  "packages/dsh-memory/lib/sync-apply.py",
  "packages/dsh-memory/lib/sync-transaction.js",
  "packages/dsh-memory/templates/README.md",
  "packages/dsh-memory/templates/.sync/.gitignore",
  "packages/dsh-memory/templates/scripts/filter_session.py",
  "packages/dsh-git-memory/cordis.patch.yml",
  "packages/dsh-git-memory/client/client.js",
  "packages/dsh-git-memory/lib/index.js",
  "packages/dsh-git-memory/lib/legacy-migration.js",
  "packages/dsh-git-memory/lib/memory-metadata.js",
  "packages/dsh-git-memory/lib/memory-tree.js",
  "packages/dsh-git-memory/lib/memory-usage.js",
  "packages/dsh-git-memory/lib/operation-lock.js",
  "packages/dsh-git-memory/lib/safe-clear.py",
  "packages/dsh-git-memory/lib/sync-apply.py",
  "packages/dsh-git-memory/lib/sync-transaction.js",
  "packages/dsh-memory-ui/package.json",
  "packages/dsh-memory-ui/LICENSE",
  "packages/dsh-memory-ui/lib/client.js",
  "packages/dsh-memory-ui/lib/index.js",
  "tests/run-memory-tests.sh",
  "tests/helpers/dsh-e2e-service.mjs",
  "tests/test_dsh_memory_e2e_ui.py",
  "tests/test_dsh_memory_init.sh",
  "tests/test_dsh_memory_install.sh",
  "tests/test_dsh_memory_metadata.mjs",
  "tests/test_dsh_memory_usage.mjs",
  "tests/test_dsh_memory_context.mjs",
  "tests/test_dsh_memory_tools.mjs",
  "tests/test_dsh_memory_operation_lock.mjs",
  "tests/test_dsh_memory_backup.sh",
  "tests/test_dsh_memory_migrate.sh",
  "tests/test_dsh_memory_marketplace.mjs",
  "tests/test_dsh_memory_sync_failures.py",
  "tests/test_dsh_memory_migration_api.mjs",
  "tests/test_dsh_memory_paths.mjs",
  "tests/test_dsh_memory_preview.mjs",
  "tests/test_dsh_memory_redaction.mjs",
  "tests/test_dsh_memory_repository.mjs",
  "tests/test_dsh_memory_sync_transaction.mjs",
  "tests/test_dsh_memory_runtime.sh",
  "tests/test_dsh_memory_sync_disabled.sh",
  "tests/test_dsh_memory_sync_dry_run.sh",
  "tests/test_dsh_memory_sync_env.sh",
  "tests/test_dsh_memory_sync_chunks.sh",
  "tests/test_dsh_memory_sync_zstd_failure.sh",
  "tests/test_dsh_memory_sync_lock.sh",
  "tests/test_dsh_memory_sync_batch.sh",
  "tests/test_dsh_memory_sync_preview.sh",
  "tests/test_dsh_memory_sync_no_change.sh",
  "tests/test_dsh_memory_ui_settings_row.sh",
  "tests/test_public_tree.sh",
  "tests/test_release_guards.sh",
  "tools/public-tree-check.mjs",
  "tools/secret-scan.mjs",
  "tools/secret-scan.sh",
  "tools/sync-marketplace-bundle.mjs",
]);
const findings = [];
const add = (label, file) => {
  if (!findings.some((finding) => finding.label === label && finding.file === file)) {
    findings.push({ label, file });
  }
};
const forbiddenLifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
]);

if (candidates.length === 0) {
  console.error("public tree check: repository has no source candidates");
  process.exit(2);
}

function isStrictUtf8Text(content) {
  if (content.includes(0)) return false;
  try {
    textDecoder.decode(content);
    return true;
  } catch {
    return false;
  }
}

function hasUnresolvedMergeMarker(content) {
  return /^[\t ]*(?:<{7}|={7}|>{7})(?:[\t ].*)?$/m.test(content);
}

function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

function snapshotIndex() {
  const snapshot = mkdtempSync(join(tmpdir(), "dsh-memory-public-tree-"));
  try {
    const tree = gitText(["write-tree"]).trim();
    execFileSync("tar", ["-x", "-C", snapshot], {
      cwd: root,
      input: gitBuffer(["archive", "--format=tar", tree]),
    });
    return snapshot;
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true, maxRetries: 2 });
    throw error;
  }
}

function readSnapshotText(snapshot, path) {
  const absolute = resolve(snapshot, path);
  if (!isInside(snapshot, absolute)) {
    add("index snapshot path escapes its root", path);
    return null;
  }
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      add("symbolic-link source candidate", path);
      return null;
    }
    if (!stat.isFile()) {
      add("non-file source candidate", path);
      return null;
    }
    const content = readFileSync(absolute);
    if (!isStrictUtf8Text(content)) {
      add("binary source candidate", path);
      return null;
    }
    return content.toString("utf8");
  } catch {
    add("indexed source is missing from the snapshot", path);
    return null;
  }
}

function checkWorkingTreeCandidate(file) {
  if (!allowed.has(file)) add("path is outside the publication allowlist", file);
  const absolute = resolve(root, file);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) add("symbolic-link source candidate", file);
    else if (!stat.isFile()) add("non-file source candidate", file);
    else {
      const content = readFileSync(absolute);
      if (!isStrictUtf8Text(content)) add("binary source candidate", file);
      else if (hasUnresolvedMergeMarker(content.toString("utf8"))) add("unresolved merge marker", file);
    }
  } catch {
    add("untracked source is missing from the working tree", file);
  }
}

for (const record of indexRecords) {
  if (!allowed.has(record.file)) add("path is outside the publication allowlist", record.file);
  if (record.mode === "120000") {
    add("tracked symbolic link", record.file);
    continue;
  }
  if (record.mode !== "100644" && record.mode !== "100755") {
    add("non-regular indexed source", record.file);
  }
}
for (const file of untracked) checkWorkingTreeCandidate(file);

let snapshot;
try {
  snapshot = snapshotIndex();
} catch {
  add("cannot construct Git index snapshot", "Git index");
}

try {
  if (snapshot) {
    for (const file of tracked) {
      const content = readSnapshotText(snapshot, file);
      if (content !== null && hasUnresolvedMergeMarker(content)) add("unresolved merge marker", file);
    }

    const expectedManifestVersions = {
      "package.json": "0.8.4",
      "packages/dsh-memory/package.json": "0.8.4",
      "packages/dsh-memory-ui/package.json": "0.8.4",
    };
    for (const manifestPath of Object.keys(expectedManifestVersions)) {
      const content = readSnapshotText(snapshot, manifestPath);
      if (content === null) continue;
      try {
        const manifest = JSON.parse(content);
        const expectedVersion = expectedManifestVersions[manifestPath];
        if (manifest.version !== expectedVersion) add(`manifest version is not ${expectedVersion}`, manifestPath);
        if (manifestPath !== "package.json" && manifest.private !== true) {
          add("package is not locked against npm publication", manifestPath);
        }
        if (manifest.scripts !== undefined && (manifest.scripts === null || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts))) {
          add("manifest scripts is not an object", manifestPath);
        } else {
          for (const script of forbiddenLifecycleScripts) {
            if (Object.hasOwn(manifest.scripts ?? {}, script)) {
              add("package lifecycle script is not allowed", `${manifestPath}:${script}`);
            }
          }
        }
      } catch {
        add("manifest is not valid JSON", manifestPath);
      }
    }

    for (const configPath of ["package.json", ".github/workflows/ci.yml"]) {
      const content = readSnapshotText(snapshot, configPath);
      if (content !== null && /\b(?:npm|pnpm|yarn)\s+publish\b|\bnpx\b/i.test(content)) {
        add("automatic package publication command", configPath);
      }
    }

    const forbiddenPackPath = (file) => (
      /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc|\.dsh|\.playwright-cli|node_modules|__pycache__)(?:\/|$)/.test(file)
      || /(?:\.zstd|\.pyc|\.pyo|\.log|\.DS_Store)$/i.test(file)
    );
    for (const workspace of [
      { name: "dsh-memory", directory: "packages/dsh-memory", args: ["--workspace", "dsh-memory"] },
      { name: "dsh-memory-ui", directory: "packages/dsh-memory-ui", args: ["--workspace", "dsh-memory-ui"] },
      { name: "dsh-git-memory", directory: ".", args: [] },
    ]) {
      const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", ...workspace.args], {
        cwd: snapshot,
        encoding: "utf8",
      });
      if (result.status !== 0) {
        add("npm pack inspection failed", workspace.name);
        continue;
      }
      let packed;
      try {
        packed = JSON.parse(result.stdout);
      } catch {
        add("npm pack did not return JSON", workspace.name);
        continue;
      }
      const packedFiles = packed.flatMap((item) => item.files ?? []);
      if (!packedFiles.some((entry) => entry.path === "LICENSE")) {
        add("npm package is missing LICENSE", workspace.name);
      }
      const workspaceRoot = resolve(snapshot, workspace.directory);
      for (const entry of packedFiles) {
        const entryName = `${workspace.name}:${entry.path}`;
        if (forbiddenPackPath(entry.path)) add("forbidden npm package file", entryName);
        const packedPath = resolve(workspaceRoot, entry.path);
        if (!isInside(workspaceRoot, packedPath)) {
          add("npm package path escapes workspace", entryName);
          continue;
        }
        try {
          const stat = lstatSync(packedPath);
          if (stat.isSymbolicLink()) add("symbolic-link npm package file", entryName);
          else if (!stat.isFile()) add("non-file npm package file", entryName);
          else if (!isStrictUtf8Text(readFileSync(packedPath))) add("binary npm package file", entryName);
        } catch {
          add("npm package file is missing from index snapshot", entryName);
        }
      }
    }
  }
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true, maxRetries: 2 });
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`public tree check: ${finding.label}: ${finding.file}`);
  console.error("public tree check: FAILED");
  process.exit(1);
}

console.log(`public tree check: passed (${tracked.length} indexed and ${untracked.length} untracked candidates checked)`);
