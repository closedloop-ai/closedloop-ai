/**
 * ISS-5114 — hermetic control of the Claude Code OTel env vars.
 *
 * `createClaudeCodeShellEnvProvider` deliberately PRESERVES a user's existing
 * value for any of the five OTel keys instead of overwriting it. That is the
 * right production behavior, and it is exactly what couples a test to its host:
 * Claude Code exports `CLAUDE_CODE_ENABLE_TELEMETRY=1` into the shell it spawns
 * agents in, so on any machine running Claude Code the provider's base env
 * already carries the key, and a test asserting "no OTel env was injected" fails
 * — indistinguishably from a real regression, and only for the developer, never
 * in CI.
 *
 * A test asserting on the ABSENCE (or on the exact injected value) of these keys
 * must therefore establish that precondition itself. Call this once at file
 * scope and restore in `afterEach`/at the end of the run.
 *
 * Restoration is value-based rather than descriptor-based on purpose:
 * `process.env` entries are always plain writable/enumerable/configurable string
 * properties, so the value (or its absence) IS the whole prior state. Per the
 * repo rule, a variable that was originally unset is removed with
 * `Reflect.deleteProperty` — assigning `undefined` would store the STRING
 * "undefined" and leave the host dirtier than it started.
 */
import { ClaudeCodeOtelEnvVar } from "../../src/server/otel/claude-code-env.js";

export const CLAUDE_CODE_OTEL_ENV_KEYS: readonly string[] =
  Object.values(ClaudeCodeOtelEnvVar);

/** The values the provider injects once the OTLP receiver reports ready. */
export const READY_CLAUDE_CODE_OTEL_ENV: Readonly<Record<string, string>> = {
  [ClaudeCodeOtelEnvVar.EnableTelemetry]: "1",
  [ClaudeCodeOtelEnvVar.MetricsExporter]: "otlp",
  [ClaudeCodeOtelEnvVar.LogsExporter]: "otlp",
  [ClaudeCodeOtelEnvVar.OtlpProtocol]: "http/protobuf",
  [ClaudeCodeOtelEnvVar.OtlpEndpoint]: "http://127.0.0.1:4318",
};

/**
 * Remove every Claude Code OTel env var from `process.env` and return a
 * restore function that puts the exact prior state back (including removing a
 * key that was originally unset). Safe to call when none of them are set.
 */
export function stripAmbientClaudeCodeOtelEnv(): () => void {
  const priorValues = new Map<string, string | undefined>();
  for (const key of CLAUDE_CODE_OTEL_ENV_KEYS) {
    priorValues.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }

  return () => {
    for (const [key, priorValue] of priorValues) {
      if (priorValue === undefined) {
        Reflect.deleteProperty(process.env, key);
        continue;
      }
      process.env[key] = priorValue;
    }
  };
}

/**
 * A copy of `env` with every Claude Code OTel env var removed.
 *
 * Preferred over `stripAmbientClaudeCodeOtelEnv` whenever the test already
 * INJECTS the env the code under test will read — e.g. via
 * `withShellPathEnvForTest` — because it controls the precondition without
 * mutating process-wide state at all.
 */
export function omitClaudeCodeOtelEnv(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of CLAUDE_CODE_OTEL_ENV_KEYS) {
    Reflect.deleteProperty(copy, key);
  }
  return copy;
}

/**
 * Establish, for an entire test FILE, that no Claude Code OTel env var is
 * present, and hand the exact prior state back when the file finishes.
 *
 * Use this in files whose code under test reads the REAL `process.env` — i.e.
 * no `withShellPathEnvForTest` context is active — where the coupling is
 * otherwise invisible until someone runs the suite from inside Claude Code.
 *
 * @param registerAfter node:test's `after` hook, passed in so this module does
 *   not import the runner and can stay usable from any harness.
 */
export function installHermeticClaudeCodeOtelEnv(
  registerAfter: (fn: () => void) => void
): void {
  const restore = stripAmbientClaudeCodeOtelEnv();
  registerAfter(restore);
}
