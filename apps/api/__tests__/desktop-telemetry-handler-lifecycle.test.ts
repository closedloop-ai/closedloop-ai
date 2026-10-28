import { log } from "@repo/observability/log";
import {
  DesktopShutdownTrigger,
  DesktopUpdateTrigger,
  SupportUploadReason,
} from "@repo/observability/telemetry/desktop-lifecycle-triggers";
import { Origin } from "@repo/observability/telemetry/origin";
import {
  OutboundNetworkDecision,
  OutboundNetworkDecisionReason,
  OutboundNetworkDestinationClass,
  OutboundNetworkSurface,
} from "@repo/observability/telemetry/outbound-network";
import {
  TelemetryCategory,
  TelemetrySeverity,
} from "@repo/observability/telemetry/telemetry-category";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";
import {
  defaultHandlerContext,
  validDesktopWirePayload,
} from "./utils/desktop-telemetry-fixtures";
import { stubLogExporterEnv } from "./utils/telemetry-env";

// ---------------------------------------------------------------------------
// (h1) handleTelemetryEvent — desktop update/shutdown telemetry
// ---------------------------------------------------------------------------

describe("handleTelemetryEvent — desktop update and shutdown telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs accepted electron update telemetry with queryable origin/category and sanitized diagnostics", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.ElectronUpdateFailed,
        severity: TelemetrySeverity.Error,
        message: "Electron update failed",
        diagnostics: {
          desktopUpdate: {
            trigger: "apply-before-downloaded",
            status: "available",
            version: "0.14.29",
            error: "Update has not finished downloading yet",
            downloaded: false,
            readyToInstall: false,
            rawLog: "authorization: Bearer secret",
          },
        },
      },
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);
    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta.origin).toBe(Origin.Desktop);
    expect(meta.category).toBe(TelemetryCategory.ElectronUpdateFailed);
    expect(meta.diagnostics).toMatchObject({
      desktopUpdate: {
        trigger: "apply-before-downloaded",
        status: "available",
        version: "0.14.29",
        error: "Update has not finished downloading yet",
        downloaded: false,
        readyToInstall: false,
      },
    });
    expect(JSON.stringify(meta)).not.toContain("Bearer secret");
    expect(JSON.stringify(meta)).not.toContain("rawLog");
  });

  it("logs accepted shutdown failure telemetry with queryable origin/category", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.DesktopShutdownFailed,
        severity: TelemetrySeverity.Error,
        message: "Desktop shutdown failed",
        diagnostics: {
          desktopShutdown: {
            trigger: "outer-hard-exit",
            result: "timed_out",
            phase: "server.stop",
            elapsedMs: 8000,
            duringUpdate: true,
            outerHardExit: true,
          },
        },
      },
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);
    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta.origin).toBe(Origin.Desktop);
    expect(meta.category).toBe(TelemetryCategory.DesktopShutdownFailed);
    expect(meta.diagnostics).toMatchObject({
      desktopShutdown: {
        trigger: "outer-hard-exit",
        result: "timed_out",
        phase: "server.stop",
        elapsedMs: 8000,
        duringUpdate: true,
        outerHardExit: true,
      },
    });
  });

  it("preserves update telemetry when desktop sends an unknown trigger", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.ElectronUpdateFailed,
        severity: TelemetrySeverity.Error,
        message: "Electron update failed",
        diagnostics: {
          desktopUpdate: {
            trigger: "future-update-trigger",
            status: "available",
            error: "new updater path failed",
          },
        },
      },
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);
    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta.diagnostics).toMatchObject({
      desktopUpdate: {
        trigger: DesktopUpdateTrigger.Unknown,
        status: "available",
        error: "new updater path failed",
      },
    });
  });

  it("preserves shutdown telemetry when desktop sends an unknown trigger", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      {
        ...validDesktopWirePayload,
        category: TelemetryCategory.DesktopShutdownFailed,
        severity: TelemetrySeverity.Error,
        message: "Desktop shutdown failed",
        diagnostics: {
          desktopShutdown: {
            trigger: "future-shutdown-trigger",
            result: "failed",
            phase: "future.phase",
          },
        },
      },
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);
    const infoCall = infoSpy.mock.calls.find(
      (args) => args[0] === "Desktop telemetry event received"
    );
    const meta = infoCall?.[1] as Record<string, unknown>;
    expect(meta.diagnostics).toMatchObject({
      desktopShutdown: {
        trigger: DesktopShutdownTrigger.Unknown,
        result: "failed",
        phase: "future.phase",
      },
    });
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
    stubLogExporterEnv();
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
    stubLogExporterEnv();
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

describe("handleTelemetryEvent — support upload telemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("flushes support upload diagnostics in Datadog metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: () => Promise.resolve("accepted"),
    });
    globalThis.fetch = fetchMock;
    stubLogExporterEnv();
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
        category: TelemetryCategory.DesktopSupportUpload,
        message: "Support upload failed",
        diagnostics: {
          supportUpload: {
            outcome: "failed",
            loopId: "loop-1",
            s3StateKeySuffix: "run-1",
            attemptedLogicalNames: ["claude-output.jsonl", "perf.jsonl"],
            attemptedUploadedNames: ["claude-output.jsonl"],
            reason: SupportUploadReason.EventPostFailed,
            uploadedCount: 1,
            durationMs: 123,
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
        supportUpload?: Record<string, unknown>;
      };
      telemetryMessage?: string;
    }>;
    const entry = body.find(
      (event) => event.category === TelemetryCategory.DesktopSupportUpload
    );

    expect(entry?.telemetryMessage).toBe("Support upload failed");
    expect(entry?.diagnostics?.supportUpload).toEqual({
      outcome: "failed",
      loopId: "loop-1",
      s3StateKeySuffix: "run-1",
      attemptedLogicalNames: ["claude-output.jsonl", "perf.jsonl"],
      attemptedUploadedNames: ["claude-output.jsonl"],
      reason: SupportUploadReason.EventPostFailed,
      uploadedCount: 1,
      durationMs: 123,
    });
  });
});
