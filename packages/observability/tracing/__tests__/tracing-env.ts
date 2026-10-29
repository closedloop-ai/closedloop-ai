import { vi } from "vitest";
import { deleteEnvForTest } from "../../__tests__/test-helpers";

// Shared env setup for the tracing suites. A case that stubs only the three
// keys it cares about still inherits whatever the runner started with — hence
// the clear is part of the contract rather than the caller's job to remember.

/**
 * The six keys that decide `resolveTracingConfig`'s enabled/disabled outcome,
 * cleared so no ambient value leaks in.
 *
 * NOT every key it reads: `loadDatadogIdentity` also reads DD_SERVICE, DD_ENV
 * and NODE_ENV. Those only tint `config.service` and `config.env` on an
 * already-enabled result, so they are left alone here. A worker with
 * DD_SERVICE exported leaks straight into `config.service`: a suite that
 * asserts on either field clears all three itself, as
 * `config-identity.test.ts` does.
 */
export function clearTracingEnv(): void {
  deleteEnvForTest(
    "DD_TRACING_DISABLED",
    "DD_TRACING_ENABLED",
    "DD_API_KEY",
    "DD_OTLP_TRACES_ENDPOINT",
    "DD_TRACE_SAMPLE_RATE",
    "VERCEL"
  );
}

/** Clears the tracing env, then stubs the minimum that resolves to `enabled: true`. */
export function stubEnabledTracingEnv(): void {
  clearTracingEnv();
  vi.stubEnv("DD_TRACING_ENABLED", "1");
  vi.stubEnv("DD_API_KEY", "dd-test-key");
  vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", "https://otlp.example.test/v1/traces");
}
