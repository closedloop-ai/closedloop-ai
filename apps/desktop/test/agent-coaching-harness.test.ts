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
import type { CoachingHarnessResult } from "../src/main/agent-monitor/agent-coaching-harness.js";
import { generateCoachingTips } from "../src/main/agent-monitor/agent-coaching-harness.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  DEFAULT_OTLP_RECEIVER_PORT,
  OtlpReceiverUnavailableReason,
  setOtlpReceiverStateForProcess,
} from "../src/main/telemetry/otlp-receiver-state.js";
import { ClaudeCodeOtelEnvVar } from "../src/server/otel/claude-code-env.js";
import {
  _setKnownBinaryLocationsForResolverTest,
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { omitClaudeCodeOtelEnv } from "./helpers/ambient-otel-env.js";

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

    const result = await withFakeClaude(() =>
      generateCoachingTips("coaching prompt")
    );
    const payload = parsePayload(expectOk(result));

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

    const result = await withFakeClaude(() =>
      generateCoachingTips("coaching prompt")
    );
    const payload = parsePayload(expectOk(result));

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

        assert.equal(expectOk(first), expectOk(second));
        assert.equal(readFileSync(countFile, "utf8"), "spawn\n");
        assert.equal(parsePayload(expectOk(first)).input, "same prompt");
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

        assert.notEqual(expectOk(first), expectOk(second));
        assert.equal(readFileSync(countFile, "utf8"), "spawn\nspawn\n");
        assert.equal(parsePayload(expectOk(first)).input, "first prompt");
        assert.equal(parsePayload(expectOk(second)).input, "second prompt");
      },
      { COACHING_TEST_DELAY_MS: "25" }
    );
  });

  // Regression: a harness that produces NO output within the backstop window used
  // to reject with "claude exited with code 143" — an unhandled handler error at
  // the renderer. It must now resolve to a structured timeout instead of throwing.
  test("resolves to a structured timeout when the harness never outputs", async () => {
    // The backstop is read from process.env by the PARENT (main) process, not the
    // per-test shell-path context, so set it directly with cleanup. A tiny value
    // keeps the "never outputs" hang from waiting the real 5-minute default.
    const priorTimeout = process.env.CLOSEDLOOP_COACHING_HARNESS_TIMEOUT_MS;
    process.env.CLOSEDLOOP_COACHING_HARNESS_TIMEOUT_MS = "150";
    try {
      const result = await withFakeClaude(
        () => generateCoachingTips("hangs forever"),
        { COACHING_TEST_HANG: "1" }
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "timeout");
      }
    } finally {
      if (priorTimeout === undefined) {
        delete process.env.CLOSEDLOOP_COACHING_HARNESS_TIMEOUT_MS;
      } else {
        process.env.CLOSEDLOOP_COACHING_HARNESS_TIMEOUT_MS = priorTimeout;
      }
    }
  });

  // A harness that exits non-zero with no output (e.g. auth/model misconfig) must
  // also resolve to a structured failure, not reject.
  test("resolves to a structured failure on a non-zero exit", async () => {
    const result = await withFakeClaude(() => generateCoachingTips("boom"), {
      COACHING_TEST_EXIT_CODE: "3",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "nonzero_exit");
    }
  });

  // A missing binary (ENOENT) must surface as a structured spawn failure.
  test("resolves to a structured failure when the binary cannot be spawned", async () => {
    // Pinning PATH is not enough. The known-location tier (FEA-3742) probes
    // absolute paths like ~/.local/bin/claude with a raw access() check that
    // ignores the shell-path sandbox, so on a developer machine with claude
    // installed this test resolved the REAL binary and spawned a live headless
    // `claude -p "no binary"` — burning API tokens, creating a session the
    // importer ingests, and failing the assertion with nonzero_exit. CI, where
    // claude is absent, passed. Pin the tier empty so the outcome is the same
    // on both (test:node determinism, FEA-2399).
    _setKnownBinaryLocationsForResolverTest({ claude: [] });
    try {
      const result = await withShellPathEnvForTest(
        { ...process.env, PATH: "/nonexistent-bin-dir", SHELL: "/bin/sh" },
        () => {
          setShellPathForTest();
          return generateCoachingTips("no binary");
        }
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "spawn_failed");
      }
    } finally {
      _setKnownBinaryLocationsForResolverTest(null);
    }
  });
});

// Unwrap a successful harness result, throwing (not asserting) on failure so this
// stays a plain helper — the biome no-misplaced-assertion rule reserves assert.*
// for inside test() bodies.
function expectOk(result: CoachingHarnessResult): string {
  if (!result.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
  }
  return result.output;
}

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
      // ISS-5114: strip the ambient Claude Code OTel vars. Claude Code exports
      // CLAUDE_CODE_ENABLE_TELEMETRY=1 into the shell it spawns agents in, and
      // the provider deliberately PRESERVES a pre-existing user value — so on a
      // machine running Claude Code the "omits OTel env when the receiver is
      // unavailable" assertion saw the host's 1 and failed. Injecting a clean
      // env here establishes the precondition without touching process.env.
      ...omitClaudeCodeOtelEnv(process.env),
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
    // Simulate a harness that produces NO output at all (the real hang): keep
    // the process alive so the harness backstop must terminate it.
    '  if (process.env.COACHING_TEST_HANG === "1") {',
    "    setInterval(() => {}, 1000);",
    "    return;",
    "  }",
    // Simulate a non-zero exit with no output (e.g. auth/model error).
    '  const exitCode = Number(process.env.COACHING_TEST_EXIT_CODE ?? "0");',
    "  if (Number.isFinite(exitCode) && exitCode !== 0) {",
    "    process.exit(exitCode);",
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
