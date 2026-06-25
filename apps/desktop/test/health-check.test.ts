import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  _runDefaultCommandForTesting,
  _runDefaultPluginUpdateCommandForTesting,
} from "../src/server/operations/health-check.js";
import {
  ClaudeCodeOtelEnvVar,
  ClaudeCodeOtelReceiverState,
  createClaudeCodeShellEnvProvider,
} from "../src/server/otel/claude-code-env.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";

const TARGET_ENV_KEYS = Object.values(ClaudeCodeOtelEnvVar);
const MISSING_ENV_VALUE = "__missing__";
const tempDirs: string[] = [];

afterEach(async () => {
  resetShellPathCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("health-check Claude probe env", () => {
  test("claude --version stays on plain shell env", async () => {
    const { capture, readyEnv } = await runCapturedClaudeCommand(
      async (fakeClaude) => {
        await _runDefaultCommandForTesting(fakeClaude, ["--version"]);
      }
    );

    assert.deepEqual(missingReadyInjectedKeys(readyEnv), []);
    assert.equal(capture.ARGS, "--version");
    assert.deepEqual(leakedOtelEnvKeys(capture), []);
  });

  test("claude plugin list stays on plain shell env", async () => {
    const { capture, readyEnv } = await runCapturedClaudeCommand(
      async (fakeClaude) => {
        await _runDefaultCommandForTesting(fakeClaude, [
          "plugin",
          "list",
          "--json",
        ]);
      }
    );

    assert.deepEqual(missingReadyInjectedKeys(readyEnv), []);
    assert.equal(capture.ARGS, "plugin list --json");
    assert.deepEqual(leakedOtelEnvKeys(capture), []);
  });

  test("claude plugin update stays on plain shell env", async () => {
    const { capture, readyEnv } = await runCapturedClaudeCommand(
      async (fakeClaude) => {
        await _runDefaultPluginUpdateCommandForTesting("code@closedloop-ai", {
          claudeOverride: fakeClaude,
        });
      }
    );

    assert.deepEqual(missingReadyInjectedKeys(readyEnv), []);
    assert.equal(capture.ARGS, "plugin update code@closedloop-ai --scope user");
    assert.deepEqual(leakedOtelEnvKeys(capture), []);
  });
});

async function runCapturedClaudeCommand(
  runner: (fakeClaude: string) => Promise<void>
): Promise<{
  capture: Record<string, string>;
  readyEnv: Record<string, string>;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "health-otel-env-"));
  tempDirs.push(tempDir);
  const fakeClaude = path.join(tempDir, "claude");
  const capturePath = path.join(tempDir, "env.txt");
  await writeFakeClaude(fakeClaude);
  const readyProvider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    }),
    getBaseShellEnv: async () => ({ PATH: tempDir }),
  });
  const readyEnv = await readyProvider();

  await withShellPathEnvForTest(
    {
      PATH: tempDir,
      SHELL: "/bin/sh",
      HOME: tempDir,
      CAPTURE_FILE: capturePath,
    },
    async () => {
      setShellPathForTest();
      await runner(fakeClaude);
    }
  );

  const rawCapture = await readFile(capturePath, "utf-8");
  const capture = Object.fromEntries(
    rawCapture
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
  return { capture, readyEnv };
}

async function writeFakeClaude(fakeClaude: string): Promise<void> {
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "print_capture() {",
      "  value=$(printenv \"$1\" || printf '__missing__')",
      '  printf \'%s=%s\\n\' "$1" "$value"',
      "}",
      "{",
      "  printf 'ARGS=%s\\n' \"$*\"",
      "  print_capture CLAUDE_CODE_ENABLE_TELEMETRY",
      "  print_capture OTEL_METRICS_EXPORTER",
      "  print_capture OTEL_LOGS_EXPORTER",
      "  print_capture OTEL_EXPORTER_OTLP_PROTOCOL",
      "  print_capture OTEL_EXPORTER_OTLP_ENDPOINT",
      '} >> "$CAPTURE_FILE"',
      'if [ "$1" = "--version" ]; then',
      "  printf 'claude 1.0.0\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
      "  printf '[]\\n'",
      "  exit 0",
      "fi",
      'if [ "$1" = "plugin" ] && [ "$2" = "update" ]; then',
      "  printf 'updated\\n'",
      "  exit 0",
      "fi",
      "printf 'ok\\n'",
      "",
    ].join("\n")
  );
  await chmod(fakeClaude, 0o755);
}

function leakedOtelEnvKeys(capture: Record<string, string>): string[] {
  return TARGET_ENV_KEYS.filter((key) => capture[key] !== MISSING_ENV_VALUE);
}

function missingReadyInjectedKeys(env: Record<string, string>): string[] {
  return [
    env[ClaudeCodeOtelEnvVar.EnableTelemetry] === "1"
      ? ""
      : ClaudeCodeOtelEnvVar.EnableTelemetry,
    env[ClaudeCodeOtelEnvVar.OtlpEndpoint] === "http://127.0.0.1:4318"
      ? ""
      : ClaudeCodeOtelEnvVar.OtlpEndpoint,
  ].filter(Boolean);
}
