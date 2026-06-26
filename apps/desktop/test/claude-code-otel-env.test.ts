import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  DEFAULT_OTLP_RECEIVER_PORT,
  getOtlpReceiverState,
  type OtlpReceiverState,
  OtlpReceiverUnavailableReason,
  setOtlpReceiverStateForProcess,
  toClaudeCodeOtelReceiverStatus,
} from "../src/main/otlp-receiver-state.js";
import {
  ClaudeCodeOtelDiagnosticTag,
  ClaudeCodeOtelEnvVar,
  ClaudeCodeOtelReceiverState,
  createClaudeCodeShellEnvProvider,
} from "../src/server/otel/claude-code-env.js";

const TARGET_ENV_KEYS = Object.values(ClaudeCodeOtelEnvVar);

describe("createClaudeCodeShellEnvProvider", () => {
  test("injects Claude Code OTel env when receiver status is ready", async () => {
    const provider = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Ready,
        host: "127.0.0.1",
        port: 4318,
      }),
      getBaseShellEnv: baseShellEnv,
    });

    const env = await provider({ EXISTING_EXTRA: "kept" });

    assert.equal(env[ClaudeCodeOtelEnvVar.EnableTelemetry], "1");
    assert.equal(env[ClaudeCodeOtelEnvVar.MetricsExporter], "otlp");
    assert.equal(env[ClaudeCodeOtelEnvVar.LogsExporter], "otlp");
    assert.equal(env[ClaudeCodeOtelEnvVar.OtlpProtocol], "http/protobuf");
    assert.equal(
      env[ClaudeCodeOtelEnvVar.OtlpEndpoint],
      "http://127.0.0.1:4318"
    );
    assert.equal(env.EXISTING_EXTRA, "kept");
  });

  test("fails closed when receiver status is unavailable and warns once", async () => {
    const warnings: Array<{ tag: string; message: string }> = [];
    const provider = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Unavailable,
        reason: "otlp_receiver_not_started",
      }),
      diagnostics: {
        warn: (tag, message) => warnings.push({ tag, message }),
      },
      getBaseShellEnv: baseShellEnv,
    });

    const first = await provider({ EXISTING_EXTRA: "kept" });
    const second = await provider({ ANOTHER_EXTRA: "kept-too" });

    for (const key of TARGET_ENV_KEYS) {
      assert.equal(Object.hasOwn(first, key), false);
      assert.equal(Object.hasOwn(second, key), false);
    }
    assert.equal(first.EXISTING_EXTRA, "kept");
    assert.equal(second.ANOTHER_EXTRA, "kept-too");
    assert.deepEqual(warnings, [
      {
        tag: ClaudeCodeOtelDiagnosticTag,
        message:
          "Claude Code OTel env injection skipped: receiver unavailable (otlp_receiver_not_started)",
      },
    ]);
  });

  test("normalizes dynamic unavailable reasons before warning and deduping", async () => {
    const warnings: Array<{ tag: string; message: string }> = [];
    const rawReasons = [
      "bind failed on /tmp/otel-receiver-alpha with token abc123",
      "bind failed on /tmp/otel-receiver-beta with token def456",
    ];
    let reasonIndex = 0;
    const provider = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Unavailable,
        reason:
          rawReasons[Math.min(reasonIndex++, rawReasons.length - 1)] ??
          "bind failed fallback",
      }),
      diagnostics: {
        warn: (tag, message) => warnings.push({ tag, message }),
      },
      getBaseShellEnv: baseShellEnv,
    });

    const first = await provider();
    const second = await provider();

    for (const key of TARGET_ENV_KEYS) {
      assert.equal(Object.hasOwn(first, key), false);
      assert.equal(Object.hasOwn(second, key), false);
    }
    assert.deepEqual(warnings, [
      {
        tag: ClaudeCodeOtelDiagnosticTag,
        message:
          "Claude Code OTel env injection skipped: receiver unavailable (invalid_receiver_status)",
      },
    ]);
    for (const rawReason of rawReasons) {
      assert.equal(warnings[0]?.message.includes(rawReason), false);
    }
    assert.equal(warnings[0]?.message.includes("/tmp/otel-receiver"), false);
    assert.equal(warnings[0]?.message.includes("abc123"), false);
    assert.equal(warnings[0]?.message.includes("def456"), false);
  });

  test("preserves user values for every target key and warns without values", async () => {
    const warnings: Array<{ tag: string; message: string }> = [];
    const userEnv = Object.fromEntries(
      TARGET_ENV_KEYS.map((key) => [key, `user-value-for-${key}`])
    );
    const provider = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Ready,
        host: "127.0.0.1",
        port: 4318,
      }),
      diagnostics: {
        warn: (tag, message) => warnings.push({ tag, message }),
      },
      getBaseShellEnv: async (extra) => baseShellEnv({ ...userEnv, ...extra }),
    });

    const env = await provider({
      [ClaudeCodeOtelEnvVar.OtlpEndpoint]: "http://user.example:9999",
    });

    for (const key of TARGET_ENV_KEYS) {
      if (key === ClaudeCodeOtelEnvVar.OtlpEndpoint) {
        assert.equal(env[key], "http://user.example:9999");
      } else {
        assert.equal(env[key], `user-value-for-${key}`);
      }
    }
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.tag, ClaudeCodeOtelDiagnosticTag);
    for (const key of TARGET_ENV_KEYS) {
      assert.match(warnings[0]?.message ?? "", new RegExp(key));
      assert.equal(
        warnings[0]?.message.includes(`user-value-for-${key}`),
        false
      );
    }
    assert.equal(warnings[0]?.message.includes("user.example"), false);
  });

  test("injects only exact target keys and ignores similar env names", async () => {
    const provider = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Ready,
        host: "127.0.0.1",
        port: 4318,
      }),
      getBaseShellEnv: async (extra) =>
        baseShellEnv({
          CLAUDE_ENABLE_TELEMETRY: "user",
          OTEL_EXPORTER_OTLP_URL: "http://user.example:9999",
          ...extra,
        }),
    });

    const env = await provider();

    assert.equal(env.CLAUDE_ENABLE_TELEMETRY, "user");
    assert.equal(env.OTEL_EXPORTER_OTLP_URL, "http://user.example:9999");
    assert.equal(env[ClaudeCodeOtelEnvVar.EnableTelemetry], "1");
    assert.equal(
      env[ClaudeCodeOtelEnvVar.OtlpEndpoint],
      "http://127.0.0.1:4318"
    );
  });

  test("fails closed for non-loopback or invalid ready status", async () => {
    const warnings: Array<{ tag: string; message: string }> = [];
    const provider = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Ready,
        host: "localhost",
        port: 4318,
      }),
      diagnostics: {
        warn: (tag, message) => warnings.push({ tag, message }),
      },
      getBaseShellEnv: baseShellEnv,
    });

    const env = await provider();

    for (const key of TARGET_ENV_KEYS) {
      assert.equal(Object.hasOwn(env, key), false);
    }
    assert.deepEqual(warnings, [
      {
        tag: ClaudeCodeOtelDiagnosticTag,
        message:
          "Claude Code OTel env injection skipped: receiver unavailable (invalid_receiver_status)",
      },
    ]);
  });
});

function baseShellEnv(
  extra?: Record<string, string>
): Promise<Record<string, string>> {
  return Promise.resolve({
    PATH: "/usr/bin",
    BASE_ENV: "present",
    ...extra,
  });
}

describe("OtlpReceiverState adapter", () => {
  test("defaults to unavailable until the receiver starts", () => {
    setOtlpReceiverStateForProcess({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: DEFAULT_OTLP_RECEIVER_PORT,
      reason: OtlpReceiverUnavailableReason.NotStarted,
    });

    assert.deepEqual(getOtlpReceiverState(), {
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: DEFAULT_OTLP_RECEIVER_PORT,
      reason: OtlpReceiverUnavailableReason.NotStarted,
    });
  });

  test("adapts ready state to Claude Code's strict 127.0.0.1 contract", () => {
    const state = setOtlpReceiverStateForProcess({
      available: true,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 4318,
    });

    assert.deepEqual(toClaudeCodeOtelReceiverStatus(state), {
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    });
  });

  test("preserves stopped and bind-failed unavailable reasons", () => {
    const stopped = setOtlpReceiverStateForProcess({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 4318,
      reason: OtlpReceiverUnavailableReason.Stopped,
    });
    const bindFailed = setOtlpReceiverStateForProcess({
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: 4318,
      reason: OtlpReceiverUnavailableReason.BindFailed,
    });

    assert.deepEqual(toClaudeCodeOtelReceiverStatus(stopped), {
      state: ClaudeCodeOtelReceiverState.Unavailable,
      reason: OtlpReceiverUnavailableReason.Stopped,
    });
    assert.deepEqual(toClaudeCodeOtelReceiverStatus(bindFailed), {
      state: ClaudeCodeOtelReceiverState.Unavailable,
      reason: OtlpReceiverUnavailableReason.BindFailed,
    });
  });

  test("invalid process state is normalized fail-closed", () => {
    const invalidState = {
      available: true,
      host: "localhost",
      port: 4318,
    } as unknown as OtlpReceiverState;

    assert.deepEqual(setOtlpReceiverStateForProcess(invalidState), {
      available: false,
      host: DEFAULT_OTLP_RECEIVER_HOST,
      port: DEFAULT_OTLP_RECEIVER_PORT,
      reason: OtlpReceiverUnavailableReason.InvalidState,
    });
  });
});
