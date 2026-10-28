/**
 * Edge-case coverage for the Claude Code OTel env provider
 * (`src/server/otel/claude-code-env.ts`) that `test/claude-code-otel-env.test.ts`
 * does not exercise: the `getReceiverStatus` throw path, every known
 * `normalizeUnavailableReason` branch, `warnOnce`'s no-diagnostics and
 * repeated-key dedup paths, the conflict-warning dedup across repeated calls,
 * and the exact `buildReadyDefaults` values.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ClaudeCodeOtelDiagnosticTag,
  ClaudeCodeOtelEnvVar,
  ClaudeCodeOtelReceiverState,
  createClaudeCodeShellEnvProvider,
} from "../src/server/otel/claude-code-env.js";

const TARGET_ENV_KEYS = Object.values(ClaudeCodeOtelEnvVar);

// Every reason string `normalizeUnavailableReason` recognizes and passes
// through unchanged — mirrors the private `ClaudeCodeOtelUnavailableReason`
// const object in the source, which is not exported.
const KNOWN_UNAVAILABLE_REASONS = [
  "otlp_receiver_not_started",
  "otlp_receiver_bind_failed",
  "otlp_receiver_stopped",
  "otlp_receiver_invalid_host",
  "invalid_receiver_status",
  "receiver_status_thrown",
];

const NOT_STARTED_REASON_PATTERN = /otlp_receiver_not_started/;
const STOPPED_REASON_PATTERN = /otlp_receiver_stopped/;

test("readReceiverStatus fails closed with receiver_status_thrown when getReceiverStatus throws", async () => {
  const warnings: Array<{ tag: string; message: string }> = [];
  const provider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => {
      throw new Error("boom");
    },
    diagnostics: {
      warn: (tag, message) => warnings.push({ tag, message }),
    },
    getBaseShellEnv: baseShellEnv,
  });

  const env = await provider({ EXISTING_EXTRA: "kept" });

  for (const key of TARGET_ENV_KEYS) {
    assert.equal(Object.hasOwn(env, key), false);
  }
  assert.equal(env.EXISTING_EXTRA, "kept");
  assert.deepEqual(warnings, [
    {
      tag: ClaudeCodeOtelDiagnosticTag,
      message:
        "Claude Code OTel env injection skipped: receiver unavailable (receiver_status_thrown)",
    },
  ]);
});

for (const reason of KNOWN_UNAVAILABLE_REASONS) {
  test(`normalizeUnavailableReason passes known reason "${reason}" through unchanged`, async () => {
    const warnings: Array<{ tag: string; message: string }> = [];
    const provider = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Unavailable,
        reason,
      }),
      diagnostics: {
        warn: (tag, message) => warnings.push({ tag, message }),
      },
      getBaseShellEnv: baseShellEnv,
    });

    await provider();

    assert.deepEqual(warnings, [
      {
        tag: ClaudeCodeOtelDiagnosticTag,
        message: `Claude Code OTel env injection skipped: receiver unavailable (${reason})`,
      },
    ]);
  });
}

test("normalizeUnavailableReason maps an unrecognized reason to invalid_receiver_status", async () => {
  const warnings: Array<{ tag: string; message: string }> = [];
  const provider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Unavailable,
      reason: "totally_unrecognized_reason",
    }),
    diagnostics: {
      warn: (tag, message) => warnings.push({ tag, message }),
    },
    getBaseShellEnv: baseShellEnv,
  });

  await provider();

  assert.deepEqual(warnings, [
    {
      tag: ClaudeCodeOtelDiagnosticTag,
      message:
        "Claude Code OTel env injection skipped: receiver unavailable (invalid_receiver_status)",
    },
  ]);
});

test("dedupes the conflict warning across repeated calls with the same conflicting keys", async () => {
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

  const first = await provider();
  const second = await provider();
  const third = await provider();

  for (const env of [first, second, third]) {
    for (const key of TARGET_ENV_KEYS) {
      assert.equal(env[key], `user-value-for-${key}`);
    }
  }
  assert.equal(warnings.length, 1);
});

test("warnOnce is a no-op when diagnostics is not provided (unavailable path)", async () => {
  const provider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Unavailable,
      reason: "otlp_receiver_not_started",
    }),
    getBaseShellEnv: baseShellEnv,
  });

  const env = await provider({ EXISTING_EXTRA: "kept" });

  for (const key of TARGET_ENV_KEYS) {
    assert.equal(Object.hasOwn(env, key), false);
  }
  assert.equal(env.EXISTING_EXTRA, "kept");
});

test("warnOnce is a no-op when diagnostics is not provided (conflict path)", async () => {
  const userEnv = Object.fromEntries(
    TARGET_ENV_KEYS.map((key) => [key, `user-value-for-${key}`])
  );
  const provider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 4318,
    }),
    getBaseShellEnv: async (extra) => baseShellEnv({ ...userEnv, ...extra }),
  });

  const env = await provider();

  for (const key of TARGET_ENV_KEYS) {
    assert.equal(env[key], `user-value-for-${key}`);
  }
});

test("warnOnce warns again for a new unavailable reason but not for a repeated one", async () => {
  const warnings: Array<{ tag: string; message: string }> = [];
  const reasons = [
    "otlp_receiver_not_started",
    "otlp_receiver_not_started",
    "otlp_receiver_stopped",
  ];
  let callIndex = 0;
  const provider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Unavailable,
      reason: reasons[Math.min(callIndex++, reasons.length - 1)],
    }),
    diagnostics: {
      warn: (tag, message) => warnings.push({ tag, message }),
    },
    getBaseShellEnv: baseShellEnv,
  });

  await provider();
  await provider();
  await provider();

  assert.equal(warnings.length, 2);
  assert.match(warnings[0]?.message ?? "", NOT_STARTED_REASON_PATTERN);
  assert.match(warnings[1]?.message ?? "", STOPPED_REASON_PATTERN);
});

test("buildReadyDefaults produces the exact five OTel env values for the given port", async () => {
  const provider = createClaudeCodeShellEnvProvider({
    getReceiverStatus: () => ({
      state: ClaudeCodeOtelReceiverState.Ready,
      host: "127.0.0.1",
      port: 65_432,
    }),
    getBaseShellEnv: baseShellEnv,
  });

  const env = await provider();

  const injected = Object.fromEntries(
    TARGET_ENV_KEYS.map((key) => [key, env[key]])
  );
  assert.deepEqual(injected, {
    [ClaudeCodeOtelEnvVar.EnableTelemetry]: "1",
    [ClaudeCodeOtelEnvVar.MetricsExporter]: "otlp",
    [ClaudeCodeOtelEnvVar.LogsExporter]: "otlp",
    [ClaudeCodeOtelEnvVar.OtlpProtocol]: "http/protobuf",
    [ClaudeCodeOtelEnvVar.OtlpEndpoint]: "http://127.0.0.1:65432",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.BASE_ENV, "present");
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
