import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { generateCoachingTips } from "../src/main/agent-coaching-harness.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  DEFAULT_OTLP_RECEIVER_PORT,
  OtlpReceiverUnavailableReason,
  setOtlpReceiverStateForProcess,
} from "../src/main/otlp-receiver-state.js";
import { ClaudeCodeOtelEnvVar } from "../src/server/otel/claude-code-env.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";

type FakeClaudePayload = {
  args: string[];
  env: Record<string, string | null>;
  input: string;
};

const TARGET_ENV_KEYS = Object.values(ClaudeCodeOtelEnvVar);

describe("agent coaching harness", () => {
  afterEach(() => {
    resetShellPathCache();
    setOtlpReceiverStateForProcess({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: DEFAULT_OTLP_RECEIVER_PORT,
      reason: OtlpReceiverUnavailableReason.NotStarted,
    });
  });

  test("injects live Claude Code OTel env into the local claude -p spawn", async () => {
    setOtlpReceiverStateForProcess({
      available: true,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 4318,
    });

    const output = await withFakeClaude(() =>
      generateCoachingTips("coaching prompt")
    );
    const payload = parsePayload(output);

    assert.deepEqual(payload.args, ["-p"]);
    assert.equal(payload.input, "coaching prompt");
    assert.equal(payload.env[ClaudeCodeOtelEnvVar.EnableTelemetry], "1");
    assert.equal(payload.env[ClaudeCodeOtelEnvVar.MetricsExporter], "otlp");
    assert.equal(payload.env[ClaudeCodeOtelEnvVar.LogsExporter], "otlp");
    assert.equal(
      payload.env[ClaudeCodeOtelEnvVar.OtlpProtocol],
      "http/protobuf"
    );
    assert.equal(
      payload.env[ClaudeCodeOtelEnvVar.OtlpEndpoint],
      "http://127.0.0.1:4318"
    );
  });

  test("omits OTel env when the receiver is unavailable", async () => {
    setOtlpReceiverStateForProcess({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: DEFAULT_OTLP_RECEIVER_PORT,
      reason: OtlpReceiverUnavailableReason.NotStarted,
    });

    const output = await withFakeClaude(() =>
      generateCoachingTips("coaching prompt")
    );
    const payload = parsePayload(output);

    for (const key of TARGET_ENV_KEYS) {
      assert.equal(payload.env[key], null);
    }
  });

  test("coalesces concurrent coaching generation for identical prompts", async () => {
    setOtlpReceiverStateForProcess({
      available: true,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 4318,
    });

    await withFakeClaude(
      async ({ countFile }) => {
        const [first, second] = await Promise.all([
          generateCoachingTips("same prompt"),
          generateCoachingTips("same prompt"),
        ]);

        assert.equal(first, second);
        assert.equal(readFileSync(countFile, "utf8"), "spawn\n");
        assert.equal(parsePayload(first).input, "same prompt");
      },
      { COACHING_TEST_DELAY_MS: "25" }
    );
  });

  test("does not coalesce concurrent coaching generation for different prompts", async () => {
    setOtlpReceiverStateForProcess({
      available: true,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 4318,
    });

    await withFakeClaude(
      async ({ countFile }) => {
        const [first, second] = await Promise.all([
          generateCoachingTips("first prompt"),
          generateCoachingTips("second prompt"),
        ]);

        assert.notEqual(first, second);
        assert.equal(readFileSync(countFile, "utf8"), "spawn\nspawn\n");
        assert.equal(parsePayload(first).input, "first prompt");
        assert.equal(parsePayload(second).input, "second prompt");
      },
      { COACHING_TEST_DELAY_MS: "25" }
    );
  });
});

function parsePayload(raw: string): FakeClaudePayload {
  return JSON.parse(raw) as FakeClaudePayload;
}

function withFakeClaude<T>(
  fn: (context: { countFile: string }) => T,
  extraEnv: Record<string, string> = {}
): T {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-coaching-harness-"));
  const binDir = path.join(tempDir, "bin");
  const countFile = path.join(tempDir, "count.txt");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "claude"), fakeClaudeScript());
  chmodSync(path.join(binDir, "claude"), 0o755);

  return withShellPathEnvForTest(
    {
      ...process.env,
      ...extraEnv,
      COACHING_TEST_COUNT_FILE: countFile,
      PATH: binDir,
      SHELL: "/bin/sh",
    },
    () => {
      setShellPathForTest();
      return fn({ countFile });
    }
  );
}

function fakeClaudeScript(): string {
  return [
    `#!${process.execPath}`,
    'const { appendFileSync } = require("node:fs");',
    `const targetEnvKeys = ${JSON.stringify(TARGET_ENV_KEYS)};`,
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  input += chunk;",
    "});",
    'process.stdin.on("end", () => {',
    "  const countFile = process.env.COACHING_TEST_COUNT_FILE;",
    "  if (countFile) {",
    '    appendFileSync(countFile, "spawn\\n");',
    "  }",
    "  const env = Object.fromEntries(",
    "    targetEnvKeys.map((key) => [key, process.env[key] ?? null])",
    "  );",
    '  const delayMs = Number(process.env.COACHING_TEST_DELAY_MS ?? "0");',
    "  setTimeout(() => {",
    "    process.stdout.write(",
    "      JSON.stringify({ args: process.argv.slice(2), env, input })",
    "    );",
    "  }, Number.isFinite(delayMs) ? delayMs : 0);",
    "});",
    "",
  ].join("\n");
}
