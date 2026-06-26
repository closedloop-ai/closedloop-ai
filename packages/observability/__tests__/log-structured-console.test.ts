import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryCategory } from "../telemetry/schema";
import { deleteEnvForTest } from "./test-helpers";

// ---------------------------------------------------------------------------
// log.ts — structured-JSON console sink (deployed-runtime facet extraction).
//
// In deployed runtimes the platform log drain (Vercel → Datadog) only sees the
// console line. The unstructured form `console.info(msg, obj)` collapses meta
// into an inspected blob, so fields like `category` / `diagnostics.*` never
// become Datadog facets. STRUCTURED_CONSOLE emits a single JSON line instead so
// the drain parses meta into first-class attributes — independent of the
// agentless DD_API_KEY intake path.
//
// Each test resets the module so module-level STRUCTURED_CONSOLE re-evaluates
// against the stubbed env.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importLogStructured(): Promise<typeof import("../log").log> {
  // No DD_API_KEY → the agentless intake path stays off; this suite only
  // exercises the console sink.
  deleteEnvForTest("DD_API_KEY");
  vi.resetModules();
  const mod = await import("../log");
  return mod.log;
}

describe("structured console — DD_LOGS_JSON=1 emits a single parseable JSON line", () => {
  it("flattens pricing-miss meta into top-level JSON keys (the fields a monitor facets on)", async () => {
    vi.stubEnv("DD_LOGS_JSON", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = await importLogStructured();
    infoSpy.mockClear();

    log.info("Desktop telemetry event received", {
      category: TelemetryCategory.TokenCostPricingMiss,
      severity: "warn",
      diagnostics: {
        tokenCostPricingMiss: {
          model: "gpt-5.4",
          reason: "no_match",
          surface: "branch_projection",
        },
      },
      origin: "desktop",
    });

    // Single string arg — not (message, object). This is what makes Datadog's
    // Vercel drain JSON-parse the line into attributes.
    expect(infoSpy).toHaveBeenCalledOnce();
    const callArgs = infoSpy.mock.calls[0];
    expect(callArgs).toHaveLength(1);
    expect(typeof callArgs[0]).toBe("string");

    const parsed = JSON.parse(callArgs[0] as string);
    expect(parsed.message).toBe("Desktop telemetry event received");
    expect(parsed.level).toBe("info");
    expect(parsed.category).toBe(TelemetryCategory.TokenCostPricingMiss);
    expect(parsed.severity).toBe("warn");
    // The model/reason/surface a group-by-model monitor and alert message read:
    expect(parsed.diagnostics.tokenCostPricingMiss.model).toBe("gpt-5.4");
    expect(parsed.diagnostics.tokenCostPricingMiss.reason).toBe("no_match");
    expect(parsed.diagnostics.tokenCostPricingMiss.surface).toBe(
      "branch_projection"
    );
  });

  it("message and level are authoritative even if meta carries colliding keys", async () => {
    vi.stubEnv("DD_LOGS_JSON", "1");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const log = await importLogStructured();
    warnSpy.mockClear();

    log.warn("real message", { message: "spoofed", level: "debug", a: 1 });

    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.message).toBe("real message");
    expect(parsed.level).toBe("warn");
    expect(parsed.a).toBe(1);
  });
});

describe("readable console — default (no VERCEL, no DD_LOGS_JSON)", () => {
  it("keeps the human-readable (message, object) form locally", async () => {
    deleteEnvForTest("VERCEL", "DD_LOGS_JSON");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = await importLogStructured();
    infoSpy.mockClear();

    const meta = { category: TelemetryCategory.TokenCostPricingMiss };
    log.info("Desktop telemetry event received", meta);

    expect(infoSpy).toHaveBeenCalledOnce();
    const callArgs = infoSpy.mock.calls[0];
    expect(callArgs).toHaveLength(2);
    expect(callArgs[0]).toBe("Desktop telemetry event received");
    expect(callArgs[1]).toBe(meta);
  });
});

describe("DD_LOGS_JSON=1 auto-on override of VERCEL absence; =0 forces off", () => {
  it("DD_LOGS_JSON=0 keeps readable form even when VERCEL is set", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DD_LOGS_JSON", "0");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = await importLogStructured();
    infoSpy.mockClear();

    log.info("msg", { k: "v" });

    expect(infoSpy.mock.calls[0]).toHaveLength(2);
  });

  it("VERCEL set (no DD_LOGS_JSON) auto-enables structured JSON", async () => {
    deleteEnvForTest("DD_LOGS_JSON");
    vi.stubEnv("VERCEL", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = await importLogStructured();
    infoSpy.mockClear();

    log.info("msg", { k: "v" });

    expect(infoSpy.mock.calls[0]).toHaveLength(1);
    expect(JSON.parse(infoSpy.mock.calls[0][0] as string).k).toBe("v");
  });
});

describe("structured console preserves Error instances in meta", () => {
  it("serializes Error meta to { name, message, stack } instead of {}", async () => {
    vi.stubEnv("DD_LOGS_JSON", "1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = await importLogStructured();
    errSpy.mockClear();

    log.error("sync failed", { error: new TypeError("boom") });

    const parsed = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(parsed.error.name).toBe("TypeError");
    expect(parsed.error.message).toBe("boom");
    expect(typeof parsed.error.stack).toBe("string");
    expect(parsed.error.stack.length).toBeGreaterThan(0);
  });
});

describe("structured console never throws on non-serializable meta", () => {
  it("falls back to the readable form when JSON.stringify throws (circular meta)", async () => {
    vi.stubEnv("DD_LOGS_JSON", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const log = await importLogStructured();
    infoSpy.mockClear();

    const circular: Record<string, unknown> = { k: "v" };
    circular.self = circular;

    expect(() => log.info("circular", circular)).not.toThrow();
    // Fallback path → (message, object), not a JSON string.
    const callArgs = infoSpy.mock.calls[0];
    expect(callArgs).toHaveLength(2);
    expect(callArgs[0]).toBe("circular");
  });
});
