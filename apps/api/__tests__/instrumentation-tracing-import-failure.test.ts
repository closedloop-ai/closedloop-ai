import { TracingDisabledReason } from "@repo/observability/tracing/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// apps/api register() — the tracing import is inside the fail-open boundary
// (ISS-4659).
//
// `initTracing()` catches its own bootstrap failures, but module resolution and
// evaluation happen before it is ever called. An unresolvable OTel dependency,
// or a throw at module scope, would reject `register()` — and Next awaits
// `register()`, so the API cold start would fail over a telemetry problem.
//
// Lives in its own file because the mock has to fail at module-evaluation time,
// which is module-scoped and would break every other case in the sibling suite.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  setPoolTelemetrySink: vi.fn(),
  setSchemaBootstrapHook: vi.fn(),
  emitDbPoolMetric: vi.fn(),
  assertRunnerSecretConfigured: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/origin", () => ({ ORIGIN: "api" }));

vi.mock("@repo/auth/runner-jwt-base", () => ({
  assertRunnerSecretConfigured: mocks.assertRunnerSecretConfigured,
  RUNNER_JWT_SECRET_ENV: "RUNNER_JWT_SECRET",
}));

vi.mock("@repo/database", () => ({
  setPoolTelemetrySink: mocks.setPoolTelemetrySink,
  setSchemaBootstrapHook: mocks.setSchemaBootstrapHook,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitDbPoolMetric: mocks.emitDbPoolMetric,
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: mocks.logInfo, warn: mocks.logWarn },
}));

// The failure under test: the tracing module cannot be evaluated at all.
vi.mock("@repo/observability/tracing/provider", () => {
  throw new Error("simulated OTel module evaluation failure");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("register() when the tracing module fails to load", () => {
  it("resolves instead of failing the cold start", async () => {
    const { register } = await import("../instrumentation");

    await expect(register()).resolves.toBeUndefined();
  });

  it("reports the failure so an operator can see tracing is off", async () => {
    const { register } = await import("../instrumentation");

    await register();

    expect(mocks.logWarn).toHaveBeenCalledWith("telemetry.tracing_disabled", {
      reason: TracingDisabledReason.InitFailed,
    });
  });

  it("still installs pool telemetry — a tracing failure must not cost the rest", async () => {
    const { register } = await import("../instrumentation");

    await register();

    expect(mocks.setPoolTelemetrySink).toHaveBeenCalledTimes(1);
    // ISS-5984: same reasoning for the preview-schema bootstrap. Tracing is
    // best-effort; the bootstrap is what makes a preview serve at all, so it
    // must not be collateral damage of a tracing import failure.
    expect(mocks.setSchemaBootstrapHook).toHaveBeenCalledTimes(1);
    expect(mocks.assertRunnerSecretConfigured).toHaveBeenCalledWith(
      "RUNNER_JWT_SECRET"
    );
  });
});
