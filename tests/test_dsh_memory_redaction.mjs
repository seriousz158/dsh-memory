import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const filterScript = join(
  projectDir,
  "packages",
  "dsh-memory",
  "templates",
  "scripts",
  "filter_session.py",
);

const syntheticSk = ["sk", "test-123"].join("-");
const syntheticBearer = ["Bearer", "abc"].join(" ");
const syntheticGitHubToken = ["ghp", "abcdef0123456789abcdef0123456789abcdef"].join("_");
const syntheticFineGrainedGitHubToken = [
  "github",
  "pat",
  "11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ",
].join("_");
const syntheticAwsAccessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const querySecret = ["query", "secret"].join("-");
const nestedPassword = ["nested", "password"].join("-");
const orderingSk = ["sk", "ordering-123"].join("-");
const homePath = ["", "Users", "example", "project"].join("/");
const syntheticSecrets = [
  syntheticSk,
  syntheticBearer,
  syntheticGitHubToken,
  syntheticFineGrainedGitHubToken,
  syntheticAwsAccessKey,
  querySecret,
  nestedPassword,
  homePath,
];

const events = [
  {
    type: "session",
    id: "synthetic-session",
    cwd: homePath,
    agentPreset: "test",
  },
  { type: "turn/start", data: { turn: 1 } },
  {
    type: "user/message",
    data: {
      content: [
        {
          type: "text",
          text: `Keep benign-user-text; redact ${syntheticSk} and ${syntheticBearer}.`,
        },
      ],
    },
  },
  {
    type: "assistant/message",
    data: {
      message: {
        content: [
          {
            type: "text",
            text: `Keep benign-assistant-text; redact ${syntheticFineGrainedGitHubToken} and https://example.invalid/cb?token=${querySecret}.`,
          },
        ],
      },
    },
  },
  {
    type: "tool/call",
    data: {
      name: "synthetic_tool",
      arguments: JSON.stringify({
        note: syntheticGitHubToken,
        nested: {
          password: nestedPassword,
          path: `${homePath}/tool`,
        },
      }),
    },
  },
  {
    type: "tool/result",
    data: {
      message: {
        content: [
          {
            content: [
              {
                type: "text",
            text: `Keep benign-result-text; redact ${syntheticAwsAccessKey}.`,
              },
            ],
          },
        ],
      },
    },
  },
  { type: "turn/start", data: { turn: 2 } },
  {
    type: "user/message",
    data: {
      content: [
        {
          type: "text",
          // If truncation happened first, the visible prefix would end in
          // "sk-o" and no longer match the full key-shape redactor.
          text: `${"x".repeat(1995)} ${orderingSk}`,
        },
      ],
    },
  },
];

const input = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
const result = spawnSync("python3", [filterScript, "-"], {
  encoding: "utf8",
  input,
});

assert.equal(result.status, 0, result.stderr || "filter_session.py failed");
for (const secret of syntheticSecrets) {
  assert.equal(
    result.stdout.includes(secret),
    false,
    `synthetic secret leaked into transcript: ${secret}`,
  );
}

for (const benign of [
  "benign-user-text",
  "benign-assistant-text",
  "benign-result-text",
]) {
  assert.ok(result.stdout.includes(benign), `expected benign text missing: ${benign}`);
}

assert.ok(result.stdout.includes("[REDACTED]"), "redaction marker missing");
assert.ok(result.stdout.includes("$HOME"), "home path was not normalized");
assert.equal(result.stdout.includes("sk-"), false, "redaction must run before truncation");

const tempRoot = await mkdtemp(join(tmpdir(), "dsh-memory-filter-zstd."));
try {
  const plainPath = join(tempRoot, "plain.jsonl.zstd");
  const magicPath = join(tempRoot, "invalid.jsonl.zstd");
  const compressedPath = join(tempRoot, "compressed.jsonl.zstd");
  const missingZstd = join(tempRoot, "missing-zstd");
  await writeFile(plainPath, input);
  await writeFile(magicPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]));

  const plainFile = spawnSync("python3", [filterScript, plainPath], {
    encoding: "utf8",
    env: { ...process.env, DPSK_ZSTD: missingZstd },
  });
  assert.equal(plainFile.status, 0, plainFile.stderr || "plain JSONL file was rejected");
  assert.ok(plainFile.stdout.includes("benign-user-text"));

  const missingBinary = spawnSync("python3", [filterScript, magicPath], {
    encoding: "utf8",
    env: { ...process.env, DPSK_ZSTD: missingZstd },
  });
  assert.notEqual(missingBinary.status, 0, "zstd magic input unexpectedly succeeded");
  assert.match(missingBinary.stderr, /zstd-unavailable/);

  const zstdCandidates = [
    process.env.DPSK_ZSTD,
    "/opt/homebrew/bin/zstd",
    "/usr/local/bin/zstd",
  ].filter(Boolean);
  let zstdPath = null;
  for (const candidate of zstdCandidates) {
    try {
      await access(candidate, constants.X_OK);
      zstdPath = candidate;
      break;
    } catch {
      // Try the next platform-specific location.
    }
  }
  if (zstdPath) {
    const compressed = spawnSync(zstdPath, ["-q", "-f", "-o", compressedPath, plainPath], {
      encoding: "utf8",
    });
    assert.equal(compressed.status, 0, compressed.stderr || "zstd fixture creation failed");
    const decoded = spawnSync("python3", [filterScript, compressedPath], {
      encoding: "utf8",
      env: { ...process.env, DPSK_ZSTD: zstdPath },
    });
    assert.equal(decoded.status, 0, decoded.stderr || "zstd input was not decoded");
    assert.ok(decoded.stdout.includes("benign-user-text"));
  } else {
    console.log("dsh-memory zstd integration fixture skipped: no executable zstd found");
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("dsh-memory redaction test passed");
