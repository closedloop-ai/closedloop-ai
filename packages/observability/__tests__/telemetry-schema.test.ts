import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactGatewaySessionId } from "../redact-correlation";
import {
  buildDesktopTelemetryPayload,
  buildValidationFailedPayload,
  sanitizeDesktopTelemetryDiagnostics,
} from "../telemetry/emitter";
import type { TelemetryTraceContext } from "../telemetry/schema";
import {
  DesktopShutdownTrigger,
  DesktopUpdateTrigger,
  desktopTelemetryEventSchema,
  isLoopPerfTelemetryRateLimitBypass,
  KNOWN_LOOP_COMMANDS,
  OutboundNetworkDecision,
  OutboundNetworkDecisionReason,
  OutboundNetworkDestinationClass,
  OutboundNetworkSurface,
  SupportUploadReason,
  TelemetryCategory,
  TelemetrySeverity,
  telemetryDiagnosticsSchema,
  telemetryTraceContextSchema,
} from "../telemetry/schema";
import { importModuleWithFetch, parseFlushedBody } from "./test-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID_A = "166e7770-fd87-49aa-a09b-a91cd2c404c8";
const VALID_UUID_B = "85c4e16f-43d1-4422-b017-e9a2b7073c15";

const validTraceContext = {
  commandId: "cmd-1",
  operationId: "op-1",
  computeTargetId: "target-1",
  gatewaySessionId: VALID_UUID_A,
  loopSessionId: VALID_UUID_B,
  schemaVersion: "1",
};

const validDesktopWirePayload = {
  schemaVersion: "1",
  category: TelemetryCategory.JobStarted,
  severity: TelemetrySeverity.Info,
  timestamp: "2024-01-01T00:00:00.000Z",
  trace: {
    commandId: "cmd-1",
    operationId: "op-1",
    computeTargetId: "target-1",
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

const missingDecisionTableVerification = {
  telemetryStatus: "missing",
  telemetryFilePath:
    "/tmp/work/.closedloop-ai/decision-table-verifications.jsonl",
  filePresent: true,
  linesRead: 0,
  invalidLines: 0,
  missingReason: "no_current_run_records",
  readError: "permission denied",
};

// ---------------------------------------------------------------------------
// telemetryTraceContextSchema
// ---------------------------------------------------------------------------

describe("telemetryTraceContextSchema", () => {
  it("accepts a valid trace context payload", () => {
    const result = telemetryTraceContextSchema.safeParse(validTraceContext);
    expect(result.success).toBe(true);
  });

  it("loopSessionId is optional — accepts payload without it", () => {
    const { loopSessionId: _omit, ...rest } = validTraceContext;
    const result = telemetryTraceContextSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// telemetryDiagnosticsSchema
// ---------------------------------------------------------------------------

describe("telemetryDiagnosticsSchema", () => {
  it("accepts an empty diagnostics object (all fields optional)", () => {
    const result = telemetryDiagnosticsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts diagnostics with logTail and exitCode", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      logTail: "some log output",
      exitCode: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts diagnostics with tokenUsage", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects tokenUsage missing inputTokens", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      tokenUsage: { outputTokens: 50 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tokenUsage missing outputTokens", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      tokenUsage: { inputTokens: 100 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a numeric ackLatencyMs", () => {
    const result = telemetryDiagnosticsSchema.safeParse({ ackLatencyMs: 123 });
    expect(result.success).toBe(true);
  });

  it("accepts EXECUTE plan source diagnostics", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      planSource: {
        source: "imported-plan-compat",
        rawPlanPayload: true,
        rawPlanAligned: false,
        localPlanJsonPresent: false,
        localPlanJsonAligned: false,
        importedPlanFileStaged: true,
        closedLoopPlanFileSet: true,
        planArtifactContentLength: 10_455,
        rawPlanContentLength: 23_906,
        planArtifactContentHash: "abc123def456",
        rawPlanContentHash: "fed654cba321",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts reported decision-table verification diagnostics", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      decisionTableVerification: reportedDecisionTableVerification,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisionTableVerification?.telemetryStatus).toBe(
        "reported"
      );
      if (
        result.data.decisionTableVerification?.telemetryStatus === "reported"
      ) {
        expect(result.data.decisionTableVerification.finalStatus).toBe(
          "aligned"
        );
        expect(result.data.decisionTableVerification.decisionTablePath).toBe(
          ".closedloop-ai/decision-tables/pln-302.md"
        );
        expect(
          result.data.decisionTableVerification.driftKindCounts.codeDrift
        ).toBe(2);
        expect(result.data.decisionTableVerification.fixesAttempted).toBe(3);
        expect(result.data.decisionTableVerification.phaseDurationMs).toBe(
          58_921
        );
      }
    }
  });

  it("accepts missing decision-table verification diagnostics", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      decisionTableVerification: missingDecisionTableVerification,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisionTableVerification?.telemetryStatus).toBe(
        "missing"
      );
      if (
        result.data.decisionTableVerification?.telemetryStatus === "missing"
      ) {
        expect(result.data.decisionTableVerification.missingReason).toBe(
          "no_current_run_records"
        );
        expect(result.data.decisionTableVerification.filePresent).toBe(true);
        expect(result.data.decisionTableVerification.linesRead).toBe(0);
        expect(result.data.decisionTableVerification.readError).toBe(
          "permission denied"
        );
      }
    }
  });

  it("accepts outbound network decision diagnostics", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      outboundNetwork: {
        surface: OutboundNetworkSurface.LoopAttachmentDownload,
        decision: OutboundNetworkDecision.Denied,
        reason: OutboundNetworkDecisionReason.AttachmentHostNotAllowed,
        destinationClass: OutboundNetworkDestinationClass.External,
        protocol: "https:",
        hostname: "attacker.example.com",
        port: "443",
        statusCode: 403,
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts bounded desktop update diagnostics", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      desktopUpdate: {
        trigger: "renderer-apply-update",
        status: "downloaded",
        version: "0.14.29",
        percent: 100,
        downloaded: true,
        readyToInstall: true,
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts bounded desktop shutdown diagnostics", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      desktopShutdown: {
        trigger: "shutdown-sequence",
        result: "timed_out",
        phase: "server.stop",
        elapsedMs: 5002,
        duringUpdate: true,
        outerHardExit: false,
      },
    });

    expect(result.success).toBe(true);
  });

  it("maps unknown desktop update and shutdown triggers to a safe value", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      desktopUpdate: {
        trigger: "future-update-trigger",
        status: "downloaded",
      },
      desktopShutdown: {
        trigger: "future-shutdown-trigger",
        result: "failed",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.desktopUpdate?.trigger).toBe(
        DesktopUpdateTrigger.Unknown
      );
      expect(result.data.desktopShutdown?.trigger).toBe(
        DesktopShutdownTrigger.Unknown
      );
    }
  });

  it("accepts install-blocked-read-only-volume and gateway-apply-update triggers as known values", () => {
    for (const trigger of [
      "install-blocked-read-only-volume",
      "gateway-apply-update",
    ]) {
      const result = telemetryDiagnosticsSchema.safeParse({
        desktopUpdate: { trigger, status: "error" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.desktopUpdate?.trigger).toBe(trigger);
      }
    }
  });

  it("accepts absence of ackLatencyMs (optional)", () => {
    const result = telemetryDiagnosticsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects a non-number ackLatencyMs", () => {
    const result = telemetryDiagnosticsSchema.safeParse({
      ackLatencyMs: "fast",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// desktopTelemetryEventSchema — transform behavior
// ---------------------------------------------------------------------------

describe("desktopTelemetryEventSchema", () => {
  it("accepts a valid desktop wire payload", () => {
    const result = desktopTelemetryEventSchema.safeParse(
      validDesktopWirePayload
    );
    expect(result.success).toBe(true);
  });

  it("transforms trace.sessionId to trace.loopSessionId", () => {
    const result = desktopTelemetryEventSchema.safeParse(
      validDesktopWirePayload
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trace.loopSessionId).toBe(VALID_UUID_B);
      expect(result.data.trace.gatewaySessionId).toBe(VALID_UUID_A);
    }
  });

  it("output does not contain a sessionId field in trace (renamed to loopSessionId)", () => {
    const result = desktopTelemetryEventSchema.safeParse(
      validDesktopWirePayload
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect("sessionId" in result.data.trace).toBe(false);
    }
  });

  it("rejects payload with numeric schemaVersion (must be string)", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts payload without gatewaySessionId (desktop before hello-ack)", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      schemaVersion: "1",
      category: TelemetryCategory.JobStarted,
      severity: TelemetrySeverity.Info,
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "",
        operationId: "",
        computeTargetId: "",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts payload without optional trace fields (loopId, jobId, sessionId)", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      schemaVersion: "1",
      category: TelemetryCategory.PreflightBinaryNotFound,
      severity: TelemetrySeverity.Error,
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "cmd-1",
        operationId: "op-1",
        computeTargetId: "target-1",
        gatewaySessionId: VALID_UUID_A,
      },
      message: "claude not found in PATH",
    });
    expect(result.success).toBe(true);
  });

  it("accepts bounded plugin update diagnostics only under diagnostics.pluginUpdate", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.PluginUpdateFailed,
      diagnostics: {
        pluginUpdate: {
          pluginIds: ["code@closedloop-ai"],
          versionsBefore: { "code@closedloop-ai": "1.0.0" },
          versionsAfter: { "code@closedloop-ai": "1.0.0" },
          outcomes: { "code@closedloop-ai": "failed" },
          durationMs: 123,
          command: "claude plugin update",
          scope: "user",
          exitCode: 1,
          failureReason: "command_failed",
          stderrTail: "permission denied",
          ignored: "stripped",
        },
      },
      pluginUpdate: { pluginIds: ["invalid-top-level"] },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.pluginUpdate).toEqual({
        pluginIds: ["code@closedloop-ai"],
        versionsBefore: { "code@closedloop-ai": "1.0.0" },
        versionsAfter: { "code@closedloop-ai": "1.0.0" },
        outcomes: { "code@closedloop-ai": "failed" },
        durationMs: 123,
        command: "claude plugin update",
        scope: "user",
        exitCode: 1,
        failureReason: "command_failed",
        stderrTail: "permission denied",
      });
      expect("pluginUpdate" in result.data).toBe(false);
    }
  });

  it("rejects invalid plugin update outcome values", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.PluginUpdateFailed,
      diagnostics: {
        pluginUpdate: {
          pluginIds: ["code@closedloop-ai"],
          versionsBefore: { "code@closedloop-ai": "1.0.0" },
          versionsAfter: { "code@closedloop-ai": "1.0.0" },
          outcomes: { "code@closedloop-ai": "unknown-outcome" },
          durationMs: 123,
          command: "claude plugin update",
          scope: "user",
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("strips ackLatencyMs from desktop wire payloads (server-only field)", () => {
    // telemetryDiagnosticsSchema (server emission) carries ackLatencyMs, but
    // the desktop wire schema must not — otherwise desktop-origin payloads
    // could masquerade as server ack-latency data. Zod's default .strip
    // behavior drops the field at parse time.
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      diagnostics: { exitCode: 0, ackLatencyMs: 42 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics).toEqual({ exitCode: 0 });
      expect(result.data.diagnostics).not.toHaveProperty("ackLatencyMs");
    }
  });

  it("preserves decision-table verification diagnostics from desktop wire payloads", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.JobDecisionTableVerification,
      diagnostics: {
        decisionTableVerification: reportedDecisionTableVerification,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.decisionTableVerification).toEqual(
        reportedDecisionTableVerification
      );
    }
  });

  it("preserves outbound-network diagnostics from desktop wire payloads", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.DesktopOutboundNetworkDecision,
      diagnostics: {
        outboundNetwork: {
          surface: OutboundNetworkSurface.DeployHealthCheck,
          decision: OutboundNetworkDecision.Allowed,
          reason: OutboundNetworkDecisionReason.Allowed,
          destinationClass: OutboundNetworkDestinationClass.Loopback,
          protocol: "http:",
          hostname: "app.localhost",
          port: "3000",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.outboundNetwork?.hostname).toBe(
        "app.localhost"
      );
    }
  });

  it("accepts the token-cost pricing-miss category and preserves its typed diagnostics", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.TokenCostPricingMiss,
      severity: TelemetrySeverity.Warn,
      diagnostics: {
        tokenCostPricingMiss: {
          model: "some-new-model-v1",
          reason: "unknown_model",
          surface: "synced_session",
          sessionId: "sess-1",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe(TelemetryCategory.TokenCostPricingMiss);
      expect(result.data.diagnostics?.tokenCostPricingMiss).toEqual({
        model: "some-new-model-v1",
        reason: "unknown_model",
        surface: "synced_session",
        sessionId: "sess-1",
      });
    }
  });

  it("preserves outbound-network telemetry with unknown classification values", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.DesktopOutboundNetworkDecision,
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
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.outboundNetwork).toEqual({
        surface: OutboundNetworkSurface.Unknown,
        decision: OutboundNetworkDecision.Unknown,
        reason: OutboundNetworkDecisionReason.Unknown,
        destinationClass: OutboundNetworkDestinationClass.Unknown,
        protocol: "http:",
        hostname: "app.localhost",
        port: "3000",
      });
      expect(JSON.stringify(result.data)).not.toContain("token=secret");
    }
  });

  it("preserves desktop update diagnostics from desktop wire payloads", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.ElectronUpdateFailed,
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
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.desktopUpdate).toEqual({
        trigger: "apply-before-downloaded",
        status: "available",
        version: "0.14.29",
        error: "Update has not finished downloading yet",
        downloaded: false,
        readyToInstall: false,
      });
      expect(JSON.stringify(result.data)).not.toContain("Bearer secret");
    }
  });

  it("preserves desktop shutdown diagnostics from desktop wire payloads", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.DesktopShutdownFailed,
      diagnostics: {
        desktopShutdown: {
          trigger: "outer-hard-exit",
          result: "timed_out",
          phase: "server.stop",
          elapsedMs: 8001,
          duringUpdate: true,
          outerHardExit: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.desktopShutdown).toEqual({
        trigger: "outer-hard-exit",
        result: "timed_out",
        phase: "server.stop",
        elapsedMs: 8001,
        duringUpdate: true,
        outerHardExit: true,
      });
    }
  });

  it("preserves desktop diagnostics when wire triggers are unknown", () => {
    const updateResult = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.ElectronUpdateFailed,
      diagnostics: {
        desktopUpdate: {
          trigger: "future-update-trigger",
          status: "available",
          error: "new updater path failed",
        },
      },
    });
    const shutdownResult = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.DesktopShutdownFailed,
      diagnostics: {
        desktopShutdown: {
          trigger: "future-shutdown-trigger",
          result: "failed",
          phase: "future.phase",
        },
      },
    });

    expect(updateResult.success).toBe(true);
    if (updateResult.success) {
      expect(updateResult.data.diagnostics?.desktopUpdate).toEqual({
        trigger: DesktopUpdateTrigger.Unknown,
        status: "available",
        error: "new updater path failed",
      });
    }

    expect(shutdownResult.success).toBe(true);
    if (shutdownResult.success) {
      expect(shutdownResult.data.diagnostics?.desktopShutdown).toEqual({
        trigger: DesktopShutdownTrigger.Unknown,
        result: "failed",
        phase: "future.phase",
      });
    }
  });

  it("accepts update/shutdown categories when diagnostics are omitted", () => {
    for (const category of [
      TelemetryCategory.ElectronUpdateInitiated,
      TelemetryCategory.ElectronUpdateFailed,
      TelemetryCategory.DesktopShutdownFailed,
    ]) {
      const result = desktopTelemetryEventSchema.safeParse({
        ...validDesktopWirePayload,
        category,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts payload with TelemetryCategory.OnboardingPopupShown", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.OnboardingPopupShown,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe(TelemetryCategory.OnboardingPopupShown);
    }
  });

  it("accepts payload with TelemetryCategory.OnboardingPopupCtaClicked", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.OnboardingPopupCtaClicked,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe(
        TelemetryCategory.OnboardingPopupCtaClicked
      );
    }
  });

  it("accepts payload with TelemetryCategory.OnboardingPopupDismissedSession", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.OnboardingPopupDismissedSession,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe(
        TelemetryCategory.OnboardingPopupDismissedSession
      );
    }
  });

  it("accepts payload with TelemetryCategory.OnboardingPopupDismissedPermanent", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.OnboardingPopupDismissedPermanent,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe(
        TelemetryCategory.OnboardingPopupDismissedPermanent
      );
    }
  });

  it("accepts payload with TelemetryCategory.OnboardingPopupSuppressedAuto", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.OnboardingPopupSuppressedAuto,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe(
        TelemetryCategory.OnboardingPopupSuppressedAuto
      );
    }
  });

  // lifecycle back-compat: desktop clients that pre-date diagnostics.lifecycle
  // must continue to be accepted unchanged (AC-001)
  it("lifecycle back-compat — accepts job.* payload with diagnostics fields present but lifecycle omitted", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.JobStarted,
      diagnostics: {
        exitCode: 0,
        logTail: "job started successfully",
        elapsedMs: 1234,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.exitCode).toBe(0);
      expect(result.data.diagnostics?.logTail).toBe("job started successfully");
      expect(result.data.diagnostics?.elapsedMs).toBe(1234);
      expect(result.data.diagnostics?.lifecycle).toBeUndefined();
    }
  });

  // T-2.2: every canonical LoopCommand value is accepted in lifecycle.command (AC-004)
  it("lifecycle.command — accepts every canonical LoopCommand value", () => {
    expect(KNOWN_LOOP_COMMANDS.size).toBeGreaterThan(0);

    for (const command of KNOWN_LOOP_COMMANDS) {
      const result = desktopTelemetryEventSchema.safeParse({
        ...validDesktopWirePayload,
        category: TelemetryCategory.JobStarted,
        diagnostics: {
          lifecycle: { command },
        },
      });

      expect(
        result.success,
        `expected schema to accept command: ${command}`
      ).toBe(true);
      if (result.success) {
        expect(result.data.diagnostics?.lifecycle?.command).toBe(command);
      }
    }
  });

  // T-2.3: unknown/arbitrary command strings are accepted for forward-compat (AC-002, AC-004)
  it("lifecycle.command — accepts unknown/arbitrary string for forward-compat", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.JobStarted,
      diagnostics: {
        lifecycle: { command: "FUTURE_UNKNOWN_COMMAND" },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.lifecycle?.command).toBe(
        "FUTURE_UNKNOWN_COMMAND"
      );
    }
  });

  // T-2.4: unknown sibling fields alongside command survive parsing via .passthrough() (AC-003, AC-004)
  it("lifecycle — preserves unknown sibling fields via passthrough", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...validDesktopWirePayload,
      category: TelemetryCategory.JobStarted,
      diagnostics: {
        lifecycle: { command: LoopCommand.Execute, unknownField: "value" },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const lifecycle = result.data.diagnostics?.lifecycle as
        | Record<string, unknown>
        | undefined;
      expect(lifecycle?.command).toBe(LoopCommand.Execute);
      expect(lifecycle?.unknownField).toBe("value");
    }
  });

  // T-2.5: round-trip fidelity — full payload with lifecycle.command parses
  // and the complete output matches the expected transformed shape (AC-004)
  it("lifecycle — round-trip fidelity: complete payload with lifecycle.command survives schema parse without stripping", () => {
    const input = {
      schemaVersion: "1",
      category: TelemetryCategory.JobStarted,
      severity: TelemetrySeverity.Info,
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "cmd-1",
        operationId: "op-1",
        computeTargetId: "target-1",
        gatewaySessionId: VALID_UUID_A,
        sessionId: VALID_UUID_B,
      },
      diagnostics: {
        lifecycle: { command: LoopCommand.Execute },
        exitCode: 0,
        elapsedMs: 5000,
      },
      message: "job started",
    };

    const result = desktopTelemetryEventSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        schemaVersion: "1",
        category: TelemetryCategory.JobStarted,
        severity: TelemetrySeverity.Info,
        timestamp: "2024-01-01T00:00:00.000Z",
        trace: {
          commandId: "cmd-1",
          operationId: "op-1",
          computeTargetId: "target-1",
          gatewaySessionId: VALID_UUID_A,
          loopSessionId: VALID_UUID_B,
        },
        diagnostics: {
          lifecycle: { command: LoopCommand.Execute },
          exitCode: 0,
          elapsedMs: 5000,
        },
        message: "job started",
        errorClass: undefined,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// buildDesktopTelemetryPayload — validation, sanitization, and transform
// ---------------------------------------------------------------------------

describe("buildDesktopTelemetryPayload", () => {
  it("returns validation_failed payload when input is invalid", () => {
    const result = buildDesktopTelemetryPayload({
      category: "job.started",
      schemaVersion: "1",
    });

    expect(result.category).toBe(TelemetryCategory.TelemetryValidationFailed);
  });

  it("validation_failed issues only contain path, code, and optionally expected — no received or message", () => {
    const payloadWithSecret = {
      category: "job.started",
      severity: "info",
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "cmd",
        operationId: "op",
        computeTargetId: "target",
        secret: "sk_test_abc123",
      },
    };

    const result = buildDesktopTelemetryPayload(payloadWithSecret);

    expect(result.category).toBe(TelemetryCategory.TelemetryValidationFailed);
    expect(Array.isArray(result.issues)).toBe(true);

    for (const issue of result.issues as Record<string, unknown>[]) {
      const issueKeys = Object.keys(issue);
      expect(issueKeys).not.toContain("message");
      expect(issueKeys).not.toContain("received");
      expect(issueKeys).toContain("path");
      expect(issueKeys).toContain("code");
    }
  });

  it("a secret embedded in trace does not appear in validation_failed payload", () => {
    const SECRET = "sk_test_abc123";
    const result = buildDesktopTelemetryPayload({
      schemaVersion: "1",
      category: "job.started",
      severity: "info",
      timestamp: "2024-01-01T00:00:00.000Z",
      trace: {
        commandId: "cmd",
        operationId: "op",
        computeTargetId: "target",
        gatewaySessionId: "not-a-uuid",
        secret: SECRET,
      },
    });

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("returns correct payload for well-formed input with sessionId→loopSessionId transform", () => {
    const result = buildDesktopTelemetryPayload(validDesktopWirePayload);

    expect(result.category).toBe(TelemetryCategory.JobStarted);
    expect(result.schemaVersion).toBe("1");
    const trace = result.trace as Record<string, unknown>;
    expect(trace.loopSessionId).toBe(VALID_UUID_B);
    // gatewaySessionId is redacted to a stable hash before this payload reaches
    // the log sink; the raw token must never appear in the emitted trace.
    expect(trace.gatewaySessionId).toBe(redactGatewaySessionId(VALID_UUID_A));
    expect(trace.gatewaySessionId).not.toBe(VALID_UUID_A);
    expect(JSON.stringify(result)).not.toContain(VALID_UUID_A);
  });

  it("preserves desktop EXECUTE plan source diagnostics", () => {
    const result = buildDesktopTelemetryPayload({
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
    });

    const diagnostics = result.diagnostics as Record<string, unknown>;
    expect(result.category).toBe(TelemetryCategory.JobPlanSourceResolved);
    expect(diagnostics.planSource).toEqual({
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
    });
  });

  it("preserves desktop decision-table verification diagnostics", () => {
    const result = buildDesktopTelemetryPayload({
      ...validDesktopWirePayload,
      category: TelemetryCategory.JobDecisionTableVerification,
      message: "Decision-table verification aligned",
      diagnostics: {
        decisionTableVerification: reportedDecisionTableVerification,
      },
    });

    const diagnostics = result.diagnostics as Record<string, unknown>;
    expect(result.category).toBe(
      TelemetryCategory.JobDecisionTableVerification
    );
    expect(result.message).toBe("Decision-table verification aligned");
    expect(diagnostics.decisionTableVerification).toEqual(
      reportedDecisionTableVerification
    );
  });

  it("builds outbound-network payload without URL path, query, or credentials", () => {
    const result = buildDesktopTelemetryPayload({
      ...validDesktopWirePayload,
      category: TelemetryCategory.DesktopOutboundNetworkDecision,
      diagnostics: {
        outboundNetwork: {
          surface: OutboundNetworkSurface.LoopAttachmentDownload,
          decision: OutboundNetworkDecision.Denied,
          reason: OutboundNetworkDecisionReason.AttachmentHostNotAllowed,
          destinationClass: OutboundNetworkDestinationClass.External,
          protocol: "https:",
          hostname: "attacker.example.com",
          port: "443",
          path: "/users/123/object.txt",
          query: "X-Amz-Credential=secret",
          rawUrl:
            "https://attacker.example.com/users/123/object.txt?X-Amz-Signature=secret",
        },
      },
    });

    expect(result.category).toBe(
      TelemetryCategory.DesktopOutboundNetworkDecision
    );
    expect(result).toMatchObject({
      diagnostics: {
        outboundNetwork: {
          surface: OutboundNetworkSurface.LoopAttachmentDownload,
          decision: OutboundNetworkDecision.Denied,
          reason: OutboundNetworkDecisionReason.AttachmentHostNotAllowed,
          destinationClass: OutboundNetworkDestinationClass.External,
          protocol: "https:",
          hostname: "attacker.example.com",
          port: "443",
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/users/123");
    expect(serialized).not.toContain("X-Amz-Credential");
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(serialized).not.toContain("secret");
  });

  it("builds outbound-network payload for unknown classification values", () => {
    const result = buildDesktopTelemetryPayload({
      ...validDesktopWirePayload,
      category: TelemetryCategory.DesktopOutboundNetworkDecision,
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
    });

    expect(result.category).toBe(
      TelemetryCategory.DesktopOutboundNetworkDecision
    );
    expect(result).toMatchObject({
      diagnostics: {
        outboundNetwork: {
          surface: OutboundNetworkSurface.Unknown,
          decision: OutboundNetworkDecision.Unknown,
          reason: OutboundNetworkDecisionReason.Unknown,
          destinationClass: OutboundNetworkDestinationClass.Unknown,
          protocol: "http:",
          hostname: "app.localhost",
          port: "3000",
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("telemetry.validation_failed");
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("/private");
  });
});

it("preserves desktop support upload diagnostics", () => {
  const result = buildDesktopTelemetryPayload({
    ...validDesktopWirePayload,
    category: TelemetryCategory.DesktopSupportUpload,
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
  });

  const diagnostics = result.diagnostics as Record<string, unknown>;
  expect(result.category).toBe(TelemetryCategory.DesktopSupportUpload);
  expect(diagnostics.supportUpload).toEqual({
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

it("maps unknown desktop support upload reasons to a bounded value", () => {
  const result = buildDesktopTelemetryPayload({
    ...validDesktopWirePayload,
    category: TelemetryCategory.DesktopSupportUpload,
    diagnostics: {
      supportUpload: {
        outcome: "failed",
        reason:
          "missing upload URL for org-1/loops/loop-1/run-1/support/claude-output.jsonl",
      },
    },
  });

  const diagnostics = result.diagnostics as {
    supportUpload?: { reason?: unknown };
  };
  expect(diagnostics.supportUpload?.reason).toBe(SupportUploadReason.Unknown);
  expect(JSON.stringify(result)).not.toContain("org-1/loops/loop-1");
});

// ---------------------------------------------------------------------------
// sanitizeDesktopTelemetryDiagnostics
// ---------------------------------------------------------------------------

describe("sanitizeDesktopTelemetryDiagnostics", () => {
  it("returns undefined when diagnostics is undefined", () => {
    expect(sanitizeDesktopTelemetryDiagnostics(undefined)).toBeUndefined();
  });

  it("returns diagnostics unchanged when logTail is absent", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({ exitCode: 0 });
    expect(result).toEqual({ exitCode: 0 });
  });

  it("passes through a short logTail with no credential patterns", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting job\nCompleted successfully",
    });
    expect(result?.logTail).toBe("Starting job\nCompleted successfully");
  });

  it("strips lines containing sk_ credential pattern", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting job\nusing sk_live_secret123\nCompleted",
    });
    expect(result?.logTail).not.toContain("sk_live_secret123");
    expect(result?.logTail).toContain("Starting job");
    expect(result?.logTail).toContain("Completed");
  });

  it("strips lines containing token= credential pattern", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\ntoken=abc123xyz\nDone",
    });
    expect(result?.logTail).not.toContain("token=abc123xyz");
    expect(result?.logTail).toContain("Starting");
    expect(result?.logTail).toContain("Done");
  });

  it("strips lines containing password= credential pattern", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\npassword=hunter2\nDone",
    });
    expect(result?.logTail).not.toContain("password=hunter2");
  });

  it("strips lines containing authorization: credential pattern (case-insensitive)", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\nAuthorization: Bearer token123\nDone",
    });
    expect(result?.logTail).not.toContain("Bearer token123");
    expect(result?.logTail).toContain("Starting");
    expect(result?.logTail).toContain("Done");
  });

  it("strips lines with colon-space credential forms missed by the substring list", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail:
        "Starting\npassword: hunter2\nsecret: s3cr3t\napi_key: ak_live_1\nX-Api-Key: xyz789\nDone",
    });
    expect(result?.logTail).not.toContain("hunter2");
    expect(result?.logTail).not.toContain("s3cr3t");
    expect(result?.logTail).not.toContain("ak_live_1");
    expect(result?.logTail).not.toContain("xyz789");
    expect(result?.logTail).toContain("Starting");
    expect(result?.logTail).toContain("Done");
  });

  it("strips lines with provider tokens missed by the substring list", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\nghp_abc123def456\nxoxb-1-2-token\nDone",
    });
    expect(result?.logTail).not.toContain("ghp_abc123def456");
    expect(result?.logTail).not.toContain("xoxb-1-2-token");
    expect(result?.logTail).toContain("Starting");
    expect(result?.logTail).toContain("Done");
  });

  it("strips lines with space-separated token credential forms", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "Starting\ntoken abc123def\nDone",
    });
    expect(result?.logTail).not.toContain("abc123def");
    expect(result?.logTail).toContain("Starting");
    expect(result?.logTail).toContain("Done");
  });

  it("truncates logTail exceeding 4096 bytes", () => {
    const longLine = "a".repeat(5000);
    const result = sanitizeDesktopTelemetryDiagnostics({ logTail: longLine });
    const encoded = new TextEncoder().encode(result?.logTail ?? "");
    expect(encoded.byteLength).toBeLessThanOrEqual(4096);
  });

  it("bounds credential-scan cost for a long credential-free line", () => {
    // A long single line of repeated word/hyphen segments with no credential
    // suffix is the ReDoS shape for CREDENTIAL_RE's nested quantifiers. The
    // pre-truncation + per-line cap must keep this fast and still redact-free.
    const pathological = `${"a-".repeat(200_000)}b`;
    const start = Date.now();
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: pathological,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    const encoded = new TextEncoder().encode(result?.logTail ?? "");
    expect(encoded.byteLength).toBeLessThanOrEqual(4096);
  });

  it("does not truncate logTail that fits within 4096 bytes", () => {
    const shortLog = "short log line\nsecond line";
    const result = sanitizeDesktopTelemetryDiagnostics({ logTail: shortLog });
    expect(result?.logTail).toBe(shortLog);
  });

  it("preserves tokenUsage and exitCode when sanitizing logTail", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      logTail: "clean log",
      exitCode: 1,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result?.exitCode).toBe(1);
    expect(result?.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("sanitizes nested plugin update stderrTail", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      pluginUpdate: {
        pluginIds: ["code@closedloop-ai"],
        versionsBefore: { "code@closedloop-ai": "1.0.0" },
        versionsAfter: { "code@closedloop-ai": "1.0.0" },
        outcomes: { "code@closedloop-ai": "failed" },
        durationMs: 321,
        command: "claude plugin update",
        scope: "user",
        failureReason: "command_failed",
        stderrTail:
          "\u001b[31mError:\u001b[0m update failed\nAuthorization: Bearer secret-token\nclean line",
      },
    });

    expect(result?.pluginUpdate?.stderrTail).toBe(
      "Error: update failed\nclean line"
    );
  });

  it("keeps only descriptor fields for outbound network diagnostics", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
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
        path: "/users/123/object.txt",
      },
    } as never);

    expect(result?.outboundNetwork).toEqual({
      surface: OutboundNetworkSurface.LoopAttachmentDownload,
      decision: OutboundNetworkDecision.Denied,
      reason: OutboundNetworkDecisionReason.AttachmentHostNotAllowed,
      destinationClass: OutboundNetworkDestinationClass.External,
      protocol: "https:",
      hostname: "attacker.example.com",
      port: "443",
    });
    expect(JSON.stringify(result)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(result)).not.toContain("/users/123");
  });

  it("preserves safe loopPerf iteration and pipeline_step commands", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      loopPerf: {
        event: "iteration",
        command: "EXECUTE",
        runId: "run-1",
      },
    });
    expect(result?.loopPerf?.command).toBe("EXECUTE");

    const pipelineStepResult = sanitizeDesktopTelemetryDiagnostics({
      loopPerf: {
        event: "pipeline_step",
        command: "FUTURE_UNKNOWN_COMMAND",
        runId: "run-1",
      },
    });
    expect(pipelineStepResult?.loopPerf?.command).toBe(
      "FUTURE_UNKNOWN_COMMAND"
    );
  });

  it("omits absent loopPerf command and sanitizes unsafe command/rawBytes", () => {
    const absentResult = sanitizeDesktopTelemetryDiagnostics({
      loopPerf: { event: "iteration", runId: "run-1" },
    });
    expect(absentResult?.loopPerf).not.toHaveProperty("command");

    const result = sanitizeDesktopTelemetryDiagnostics({
      loopPerf: {
        event: "parse_failure",
        command: '{"access_token":"hunter2"}',
        rawBytes: `\u0000OPENAI_API_KEY=${"secret".repeat(200)}\u001f`,
      },
    });

    expect(result?.loopPerf?.command).toBe("[redacted]");
    expect(result?.loopPerf?.rawBytes).toBe("[redacted]");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("sanitizes common loopPerf credential key variants", () => {
    const unsafeValues = [
      '{"refresh_token":"secret-value"}',
      "GITHUB_TOKEN=secret-value",
      "OPENAI_API_KEY=secret-value",
      "--access-token secret-value",
      "service_secret: secret-value",
    ];

    for (const value of unsafeValues) {
      const result = sanitizeDesktopTelemetryDiagnostics({
        loopPerf: {
          event: "iteration",
          command: value,
          rawBytes: value,
        },
      });

      expect(result?.loopPerf?.command).toBe("[redacted]");
      expect(result?.loopPerf?.rawBytes).toBe("[redacted]");
    }
  });

  it("strips non-ANSI control chars from safe loopPerf command and rawBytes", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      loopPerf: {
        event: "parse_failure",
        command: "\u0000EXECUTE\u001f",
        rawBytes: "\u0007safe raw bytes\u009f",
      },
    });

    expect(result?.loopPerf?.command).toBe("EXECUTE");
    expect(result?.loopPerf?.rawBytes).toBe("safe raw bytes");
  });

  it("bounds oversized loopPerf command and rawBytes metadata", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      loopPerf: {
        event: "parse_failure",
        command: "A".repeat(200),
        rawBytes: "B".repeat(2000),
      },
    });

    const command = result?.loopPerf?.command;
    const rawBytes = result?.loopPerf?.rawBytes;

    expect(typeof command).toBe("string");
    expect(typeof rawBytes).toBe("string");
    if (typeof command !== "string" || typeof rawBytes !== "string") {
      throw new Error(
        "Expected loopPerf command and rawBytes to remain strings"
      );
    }

    expect(new TextEncoder().encode(command).length).toBeLessThanOrEqual(64);
    expect(new TextEncoder().encode(rawBytes).length).toBeLessThanOrEqual(1024);
  });

  it("keeps non-loopPerf relay rate-limit checks cheap before full telemetry parsing", () => {
    const payload = {
      schemaVersion: "1",
      category: TelemetryCategory.JobStarted,
      severity: TelemetrySeverity.Info,
      timestamp: "2024-01-01T00:00:00.000Z",
      get trace() {
        throw new Error("trace should not be parsed for generic telemetry");
      },
      get diagnostics() {
        throw new Error(
          "diagnostics should not be parsed for generic telemetry"
        );
      },
    };

    expect(isLoopPerfTelemetryRateLimitBypass(payload, "target-1")).toBe(false);
  });

  it("server-side fallback: collapses home-rooted paths in reported decisionTableVerification (version-skewed older client)", () => {
    // An older Desktop build sends absolute, home-rooted paths that never went
    // through the FEA-2702 producer relativization. The server must still strip
    // the OS username before these egress to the sink.
    const result = sanitizeDesktopTelemetryDiagnostics({
      decisionTableVerification: {
        telemetryStatus: "reported",
        telemetryFilePath:
          "/Users/alice/Code/proj/.closedloop-ai/work/decision-table-verifications.jsonl",
        lineNumber: 3,
        timestamp: "2026-05-01T13:20:06.234Z",
        workdir: "/Users/alice/Code/proj/.closedloop-ai/work",
        decisionTablePath: "/home/alice/other-project/decision-table.md",
        finalStatus: "aligned",
        iterations: 3,
        driftKindCounts: { codeDrift: 2, testDrift: 1, planAmbiguity: 0 },
        fixesAttempted: 3,
        parseFailures: 0,
        verifierInvocations: 3,
        phaseDurationMs: 58_921,
      },
    });

    const verification = result?.decisionTableVerification;
    expect(verification?.telemetryStatus).toBe("reported");
    if (verification?.telemetryStatus === "reported") {
      expect(verification.telemetryFilePath).not.toContain("alice");
      expect(verification.workdir).not.toContain("alice");
      expect(verification.decisionTablePath).not.toContain("alice");
      expect(verification.workdir).toBe("~/Code/proj/.closedloop-ai/work");
      expect(verification.decisionTablePath).toBe(
        "~/other-project/decision-table.md"
      );
    }
    expect(JSON.stringify(result)).not.toContain("alice");
  });

  it("server-side fallback: collapses home-rooted path in missing decisionTableVerification readError", () => {
    const result = sanitizeDesktopTelemetryDiagnostics({
      decisionTableVerification: {
        telemetryStatus: "missing",
        telemetryFilePath:
          "/Users/bob/proj/.closedloop-ai/work/decision-table-verifications.jsonl",
        filePresent: true,
        linesRead: 0,
        invalidLines: 0,
        missingReason: "read_error",
        readError:
          "EACCES: permission denied, open '/Users/bob/proj/.closedloop-ai/work/decision-table-verifications.jsonl'",
      },
    });

    const verification = result?.decisionTableVerification;
    expect(verification?.telemetryStatus).toBe("missing");
    if (verification?.telemetryStatus === "missing") {
      expect(verification.telemetryFilePath).not.toContain("bob");
      expect(verification.readError).not.toContain("bob");
    }
    expect(JSON.stringify(result)).not.toContain("bob");
  });
});

// ---------------------------------------------------------------------------
// buildValidationFailedPayload() cross-cutting guard
// ---------------------------------------------------------------------------

describe("buildValidationFailedPayload() cross-cutting guard", () => {
  it("(a) SafeZodIssue payload structure — issues contain only path/code/expected, category is TelemetryValidationFailed", () => {
    const issues = [
      {
        path: ["trace", "gatewaySessionId"],
        code: "invalid_string",
        expected: "uuid",
      },
      { path: ["severity"], code: "invalid_type" },
    ];

    const result = buildValidationFailedPayload(
      TelemetryCategory.CommandQueued,
      issues
    );

    expect(result.category).toBe(TelemetryCategory.TelemetryValidationFailed);
    expect(result.failedCategory).toBe(TelemetryCategory.CommandQueued);
    expect(Array.isArray(result.issues)).toBe(true);

    for (const issue of result.issues as Record<string, unknown>[]) {
      const keys = Object.keys(issue);
      expect(keys).toContain("path");
      expect(keys).toContain("code");
      expect(keys).not.toContain("message");
      expect(keys).not.toContain("received");
      // "expected" may or may not be present but no other keys are allowed
      for (const key of keys) {
        expect(["path", "code", "expected"]).toContain(key);
      }
    }
  });

  it("(b) SAFE_CATEGORY_RE edge cases — unsafe values produce undefined failedCategory", () => {
    // Path traversal → rejected
    const resultTraversal = buildValidationFailedPayload("../etc/passwd", []);
    expect(resultTraversal.failedCategory).toBeUndefined();

    // 65-char string → rejected (max is 64)
    const longStr = "a".repeat(65);
    const resultLong = buildValidationFailedPayload(longStr, []);
    expect(resultLong.failedCategory).toBeUndefined();

    // null → rejected
    const resultNull = buildValidationFailedPayload(null, []);
    expect(resultNull.failedCategory).toBeUndefined();

    // Valid dotted category → accepted
    const resultValid = buildValidationFailedPayload("custom.test", []);
    expect(resultValid.failedCategory).toBe("custom.test");
  });

  it("(c) non-object rawEvent inputs to buildDesktopTelemetryPayload return validation_failed without throwing", () => {
    const inputs: unknown[] = [null, undefined, "string", 42, []];

    for (const input of inputs) {
      const result = buildDesktopTelemetryPayload(input);
      expect(result.category).toBe(TelemetryCategory.TelemetryValidationFailed);
      expect(result).not.toHaveProperty("failedCategory");
    }
  });
});

// ---------------------------------------------------------------------------
// emitCommandLifecycleEvent() validation failure paths
// ---------------------------------------------------------------------------

describe("emitCommandLifecycleEvent() validation failure paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Observe the validation-failed emission at the Datadog HTTP boundary. This
  // exercises the full pipeline — emitter → log.warn → buildEntry → flush —
  // and verifies severity routing (`level: "warn"`) alongside payload content.
  // emitter.ts binds `log` at module load, so each test re-imports both
  // emitter and log via importModuleWithFetch so they share the same fresh
  // module graph.

  it("(a) invalid trace — flushes validation_failed with level=warn and no secrets", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    // Populate version + git_sha so log.ts's module-load fallback warnings
    // do not enqueue and displace the validation_failed entry at body[0].
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const emitter = await importModuleWithFetch(
      fetchMock,
      () => import("../telemetry/emitter")
    );
    const { log: freshLog } = await import("../log");

    emitter.emitCommandLifecycleEvent(
      TelemetryCategory.CommandQueued,
      {} as TelemetryTraceContext
    );
    await freshLog.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ level: string; message: string }>(
      fetchMock
    );
    expect(body[0].level).toBe("warn");

    const parsed = JSON.parse(body[0].message) as Record<string, unknown>;
    expect(parsed.category).toBe(TelemetryCategory.TelemetryValidationFailed);
    expect(parsed.failedCategory).toBe(TelemetryCategory.CommandQueued);

    const serialized = JSON.stringify(body[0]);
    expect(serialized).not.toContain("sk_");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("authorization");
  });

  it("(b) valid trace + invalid diagnostics — flushes validation_failed with failedCategory", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    // Populate version + git_sha so log.ts's module-load fallback warnings
    // do not enqueue and displace the validation_failed entry at body[0].
    vi.stubEnv("RELEASE_VERSION", "1.0.0");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "testsha");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const emitter = await importModuleWithFetch(
      fetchMock,
      () => import("../telemetry/emitter")
    );
    const { log: freshLog } = await import("../log");

    emitter.emitCommandLifecycleEvent(
      TelemetryCategory.CommandQueued,
      validTraceContext,
      {
        diagnostics: null as any,
      }
    );
    await freshLog.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = parseFlushedBody<{ level: string; message: string }>(
      fetchMock
    );
    expect(body[0].level).toBe("warn");

    const parsed = JSON.parse(body[0].message) as Record<string, unknown>;
    expect(parsed.category).toBe(TelemetryCategory.TelemetryValidationFailed);
    expect(parsed.failedCategory).toBe(TelemetryCategory.CommandQueued);
  });
});
