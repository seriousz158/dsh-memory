import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const syntheticAwsAccessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const querySecret = ["query", "secret"].join("-");
const nestedPassword = ["nested", "password"].join("-");
const homePath = ["", "Users", "example", "project"].join("/");
const syntheticSecrets = [
  syntheticSk,
  syntheticBearer,
  syntheticGitHubToken,
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
            text: `Keep benign-assistant-text; redact https://example.invalid/cb?token=${querySecret}.`,
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
          text: `${"x".repeat(1995)} sk-ordering-123`,
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

console.log("dsh-memory redaction test passed");
