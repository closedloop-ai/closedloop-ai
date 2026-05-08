import { afterEach, describe, expect, it, vi } from "vitest";
import { Origin } from "../telemetry/origin";

// ---------------------------------------------------------------------------
// ORIGIN — module-load-time resolution from DD_SERVICE
// ---------------------------------------------------------------------------
//
// Origin is a pure const object safe to import statically; ORIGIN requires
// dynamic re-import after vi.resetModules() so each test gets a fresh
// module evaluation with the stubbed env.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ORIGIN — known DD_SERVICE values", () => {
  it("resolves to Origin.Desktop when DD_SERVICE=desktop", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "desktop");
    const mod = await import("../telemetry/origin");
    expect(mod.ORIGIN).toBe(Origin.Desktop);
  });

  it("resolves to Origin.Api when DD_SERVICE=api", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "api");
    const mod = await import("../telemetry/origin");
    expect(mod.ORIGIN).toBe(Origin.Api);
  });

  it("resolves to Origin.Relay when DD_SERVICE=relay", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "relay");
    const mod = await import("../telemetry/origin");
    expect(mod.ORIGIN).toBe(Origin.Relay);
  });
});

describe("ORIGIN — fallback to Unknown with console.warn", () => {
  it("resolves to Origin.Unknown and warns when DD_SERVICE is unset", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", undefined as unknown as string);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../telemetry/origin");

    expect(mod.ORIGIN).toBe(Origin.Unknown);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg: unknown = warnSpy.mock.calls[0][0];
    expect(String(firstArg)).toContain("telemetry.origin_fallback");
  });

  it("resolves to Origin.Unknown and warns when DD_SERVICE is an off-whitelist value", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "bogus");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../telemetry/origin");

    expect(mod.ORIGIN).toBe(Origin.Unknown);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg: unknown = warnSpy.mock.calls[0][0];
    expect(String(firstArg)).toContain("telemetry.origin_fallback");
  });
});

describe("ORIGIN — cl-* prefixed DD_SERVICE happy paths", () => {
  it.each([
    ["cl-api", Origin.Api],
    ["cl-relay", Origin.Relay],
    ["cl-desktop", Origin.Desktop],
  ] as [
    string,
    Origin,
  ][])("resolves %s to %s without warning", async (ddServiceValue, expected) => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", ddServiceValue);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../telemetry/origin");

    expect(mod.ORIGIN).toBe(expected);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("ORIGIN — cl-* prefixed DD_SERVICE fallback/edge cases", () => {
  it("resolves cl-bogus to Origin.Unknown and warns", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "cl-bogus");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../telemetry/origin");

    expect(mod.ORIGIN).toBe(Origin.Unknown);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg: unknown = warnSpy.mock.calls[0][0];
    expect(String(firstArg)).toContain("telemetry.origin_fallback");
  });

  it("resolves cl- (empty suffix) to Origin.Unknown and warns", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "cl-");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../telemetry/origin");

    expect(mod.ORIGIN).toBe(Origin.Unknown);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg: unknown = warnSpy.mock.calls[0][0];
    expect(String(firstArg)).toContain("telemetry.origin_fallback");
  });

  it("resolves cl-cl-api to Origin.Unknown and warns", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "cl-cl-api");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../telemetry/origin");

    expect(mod.ORIGIN).toBe(Origin.Unknown);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg: unknown = warnSpy.mock.calls[0][0];
    expect(String(firstArg)).toContain("telemetry.origin_fallback");
  });

  // Cross-PR composition guard: PLN-384's "cl-unknown" sentinel must NOT
  // promote to a known origin via prefix-stripping. "unknown" is filtered
  // out of KNOWN_ORIGINS (origin.ts:21), so it correctly falls through.
  it("resolves cl-unknown to Origin.Unknown and warns", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "cl-unknown");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../telemetry/origin");

    expect(mod.ORIGIN).toBe(Origin.Unknown);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstArg: unknown = warnSpy.mock.calls[0][0];
    expect(String(firstArg)).toContain("telemetry.origin_fallback");
  });
});

describe("ORIGIN — immutability after module load", () => {
  it("does not change when process.env.DD_SERVICE is mutated after import", async () => {
    vi.resetModules();
    vi.stubEnv("DD_SERVICE", "api");
    const mod = await import("../telemetry/origin");
    const capturedOrigin = mod.ORIGIN;

    // Mutate the env after the module has already been evaluated
    vi.stubEnv("DD_SERVICE", "desktop");

    // ORIGIN is a module-level const — mutation after load must have no effect
    expect(mod.ORIGIN).toBe(capturedOrigin);
    expect(mod.ORIGIN).toBe(Origin.Api);
  });
});
