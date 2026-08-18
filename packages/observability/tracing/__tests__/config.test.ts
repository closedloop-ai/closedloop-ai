import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest } from "../../__tests__/test-helpers";
import {
  resolveSampleRate,
  resolveTracingConfig,
  TracingDisabledReason,
} from "../config";

// ---------------------------------------------------------------------------
// tracing/config.ts — enable/disable precedence and sampling bounds (ISS-4659).
//
// The precedence tests each clear the higher-priority inputs they are not
// exercising, so an inherited local or CI value cannot satisfy an earlier
// branch and make the assertion pass for the wrong reason.
// ---------------------------------------------------------------------------

const ENDPOINT = "https://otlp.example.test/v1/traces";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Clear every input this module reads, so each test starts from a known floor. */
function clearTracingEnv(): void {
  deleteEnvForTest(
    "DD_TRACING_DISABLED",
    "DD_TRACING_ENABLED",
    "DD_API_KEY",
    "DD_OTLP_TRACES_ENDPOINT",
    "DD_TRACE_SAMPLE_RATE",
    "VERCEL"
  );
}

/** The fully-configured, deployed happy path. */
function stubEnabledEnv(): void {
  clearTracingEnv();
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("DD_API_KEY", "dd-test-key");
  vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", ENDPOINT);
}

describe("resolveTracingConfig — disabled precedence", () => {
  it("is disabled outside a deployed runtime even when fully configured", () => {
    clearTracingEnv();
    vi.stubEnv("DD_API_KEY", "dd-test-key");
    vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", ENDPOINT);

    const config = resolveTracingConfig();

    // This is the guard that stops CI test workers — which set DD_API_KEY for
    // dd-trace Test Optimization — from exporting spans.
    expect(config).toEqual({
      enabled: false,
      reason: TracingDisabledReason.NotDeployed,
    });
  });

  it("honours the kill switch ahead of every other signal", () => {
    stubEnabledEnv();
    vi.stubEnv("DD_TRACING_DISABLED", "1");

    expect(resolveTracingConfig()).toEqual({
      enabled: false,
      reason: TracingDisabledReason.ExplicitlyDisabled,
    });
  });

  it("reports a missing API key rather than exporting unauthenticated", () => {
    clearTracingEnv();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", ENDPOINT);

    expect(resolveTracingConfig()).toEqual({
      enabled: false,
      reason: TracingDisabledReason.MissingApiKey,
    });
  });

  it("stays off when no endpoint is configured instead of guessing one", () => {
    clearTracingEnv();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DD_API_KEY", "dd-test-key");

    // A guessed endpoint would not fail loudly — it would black-hole spans
    // while the service looked instrumented.
    expect(resolveTracingConfig()).toEqual({
      enabled: false,
      reason: TracingDisabledReason.MissingEndpoint,
    });
  });
});

describe("resolveTracingConfig — enabled", () => {
  it("resolves the full config on a deployed runtime", () => {
    stubEnabledEnv();
    vi.stubEnv("DD_SERVICE", "cl-api");
    vi.stubEnv("DD_ENV", "prod");

    const config = resolveTracingConfig();

    expect(config.enabled).toBe(true);
    if (!config.enabled) {
      throw new Error("expected tracing to be enabled");
    }
    expect(config.endpoint).toBe(ENDPOINT);
    expect(config.service).toBe("cl-api");
    expect(config.env).toBe("prod");
  });

  it("opts a non-Vercel runtime in explicitly", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACING_ENABLED", "true");
    vi.stubEnv("DD_API_KEY", "dd-test-key");
    vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", ENDPOINT);

    expect(resolveTracingConfig().enabled).toBe(true);
  });
});

describe("resolveSampleRate", () => {
  it("defaults conservatively when unset", () => {
    clearTracingEnv();

    expect(resolveSampleRate()).toBe(0.1);
  });

  it("honours a valid configured rate", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "0.25");

    expect(resolveSampleRate()).toBe(0.25);
  });

  it("clamps an above-range rate to 1 rather than over-billing", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "17");

    expect(resolveSampleRate()).toBe(1);
  });

  it("clamps a negative rate to 0", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "-3");

    expect(resolveSampleRate()).toBe(0);
  });

  it("falls back to the default on an unparseable rate", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "aggressive");

    // Not 0 (blind) and not 1 (unbounded bill) — a typo should be survivable.
    expect(resolveSampleRate()).toBe(0.1);
  });

  it("rejects a numeric prefix instead of reading it as a valid rate", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "1oops");

    // `parseFloat("1oops")` is 1 — a typo would silently switch the service to
    // 100% sampling, the opposite of the malformed-value fallback and an
    // expensive way to find out. The whole string has to parse.
    expect(resolveSampleRate()).toBe(0.1);
  });

  it("rejects trailing garbage after a fractional rate", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "0.5%");

    expect(resolveSampleRate()).toBe(0.1);
  });
});
