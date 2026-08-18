import { vi } from "vitest";

/**
 * Turn the agentless Datadog log exporter ON for a test that asserts on the
 * flush path.
 *
 * CI sets DD_LOGS_DISABLED=1 on every instrumented test lane (ISS-4399): those
 * lanes set DD_API_KEY to feed dd-trace's Test Optimization reporter, and
 * packages/observability/log.ts opens its intake sink on that same key, so
 * without the flag the code under test would ship its log calls to Datadog as
 * if they were production traffic. Tests that exist to exercise the exporter
 * are the deliberate exception and clear it here.
 *
 * "" is not a disable value (log.ts accepts only "1"/"true"), and stubEnv keeps
 * both vars scoped to the test so vi.unstubAllEnvs() restores them.
 */
export function stubLogExporterEnv(): void {
  vi.stubEnv("DD_API_KEY", "test-key");
  vi.stubEnv("DD_LOGS_DISABLED", "");
}
