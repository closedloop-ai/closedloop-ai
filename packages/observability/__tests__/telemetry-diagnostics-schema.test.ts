import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { decisionTableVerificationDiagnosticsSchema } from "../telemetry/decision-table-verification";
import {
  DesktopShutdownTrigger,
  DesktopUpdateTrigger,
  desktopUpdateDiagnosticsSchema,
} from "../telemetry/desktop-lifecycle-triggers";
import {
  OutboundNetworkDecision,
  OutboundNetworkDecisionReason,
  OutboundNetworkDestinationClass,
  OutboundNetworkSurface,
  outboundNetworkDiagnosticsSchema,
} from "../telemetry/outbound-network";
import { telemetryDiagnosticsSchema } from "../telemetry/schema";
import {
  missingDecisionTableVerification,
  reportedDecisionTableVerification,
} from "./decision-table-verification-fixtures";

// ---------------------------------------------------------------------------
// telemetryDiagnosticsSchema
// ---------------------------------------------------------------------------

describe("telemetryDiagnosticsSchema", () => {
  it("requires each targeted schema shape to cover its Desktop producer keys", () => {
    const keysCovered = {
      outboundNetwork: outboundNetworkDiagnosticsSchema.shape,
      desktopUpdate: desktopUpdateDiagnosticsSchema.shape,
      decisionTableVerificationReported:
        decisionTableVerificationDiagnosticsSchema.options[0].shape,
      decisionTableVerificationReportedDriftKindCounts:
        decisionTableVerificationDiagnosticsSchema.options[0].shape
          .driftKindCounts.shape,
      decisionTableVerificationMissing:
        decisionTableVerificationDiagnosticsSchema.options[1].shape,
    } satisfies {
      outboundNetwork: Record<OutboundNetworkDiagnosticsKey, z.ZodTypeAny>;
      desktopUpdate: Record<DesktopUpdateDiagnosticsKey, z.ZodTypeAny>;
      decisionTableVerificationReported: Record<
        DecisionTableVerificationRecordDiagnosticsKey,
        z.ZodTypeAny
      >;
      decisionTableVerificationReportedDriftKindCounts: Record<
        DecisionTableVerificationDriftKindCountsKey,
        z.ZodTypeAny
      >;
      decisionTableVerificationMissing: Record<
        DecisionTableVerificationMissingDiagnosticsKey,
        z.ZodTypeAny
      >;
    };

    expect(Object.keys(keysCovered)).toHaveLength(5);
  });

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
        expect(result.data.decisionTableVerification.invalidLines).toBe(0);
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
    if (result.success) {
      expect(result.data.outboundNetwork?.statusCode).toBe(403);
    }
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
    if (result.success) {
      expect(result.data.desktopUpdate?.percent).toBe(100);
    }
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

/**
 * ISS-8082 — the key sets the three Desktop producer contracts emit, mirrored
 * here rather than imported.
 *
 * `../telemetry/schema.ts` states the convention for this boundary: a Desktop
 * declaration is mirrored as literals in this package, never imported. An
 * import would also put this guard outside Turbo's reach — `@repo/observability`
 * declares no dependency on `apps/desktop`, so its `typecheck` and `test` inputs
 * are package-scoped and a producer-only edit would restore their cache without
 * ever recompiling the guard below.
 *
 * Producers, all in `apps/desktop/src/main/telemetry/telemetry-protocol.ts`:
 * `OutboundNetworkDiagnostics`, `DesktopUpdateDiagnostics`, and BOTH arms of
 * `DecisionTableVerificationTelemetryDiagnostics` plus the nested
 * `DecisionTableVerificationDriftKindCounts`. Every arm of a discriminated
 * union needs its own entry: guarding one arm says nothing about its sibling,
 * and a nested object is a separate `z.object` that strips on its own.
 *
 * What the guard pins is one direction only: a key deleted from one of these
 * ingest schemas stops satisfying the `Record` and fails `tsc`, instead of
 * reaching Zod's default strip and silently dropping the producer's value. It
 * does NOT pin the reverse — a key added to a producer and to this list without
 * the schema following is caught by the `satisfies`, but a key added to a
 * producer alone is not visible from this package at all.
 */
type OutboundNetworkDiagnosticsKey =
  | "surface"
  | "decision"
  | "reason"
  | "destinationClass"
  | "protocol"
  | "hostname"
  | "port"
  | "statusCode";

type DesktopUpdateDiagnosticsKey =
  | "trigger"
  | "status"
  | "version"
  | "percent"
  | "error"
  | "downloaded"
  | "readyToInstall";

type DecisionTableVerificationRecordDiagnosticsKey =
  | "telemetryStatus"
  | "telemetryFilePath"
  | "lineNumber"
  | "timestamp"
  | "workdir"
  | "decisionTablePath"
  | "finalStatus"
  | "iterations"
  | "driftKindCounts"
  | "fixesAttempted"
  | "parseFailures"
  | "verifierInvocations"
  | "phaseDurationMs";

type DecisionTableVerificationDriftKindCountsKey =
  | "codeDrift"
  | "testDrift"
  | "planAmbiguity";

type DecisionTableVerificationMissingDiagnosticsKey =
  | "telemetryStatus"
  | "telemetryFilePath"
  | "filePresent"
  | "linesRead"
  | "invalidLines"
  | "missingReason"
  | "sinceIso"
  | "readError";
