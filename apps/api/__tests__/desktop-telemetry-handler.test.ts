import { log } from "@repo/observability/log";
import { Origin } from "@repo/observability/telemetry/origin";
import {
  desktopTelemetryEventSchema,
  TelemetryCategory,
  TelemetrySeverity,
} from "@repo/observability/telemetry/schema";
import { vi } from "vitest";
import {
  handleTelemetryEvent,
  type TelemetryHandlerContext,
} from "@/lib/desktop-telemetry-handler";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID_A = "166e7770-fd87-49aa-a09b-a91cd2c404c8";
const VALID_UUID_B = "85c4e16f-43d1-4422-b017-e9a2b7073c15";
const COMPUTE_TARGET_ID = "target-test-001";

const validDesktopWirePayload = {
  schemaVersion: "1",
  category: TelemetryCategory.JobStarted,
  severity: TelemetrySeverity.Info,
  timestamp: "2024-01-01T00:00:00.000Z",
  trace: {
    commandId: "cmd-1",
    operationId: "op-1",
    computeTargetId: COMPUTE_TARGET_ID,
    gatewaySessionId: VALID_UUID_A,
    sessionId: VALID_UUID_B,
  },
};

const defaultHandlerContext: TelemetryHandlerContext = {
  authenticatedTargetId: COMPUTE_TARGET_ID,
};

// ---------------------------------------------------------------------------
// (a) handleTelemetryEvent — handler always enriches origin to Origin.Desktop
//
// Even when a pre-parsed event object carrying `origin: "api"` is passed
// directly to handleTelemetryEvent(), the handler overwrites origin with
// Origin.Desktop before emitting the log. This verifies the enrichment path
// is not bypassable by injecting a payload that already has an origin field.
// ---------------------------------------------------------------------------

describe("handleTelemetryEvent — origin enrichment overwrites injected origin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits log.info with origin: Origin.Desktop even when payload contains origin: 'api'", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    // Inject origin: "api" into the payload that will be parsed by the handler.
    // desktopTelemetryEventSchema.transform strips unknown keys (including origin),
    // so the parsed output will not carry origin. The handler then explicitly
    // sets origin: Origin.Desktop in the log call.
    const payloadWithInjectedOrigin = {
      ...validDesktopWirePayload,
      origin: "api",
    };

    const result = handleTelemetryEvent(
      payloadWithInjectedOrigin,
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);

    // Find the "Desktop telemetry event received" call (not warn calls)
    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    expect(infoCall).toBeDefined();
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta.origin).toBe(Origin.Desktop);
  });
});

// ---------------------------------------------------------------------------
// (b) buildEntry() — meta.origin: Origin.Desktop overrides ORIGIN constant
//
// When log.info is called with meta { origin: Origin.Desktop }, the built
// Datadog entry carries origin: Origin.Desktop even though ORIGIN === Origin.Api
// in the test harness (DD_SERVICE is not set at setup time for apps/api tests,
// but the module ORIGIN defaults to Origin.Unknown — either way it is not Desktop).
//
// Pattern mirrors packages/observability/__tests__/log-ddtags.test.ts:
// vi.resetModules() + vi.stubGlobal("fetch") + dynamic import.
// ---------------------------------------------------------------------------

describe("buildEntry() — valid meta.origin overrides ORIGIN", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits entry with origin: Origin.Desktop when meta supplies Origin.Desktop", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_SERVICE", "api");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const { log: freshLog } = await import("@repo/observability/log");

    freshLog.info("test", { origin: Origin.Desktop });
    await freshLog.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as Array<{
      origin: string;
    }>;
    // Find the "test" entry (ignoring any module-load warnings that may have fired)
    const testEntry = body.find(
      (e) => (e as { message?: string }).message === "test"
    );
    expect(testEntry).toBeDefined();
    expect(testEntry?.origin).toBe(Origin.Desktop);
    // ORIGIN === Origin.Api in this module context — confirm Desktop wins
    expect(testEntry?.origin).not.toBe(Origin.Api);
  });
});

// ---------------------------------------------------------------------------
// (c) buildEntry() — invalid meta.origin silently falls back to ORIGIN
//
// When meta.origin is not a known Origin value, buildEntry() falls back to
// the module-level ORIGIN constant (Origin.Api when DD_SERVICE=api) with no
// thrown exception and no console warning.
// ---------------------------------------------------------------------------

describe("buildEntry() — invalid meta.origin falls back to ORIGIN silently", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits entry with origin: Origin.Api and does not throw when meta.origin is an invalid value", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_SERVICE", "api");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { log: freshLog } = await import("@repo/observability/log");

    freshLog.info("invalid-origin-test", { origin: "notareal" });
    await freshLog.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string) as Array<{
      origin: string;
    }>;
    const testEntry = body.find(
      (e) => (e as { message?: string }).message === "invalid-origin-test"
    );
    expect(testEntry).toBeDefined();
    expect(testEntry?.origin).toBe(Origin.Api);

    // No buildEntry-level warning — the fallback is silent
    const buildEntryWarnings = warnSpy.mock.calls.filter((args) => {
      const msg = String(args[0]);
      return msg.includes("origin") && msg.includes("invalid");
    });
    expect(buildEntryWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (d) desktopTelemetryEventSchema — drops unknown keys (AC-004 Zod defense)
//
// safeParse on a payload that includes origin: "api" succeeds, but the parsed
// output does not carry origin — Zod's transform strips all unknown keys.
// This documents that the schema-layer cannot be used to inject an origin override.
// ---------------------------------------------------------------------------

describe("desktopTelemetryEventSchema — drops unknown keys including injected origin", () => {
  it("safeParse succeeds for a payload with origin: 'api' but result.data.origin is undefined", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      origin: "api",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).origin).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (e) handleTelemetryEvent — catch block fallback when trace enrichment throws
//
// Exercises AC-1.5 of FEA-486. When buildTelemetryTraceContext throws, the
// handler must (i) still emit the event with origin: Origin.Desktop and an
// unenriched trace, (ii) log a telemetry.enrichment_failed warning carrying
// only the bounded-cardinality fields (commandId, gatewaySessionId, category,
// errorClass) and no PII, and (iii) never drop the event. Prior to this test
// the catch branch had no coverage — it was defensive code never observed.
//
// Pattern mirrors the (b)/(c) describes above: vi.doMock the context module
// so its buildTelemetryTraceContext throws, vi.resetModules(), then dynamic
// imports so the handler closes over the mocked export.
// ---------------------------------------------------------------------------

describe("handleTelemetryEvent — enrichment failure fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@repo/observability/telemetry/context");
  });

  it("emits the original event with origin=Desktop and a bounded telemetry.enrichment_failed warning when buildTelemetryTraceContext throws", async () => {
    const enrichmentError = new TypeError("simulated trace enrichment failure");
    vi.doMock(
      "@repo/observability/telemetry/context",
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import("@repo/observability/telemetry/context")
          >();
        return {
          ...actual,
          buildTelemetryTraceContext: () => {
            throw enrichmentError;
          },
        };
      }
    );

    vi.resetModules();
    const { log: freshLog } = await import("@repo/observability/log");
    const { Origin: FreshOrigin } = await import(
      "@repo/observability/telemetry/origin"
    );
    const { handleTelemetryEvent: freshHandler } = await import(
      "@/lib/desktop-telemetry-handler"
    );

    const infoSpy = vi.spyOn(freshLog, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(freshLog, "warn").mockImplementation(() => {});

    const result = freshHandler(validDesktopWirePayload, defaultHandlerContext);

    expect(result.ok).toBe(true);

    // (i) Event is emitted via log.info with origin=Desktop and the UNENRICHED trace
    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    expect(infoCall).toBeDefined();
    const infoMeta = infoCall?.[1] as Record<string, unknown>;
    expect(infoMeta.origin).toBe(FreshOrigin.Desktop);
    expect(infoMeta.category).toBe(validDesktopWirePayload.category);
    expect(infoMeta.severity).toBe(validDesktopWirePayload.severity);

    // The emitted trace is event.trace (post-schema-transform, so sessionId is
    // renamed to loopSessionId by desktopTelemetryEventSchema) — NOT the trace
    // returned by the thrown buildTelemetryTraceContext call.
    expect(infoMeta.trace).toMatchObject({
      commandId: validDesktopWirePayload.trace.commandId,
      operationId: validDesktopWirePayload.trace.operationId,
      computeTargetId: validDesktopWirePayload.trace.computeTargetId,
      gatewaySessionId: validDesktopWirePayload.trace.gatewaySessionId,
    });
    // Critically — none of the server-enrichment fields are present, proving
    // the fallback path bypassed buildTelemetryTraceContext.
    expect(infoMeta.trace).not.toHaveProperty("serverVersion");
    expect(infoMeta.trace).not.toHaveProperty("environment");
    expect(infoMeta.trace).not.toHaveProperty("pluginVersion");

    // (ii) telemetry.enrichment_failed warn fires with only bounded-cardinality fields
    const warnCall = warnSpy.mock.calls.find(
      (args) => args[0] === "telemetry.enrichment_failed"
    );
    expect(warnCall).toBeDefined();
    const warnMeta = warnCall?.[1] as Record<string, unknown>;
    expect(warnMeta).toEqual({
      commandId: validDesktopWirePayload.trace.commandId,
      gatewaySessionId: validDesktopWirePayload.trace.gatewaySessionId,
      category: validDesktopWirePayload.category,
      errorClass: "TypeError",
    });

    // (iii) No PII / unbounded fields leak into the warning
    expect(warnMeta).not.toHaveProperty("diagnostics");
    expect(warnMeta).not.toHaveProperty("message");
    expect(warnMeta).not.toHaveProperty("trace");
  });
});
