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

// ---------------------------------------------------------------------------
// Redaction at the REAL sink. `redact.test.ts` proves `redactLogValue` scrubs a
// token; it does not prove the logger ever calls it. `jsonReplacer` unwraps
// `Error` instances BEFORE redacting and relies on JSON.stringify re-visiting
// the expanded object for the message/stack to be scrubbed — nothing pinned
// that. These cases drive `log.error` itself with DD_LOGS_JSON=1 and assert on
// what actually reaches the console, so gutting the replacer's redaction call
// fails here rather than shipping a live credential to the log drain.
// ---------------------------------------------------------------------------
describe("structured console redacts secrets on the way to the drain", () => {
  // A Google OAuth access token, under an innocent (non-sensitive) key, so only
  // the VALUE-based rule can catch it.
  const LIVE_ACCESS_TOKEN = "ya29.a0AfB_bZlFAKEtokenVALUE1234567890abcdefXYZ";

  it("scrubs a bare ya29. token embedded in a plain string meta value", async () => {
    vi.stubEnv("DD_LOGS_JSON", "1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = await importLogStructured();
    errSpy.mockClear();

    log.error("[google/import] Failed to export doc", {
      detail: `invalid authentication credential ${LIVE_ACCESS_TOKEN}`,
    });

    const line = errSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(LIVE_ACCESS_TOKEN);
    expect(line).not.toContain("ya29.");
    // The surrounding message survives — this is redaction, not deletion.
    expect(JSON.parse(line).detail).toContain("invalid authentication");
  });

  it("scrubs a token inside an Error's message, through the Error-unwrap branch", async () => {
    vi.stubEnv("DD_LOGS_JSON", "1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = await importLogStructured();
    errSpy.mockClear();

    log.error("[google/import] Failed to export doc", {
      error: new Error(
        `Request failed 403: Authorization: ${LIVE_ACCESS_TOKEN}`
      ),
    });

    const line = errSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(LIVE_ACCESS_TOKEN);
    expect(line).not.toContain("ya29.");
    // The Error is still expanded rather than collapsed to {} …
    const parsed = JSON.parse(line);
    expect(parsed.error.name).toBe("Error");
    // … and its message is still present, just scrubbed.
    expect(parsed.error.message).toContain("Request failed 403");
  });

  it("scrubs a token that appears only in an Error's stack", async () => {
    vi.stubEnv("DD_LOGS_JSON", "1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = await importLogStructured();
    errSpy.mockClear();

    const error = new Error("export failed");
    error.stack = `Error: export failed\n    at googleapis (/app/node_modules/googleapis/index.js:1:1) token=${LIVE_ACCESS_TOKEN}`;
    log.error("[google/import] Failed to export doc", { error });

    const line = errSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(LIVE_ACCESS_TOKEN);
    expect(JSON.parse(line).error.stack).toContain("Error: export failed");
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
