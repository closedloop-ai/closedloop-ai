import { log } from "@repo/observability/log";
import { sanitizeDesktopTelemetryDiagnostics } from "@repo/observability/telemetry/emitter";
import { Origin } from "@repo/observability/telemetry/origin";
import {
  desktopTelemetryEventSchema,
  OutboundNetworkDecision,
  OutboundNetworkDecisionReason,
  OutboundNetworkDestinationClass,
  OutboundNetworkSurface,
  TelemetryCategory,
  TelemetrySeverity,
  telemetryDiagnosticsSchema,
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

const reportedDecisionTableVerification = {
  telemetryStatus: "reported",
  telemetryFilePath:
    "/tmp/work/.closedloop-ai/decision-table-verifications.jsonl",
  lineNumber: 3,
  timestamp: "2026-05-01T13:20:06.234Z",
  workdir: "/tmp/work",
  decisionTablePath: ".closedloop-ai/decision-tables/pln-302.md",
  finalStatus: "aligned",
  iterations: 3,
  driftKindCounts: {
    codeDrift: 2,
    testDrift: 1,
    planAmbiguity: 0,
  },
  fixesAttempted: 3,
  parseFailures: 0,
  verifierInvocations: 3,
  phaseDurationMs: 58_921,
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

// ---------------------------------------------------------------------------
// (f) Expanded diagnostics schema — new fields pass through validation
// ---------------------------------------------------------------------------

describe("telemetryDiagnosticsSchema — expanded fields", () => {
  it("validates diagnostics with new fields (stderrTail, exitSignal, elapsedMs, spawnMeta, abortReason)", () => {
    const diagnostics = {
      logTail: "some log output",
      exitCode: 1,
      stderrTail: "error on stderr",
      exitSignal: "SIGTERM",
      elapsedMs: 12_345,
      stdoutBytes: 8192,
      abortReason: "timeout",
      diagnosticsVersion: 2,
      spawnMeta: {
        command: "claude",
        args: ["--model", "opus"],
        cwd: "/home/user/project",
        claudeVersion: "1.2.3",
        binaryPath: "/usr/local/bin/claude",
        authFilesExist: true,
        envSnapshot: { PATH: "/usr/local/bin", HOME: "/home/user" },
      },
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 75,
      },
    };

    const result = telemetryDiagnosticsSchema.safeParse(diagnostics);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stderrTail).toBe("error on stderr");
      expect(result.data.exitSignal).toBe("SIGTERM");
      expect(result.data.elapsedMs).toBe(12_345);
      expect(result.data.stdoutBytes).toBe(8192);
      expect(result.data.abortReason).toBe("timeout");
      expect(result.data.diagnosticsVersion).toBe(2);
      expect(result.data.spawnMeta?.command).toBe("claude");
      expect(result.data.tokenUsage?.cacheCreationInputTokens).toBe(50);
      expect(result.data.tokenUsage?.cacheReadInputTokens).toBe(75);
    }
  });

  it("validates old format (no new fields) for backward compatibility", () => {
    const diagnostics = {
      logTail: "some log output",
      exitCode: 0,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 200,
      },
    };

    const result = telemetryDiagnosticsSchema.safeParse(diagnostics);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stderrTail).toBeUndefined();
      expect(result.data.exitSignal).toBeUndefined();
      expect(result.data.elapsedMs).toBeUndefined();
      expect(result.data.spawnMeta).toBeUndefined();
      expect(result.data.tokenUsage?.cacheCreationInputTokens).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// (g) handleTelemetryEvent — organizationId/userId from context appear in log
// ---------------------------------------------------------------------------

describe("handleTelemetryEvent — organizationId/userId enrichment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes organizationId and userId in the log output when provided in context", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const contextWithAuth: TelemetryHandlerContext = {
      authenticatedTargetId: COMPUTE_TARGET_ID,
      organizationId: "org-123",
      userId: "user-456",
    };

    const result = handleTelemetryEvent(
      validDesktopWirePayload,
      contextWithAuth
    );

    expect(result.ok).toBe(true);

    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    expect(infoCall).toBeDefined();
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta.organizationId).toBe("org-123");
    expect(meta.userId).toBe("user-456");
  });

  it("omits organizationId and userId from log when not provided in context", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      validDesktopWirePayload,
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);

    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    expect(infoCall).toBeDefined();
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta).not.toHaveProperty("organizationId");
    expect(meta).not.toHaveProperty("userId");
  });

  it("includes EXECUTE plan source diagnostics in the Datadog log metadata", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const result = handleTelemetryEvent(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.JobPlanSourceResolved,
        diagnostics: {
          planSource: {
            source: "imported-plan-compat",
            rawPlanPayload: true,
            rawPlanAligned: false,
            localPlanJsonPresent: true,
            localPlanJsonAligned: false,
            importedPlanFileStaged: true,
            closedLoopPlanFileSet: true,
            planArtifactContentLength: 10_455,
            rawPlanContentLength: 23_906,
            planArtifactContentHash: "abc123def456",
            rawPlanContentHash: "fed654cba321",
          },
        },
      },
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);
    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    expect(infoCall).toBeDefined();
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta.category).toBe(TelemetryCategory.JobPlanSourceResolved);
    expect(meta.diagnostics).toMatchObject({
      planSource: {
        source: "imported-plan-compat",
        rawPlanPayload: true,
        rawPlanAligned: false,
        importedPlanFileStaged: true,
        closedLoopPlanFileSet: true,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// (h) handleTelemetryEvent — decision-table verification diagnostics reach Datadog
// ---------------------------------------------------------------------------

describe("handleTelemetryEvent — decision-table verification telemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("flushes decision-table verification diagnostics and telemetryMessage in Datadog metadata", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_SERVICE", "api");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const { log: freshLog } = await import("@repo/observability/log");
    const { handleTelemetryEvent: freshHandler } = await import(
      "@/lib/desktop-telemetry-handler"
    );

    const result = freshHandler(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.JobDecisionTableVerification,
        message: "Decision-table verification aligned",
        diagnostics: {
          decisionTableVerification: reportedDecisionTableVerification,
        },
      },
      defaultHandlerContext
    );
    expect(result.ok).toBe(true);

    await freshLog.flush();
    expect(fetchMock).toHaveBeenCalledOnce();

    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string
    ) as Array<{
      category?: string;
      diagnostics?: {
        decisionTableVerification?: typeof reportedDecisionTableVerification;
      };
      message?: string;
      telemetryMessage?: string;
    }>;
    const entry = body.find(
      (e) => e.category === TelemetryCategory.JobDecisionTableVerification
    );

    expect(entry).toBeDefined();
    expect(entry?.message).toBe("Desktop telemetry event received");
    expect(entry?.telemetryMessage).toBe("Decision-table verification aligned");
    expect(entry?.diagnostics?.decisionTableVerification).toEqual(
      reportedDecisionTableVerification
    );
  });
});

// ---------------------------------------------------------------------------
// (h2) handleTelemetryEvent — outbound network diagnostics reach Datadog
// ---------------------------------------------------------------------------

describe("handleTelemetryEvent — outbound network telemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("flushes descriptor-only outbound network diagnostics in Datadog metadata", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("DD_SERVICE", "api");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const { log: freshLog } = await import("@repo/observability/log");
    const { handleTelemetryEvent: freshHandler } = await import(
      "@/lib/desktop-telemetry-handler"
    );

    const result = freshHandler(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.DesktopOutboundNetworkDecision,
        message: "Outbound network request denied",
        diagnostics: {
          outboundNetwork: {
            surface: OutboundNetworkSurface.LoopAttachmentDownload,
            decision: OutboundNetworkDecision.Denied,
            reason: OutboundNetworkDecisionReason.AttachmentHostNotAllowed,
            destinationClass: OutboundNetworkDestinationClass.External,
            protocol: "https:",
            hostname: "attacker.example.com",
            port: "443",
            rawUrl:
              "https://attacker.example.com/users/123/object.txt?X-Amz-Signature=secret",
          },
        },
      },
      defaultHandlerContext
    );
    expect(result.ok).toBe(true);

    await freshLog.flush();
    expect(fetchMock).toHaveBeenCalledOnce();

    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string
    ) as Array<{
      category?: string;
      diagnostics?: {
        outboundNetwork?: Record<string, unknown>;
      };
      telemetryMessage?: string;
    }>;
    const entry = body.find(
      (e) => e.category === TelemetryCategory.DesktopOutboundNetworkDecision
    );

    expect(entry).toBeDefined();
    expect(entry?.telemetryMessage).toBe("Outbound network request denied");
    expect(entry?.diagnostics?.outboundNetwork).toEqual({
      surface: OutboundNetworkSurface.LoopAttachmentDownload,
      decision: OutboundNetworkDecision.Denied,
      reason: OutboundNetworkDecisionReason.AttachmentHostNotAllowed,
      destinationClass: OutboundNetworkDestinationClass.External,
      protocol: "https:",
      hostname: "attacker.example.com",
      port: "443",
    });
    expect(JSON.stringify(entry)).not.toContain("/users/123");
    expect(JSON.stringify(entry)).not.toContain("X-Amz-Signature");
  });

  it("preserves outbound network telemetry with unknown classification values", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: () => Promise.resolve("accepted"),
    });
    globalThis.fetch = fetchMock;
    process.env.DD_API_KEY = "test-key";
    process.env.DD_SITE = "datadoghq.com";
    process.env.DD_SERVICE = "api";
    process.env.ORIGIN = Origin.Api;
    vi.resetModules();

    const { log: freshLog } = await import("@repo/observability/log");
    const { handleTelemetryEvent: freshHandler } = await import(
      "@/lib/desktop-telemetry-handler"
    );

    const result = freshHandler(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.DesktopOutboundNetworkDecision,
        message: "Outbound network request classified by newer Desktop",
        diagnostics: {
          outboundNetwork: {
            surface: "future_surface",
            decision: "future_decision",
            reason: "future_reason",
            destinationClass: "future_destination_class",
            protocol: "http:",
            hostname: "app.localhost",
            port: "3000",
            rawUrl: "http://app.localhost:3000/private?token=secret",
          },
        },
      },
      defaultHandlerContext
    );
    expect(result.ok).toBe(true);

    await freshLog.flush();
    expect(fetchMock).toHaveBeenCalledOnce();

    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string
    ) as Array<{
      category?: string;
      diagnostics?: {
        outboundNetwork?: Record<string, unknown>;
      };
    }>;
    const entry = body.find(
      (e) => e.category === TelemetryCategory.DesktopOutboundNetworkDecision
    );

    expect(entry).toBeDefined();
    expect(entry?.diagnostics?.outboundNetwork).toEqual({
      surface: OutboundNetworkSurface.Unknown,
      decision: OutboundNetworkDecision.Unknown,
      reason: OutboundNetworkDecisionReason.Unknown,
      destinationClass: OutboundNetworkDestinationClass.Unknown,
      protocol: "http:",
      hostname: "app.localhost",
      port: "3000",
    });
    expect(JSON.stringify(entry)).not.toContain("token=secret");
    expect(JSON.stringify(entry)).not.toContain("/private");
  });
});

// ---------------------------------------------------------------------------
// (i) sanitizeDesktopTelemetryDiagnostics — stderrTail ANSI + credential filter
// ---------------------------------------------------------------------------

describe("sanitizeDesktopTelemetryDiagnostics — stderrTail sanitization", () => {
  it("strips ANSI codes and credential lines from stderrTail", () => {
    const diagnostics = {
      stderrTail:
        "\u001b[31mError: something failed\u001b[0m\nauthorization: Bearer sk_live_secret\nclean line here",
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.stderrTail).toBe("Error: something failed\nclean line here");
  });

  it("strips ANSI codes from logTail", () => {
    const diagnostics = {
      logTail: "\u001b[32mSuccess\u001b[0m output here",
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.logTail).toBe("Success output here");
  });

  it("handles diagnostics with both logTail and stderrTail containing ANSI", () => {
    const diagnostics = {
      logTail: "\u001b[34mInfo:\u001b[0m normal log\ntoken=abc123",
      stderrTail: "\u001b[31mError:\u001b[0m bad thing\npassword=secret",
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.logTail).toBe("Info: normal log");
    expect(result?.stderrTail).toBe("Error: bad thing");
  });
});

// ---------------------------------------------------------------------------
// (j) sanitizeDesktopTelemetryDiagnostics — spawnMeta.envSnapshot allowlist
// ---------------------------------------------------------------------------

describe("sanitizeDesktopTelemetryDiagnostics — envSnapshot filtering", () => {
  it("filters spawnMeta.envSnapshot to safe keys only", () => {
    const diagnostics = {
      spawnMeta: {
        command: "claude",
        args: ["--model", "opus"],
        cwd: "/home/user/project",
        binaryPath: "/usr/local/bin/claude",
        authFilesExist: true,
        envSnapshot: {
          NODE_ENV: "production",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_VERTEX: "0",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          DATABASE_URL: "postgresql://user:pass@host/db",
          HOME: "/home/user",
          PATH: "/usr/local/bin:/usr/bin",
        },
      },
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    const env = result?.spawnMeta?.envSnapshot;
    expect(env).toBeDefined();
    // Safe keys survive
    expect(env?.NODE_ENV).toBe("production");
    expect(env?.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env?.CLAUDE_CODE_USE_VERTEX).toBe("0");
    // Unsafe keys are stripped
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("PATH");
  });

  it("does not mutate the original diagnostics object", () => {
    const original = {
      spawnMeta: {
        command: "claude",
        args: [] as string[],
        cwd: "/tmp",
        binaryPath: "/usr/local/bin/claude",
        authFilesExist: false,
        envSnapshot: {
          NODE_ENV: "test",
          SECRET_KEY: "should-be-stripped",
        },
      },
    };

    sanitizeDesktopTelemetryDiagnostics(original);

    // Original still has the unsafe key
    expect(original.spawnMeta.envSnapshot.SECRET_KEY).toBe(
      "should-be-stripped"
    );
  });

  it("preserves spawnMeta fields and returns empty envSnapshot when no keys are safe", () => {
    const diagnostics = {
      spawnMeta: {
        command: "claude",
        args: ["--help"],
        cwd: "/tmp",
        binaryPath: "/usr/local/bin/claude",
        authFilesExist: true,
        envSnapshot: {
          SECRET_TOKEN: "should-be-stripped",
          PRIVATE_KEY: "also-stripped",
        },
      },
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.spawnMeta?.command).toBe("claude");
    expect(result?.spawnMeta?.envSnapshot).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// (k) validation-failure paths carry category: TelemetryValidationFailed
//
// The handler's two rejection sites (schema parse failure and
// computeTargetId mismatch) both log.warn with category in meta so the
// documented Datadog query @category:"telemetry.validation_failed" matches
// regardless of whether the failure came from the server emitter.ts path or
// this handler. Observes the flushed Datadog entry rather than spying on
// log.warn, matching the "assert on observable behavior" convention in
// CLAUDE.md.
// ---------------------------------------------------------------------------

describe("handleTelemetryEvent — validation failures emit category attribute", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  type ValidationEntry = {
    category?: string;
    message?: string;
    level?: string;
  };

  async function importFreshHandlerWithFetch(
    fetchMock: ReturnType<typeof vi.fn>
  ): Promise<{
    freshLog: typeof import("@repo/observability/log").log;
    freshHandler: typeof handleTelemetryEvent;
  }> {
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { log: freshLog } = await import("@repo/observability/log");
    const { handleTelemetryEvent: freshHandler } = await import(
      "@/lib/desktop-telemetry-handler"
    );
    return { freshLog, freshHandler };
  }

  it("(a) schema parse failure flushes entry with category: TelemetryValidationFailed", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    // Populate version + git_sha so log.ts's module-load fallback warnings
    // do not displace the validation-failed entry in the flushed batch.
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { freshLog, freshHandler } =
      await importFreshHandlerWithFetch(fetchMock);

    // Missing required schemaVersion — triggers the parse-failure branch.
    const invalidPayload = {
      category: TelemetryCategory.JobStarted,
      severity: TelemetrySeverity.Info,
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "cmd-1",
        operationId: "op-1",
        computeTargetId: COMPUTE_TARGET_ID,
      },
    };

    const result = freshHandler(invalidPayload, defaultHandlerContext);
    expect(result.ok).toBe(false);

    await freshLog.flush();
    expect(fetchMock).toHaveBeenCalledOnce();

    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string
    ) as ValidationEntry[];
    const entry = body.find(
      (e) => e.message === "Desktop telemetry validation failed"
    );
    expect(entry).toBeDefined();
    expect(entry?.category).toBe(TelemetryCategory.TelemetryValidationFailed);
    expect(entry?.level).toBe("warn");
  });

  it("(b) computeTargetId mismatch flushes entry with category: TelemetryValidationFailed", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const { freshLog, freshHandler } =
      await importFreshHandlerWithFetch(fetchMock);

    const result = freshHandler(validDesktopWirePayload, {
      authenticatedTargetId: "different-target",
    });
    expect(result.ok).toBe(false);

    await freshLog.flush();
    expect(fetchMock).toHaveBeenCalledOnce();

    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string
    ) as ValidationEntry[];
    const entry = body.find(
      (e) => e.message === "Desktop telemetry computeTargetId mismatch"
    );
    expect(entry).toBeDefined();
    expect(entry?.category).toBe(TelemetryCategory.TelemetryValidationFailed);
    expect(entry?.level).toBe("warn");
  });
});
