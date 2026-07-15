import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { DESKTOP_ANALYTICS_STRING_MAX_LENGTH } from "@repo/api/src/types/desktop-analytics";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { DesktopAnalyticsEvent } from "../src/main/cloud-protocol.js";
import { Observability } from "../src/main/observability.js";
import type { TelemetryCategory } from "../src/main/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry-service.js";
import { validateOutboundUrlForSurface } from "../src/server/outbound-url-policy.js";

type AnalyticsEvent = Omit<
  DesktopAnalyticsEvent,
  "protocolVersion" | "messageId" | "timestamp"
>;

const _queueStatsCategoryCheck: TelemetryCategory = "queue.stats_changed";
const _desktopPopUnavailableCategoryCheck: TelemetryCategory =
  "desktop_pop.unavailable";
const _outboundNetworkDecisionCategoryCheck: TelemetryCategory =
  "desktop.outbound_network_decision";
const _jobPlanSourceResolvedCategoryCheck: TelemetryCategory =
  "job.plan_source_resolved";
const _jobDecisionTableVerificationCategoryCheck: TelemetryCategory =
  "job.decision_table_verification";
afterEach(async () => {
  await Observability.shutdown();
  Observability.reset();
  mock.restoreAll();
});

describe("Observability", () => {
  test("static facade methods call telemetry backend", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.commandTimedOut("cmd-1", "GENERATE_PRD");

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "command.timeout");
    assert.equal(telemetryEvents[0].severity, "error");
    assert.equal(telemetryEvents[0].trace?.commandId, "cmd-1");
    assert.equal(telemetryEvents[0].trace?.operationId, "GENERATE_PRD");
  });

  test("product analytics events use the socket transport with common desktop properties", () => {
    const analyticsEvents: AnalyticsEvent[] = [];
    Observability.init({
      telemetrySend: () => {},
      analytics: {
        send: (event) => analyticsEvents.push(event),
        flush: async () => {},
      },
      desktopClientVersion: "0.15.3",
    });

    Observability.setTargetId("target-123");
    Observability.commandCompleted("cmd-1", "GENERATE_PRD", 1234);

    assert.equal(analyticsEvents.length, 1);
    assert.equal(analyticsEvents[0].event, "command_completed");
    assert.equal(analyticsEvents[0].properties?.command_id, "cmd-1");
    assert.equal(analyticsEvents[0].properties?.operation_type, "GENERATE_PRD");
    assert.equal(analyticsEvents[0].properties?.latency_ms, 1234);
    assert.equal(
      analyticsEvents[0].properties?.desktop_client_version,
      "0.15.3"
    );
    assert.equal(analyticsEvents[0].properties?.platform, process.platform);
    assert.equal(
      "compute_target_id" in (analyticsEvents[0].properties ?? {}),
      false
    );
    assert.equal(
      "organization_id" in (analyticsEvents[0].properties ?? {}),
      false
    );
  });

  test("job lifecycle events only go to telemetry", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    const analyticsEvents: AnalyticsEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
      analytics: {
        send: (event) => analyticsEvents.push(event),
        flush: async () => {},
      },
    });

    Observability.jobStarted("cmd-1", "GENERATE_PRD", "loop-1", 12_345);

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.started");
    assert.equal(analyticsEvents.length, 0);
  });

  test("jobStarted threads command into diagnostics.lifecycle.command", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobStarted(
      "cmd-1",
      "symphony_loop",
      "loop-1",
      12_345,
      LoopCommand.Execute
    );

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.started");
    assert.equal(
      telemetryEvents[0].diagnostics?.lifecycle?.command,
      LoopCommand.Execute
    );
  });

  test("jobStarted without command does not set diagnostics.lifecycle.command", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobStarted("cmd-1", "symphony_loop", "loop-1", 12_345);

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.started");
    assert.equal(telemetryEvents[0].diagnostics, undefined);
  });

  test("jobCompleted threads command into diagnostics.lifecycle.command", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobCompleted(
      "cmd-1",
      "symphony_loop",
      "loop-1",
      undefined,
      undefined,
      LoopCommand.Plan
    );

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.completed");
    assert.equal(
      telemetryEvents[0].diagnostics?.lifecycle?.command,
      LoopCommand.Plan
    );
  });

  test("jobCompleted merges command into existing diagnostics.lifecycle", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobCompleted(
      "cmd-1",
      "symphony_loop",
      "loop-1",
      { tokenUsage: { inputTokens: 10, outputTokens: 20 } },
      undefined,
      LoopCommand.Execute
    );

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.completed");
    assert.equal(
      telemetryEvents[0].diagnostics?.lifecycle?.command,
      LoopCommand.Execute
    );
    assert.equal(telemetryEvents[0].diagnostics?.tokenUsage?.inputTokens, 10);
  });

  test("jobFailed threads command into diagnostics.lifecycle.command", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobFailed(
      "cmd-1",
      "symphony_loop",
      "loop-1",
      1,
      undefined,
      undefined,
      LoopCommand.Execute
    );

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.failed");
    assert.equal(
      telemetryEvents[0].diagnostics?.lifecycle?.command,
      LoopCommand.Execute
    );
  });

  test("jobFailed without command does not set diagnostics.lifecycle.command", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobFailed("cmd-1", "symphony_loop", "loop-1", 1);

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.failed");
    assert.equal(telemetryEvents[0].diagnostics?.lifecycle, undefined);
  });

  test("jobCancelled threads command into diagnostics.lifecycle.command", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobCancelled(
      "cmd-1",
      "symphony_loop",
      "loop-1",
      0,
      undefined,
      undefined,
      LoopCommand.Plan
    );

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.cancelled");
    assert.equal(
      telemetryEvents[0].diagnostics?.lifecycle?.command,
      LoopCommand.Plan
    );
  });

  test("jobCancelled without command does not set diagnostics.lifecycle.command", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobCancelled("cmd-1", "symphony_loop", "loop-1", 0);

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.cancelled");
    assert.equal(telemetryEvents[0].diagnostics?.lifecycle, undefined);
  });

  test("connection lifecycle emits telemetry and server-relayed analytics", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    const analyticsEvents: AnalyticsEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
      analytics: {
        send: (event) => analyticsEvents.push(event),
        flush: async () => {},
      },
      desktopClientVersion: "0.15.3",
    });

    Observability.connectionEstablished("target-1", "production");
    Observability.reconnectionResumed("relay_resumed", 2);
    Observability.connectionDegraded("temporary relay error");
    Observability.connectionLost();

    assert.deepEqual(
      telemetryEvents.map((event) => event.category),
      [
        "connection.established",
        "connection.reconnection_resumed",
        "connection.degraded",
        "connection.lost",
      ]
    );
    assert.deepEqual(
      analyticsEvents.map((event) => event.event),
      [
        "desktop_connection_established",
        "desktop_reconnection_resumed",
        "desktop_connection_degraded",
        "desktop_connection_lost",
      ]
    );
    assert.equal(analyticsEvents[0].properties?.environment, "production");
    assert.deepEqual(analyticsEvents[0].properties, {
      environment: "production",
      desktop_client_version: "0.15.3",
      platform: process.platform,
    });
  });

  test("over-long analytics string properties are truncated to the cloud cap instead of dropping the event", () => {
    const analyticsEvents: AnalyticsEvent[] = [];
    Observability.init({
      telemetrySend: () => {},
      analytics: {
        send: (event) => analyticsEvents.push(event),
        flush: async () => {},
      },
      desktopClientVersion: "0.15.3",
    });

    const overLongError = "x".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH + 500);
    Observability.connectionDegraded(overLongError);

    assert.equal(analyticsEvents.length, 1);
    const errorProperty = analyticsEvents[0].properties?.error;
    assert.equal(typeof errorProperty, "string");
    assert.equal(
      (errorProperty as string).length,
      DESKTOP_ANALYTICS_STRING_MAX_LENGTH
    );
    assert.equal(
      errorProperty,
      overLongError.slice(0, DESKTOP_ANALYTICS_STRING_MAX_LENGTH)
    );
  });

  test("non-finite analytics number properties are coerced to null instead of dropping the event", () => {
    const analyticsEvents: AnalyticsEvent[] = [];
    Observability.init({
      telemetrySend: () => {},
      analytics: {
        send: (event) => analyticsEvents.push(event),
        flush: async () => {},
      },
      desktopClientVersion: "0.15.3",
    });

    // NaN arises when time_to_resolve_ms is computed from a missing/malformed
    // createdAt (approval-store.ts); the cloud's z.number().finite() would
    // otherwise reject the whole event.
    Observability.approvalResolved("GENERATE_PRD", "granted", Number.NaN);

    assert.equal(analyticsEvents.length, 1);
    assert.equal(analyticsEvents[0].properties?.time_to_resolve_ms, null);
    assert.equal(analyticsEvents[0].properties?.outcome, "granted");
  });

  test("approval, plugin, sandbox, and health check events use product analytics only where expected", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    const analyticsEvents: AnalyticsEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
      analytics: {
        send: (event) => analyticsEvents.push(event),
        flush: async () => {},
      },
    });

    Observability.approvalRequested("GENERATE_PRD", "cmd-1");
    Observability.approvalResolved("GENERATE_PRD", "granted", 5000, "cmd-1");
    Observability.pluginUpdateAttempted({
      pluginIds: ["code"],
      versionsBefore: { code: "1.0.0" },
      versionsAfter: { code: "1.0.0" },
      outcomes: { code: "success" },
      durationMs: 200,
      command: "claude plugin update",
      scope: "user",
    });
    Observability.pluginUpdateFailed({
      pluginIds: ["code", "github"],
      versionsBefore: { code: "1.0.0", github: "1.0.0" },
      versionsAfter: { code: "1.0.0", github: "1.0.0" },
      outcomes: { code: "failed", github: "skipped" },
      durationMs: 300,
      command: "claude plugin update",
      scope: "user",
      failureReason: "manifest_unavailable",
    });
    Observability.sandboxBlocked("path_denied");
    Observability.healthCheckResult({
      id: "claude-cli",
      passed: false,
      error: "Not found",
      debug: { errorCode: "missing_binary" },
    });

    assert.deepEqual(
      analyticsEvents.map((event) => event.event),
      [
        "approval_requested",
        "approval_resolved",
        "plugin_update_attempted",
        "plugin_update_failed",
        "sandbox_blocked_operation",
        "healthcheck.failure_detected",
      ]
    );
    assert.equal(
      telemetryEvents.some(
        (event) => event.category === "plugin_update.failed"
      ),
      true
    );
    assert.equal(
      telemetryEvents.some(
        (event) => event.category === "healthcheck.failure_detected"
      ),
      true
    );
  });

  test("shutdown flushes the analytics transport with a bounded timeout", async () => {
    const flushCalls: Array<{ timeoutMs: number }> = [];
    Observability.init({
      telemetrySend: () => {},
      analytics: {
        send: () => {},
        flush: async (options) => {
          flushCalls.push(options);
        },
      },
    });

    await Observability.shutdown();

    assert.deepEqual(flushCalls, [{ timeoutMs: 1500 }]);
  });

  test("no-op initialization remains safe", () => {
    Observability.initNoOp();

    assert.doesNotThrow(() =>
      Observability.commandInitiated("cmd-1", "GENERATE_PRD")
    );
    assert.doesNotThrow(() =>
      Observability.commandStarted("cmd-1", "GENERATE_PRD")
    );
    assert.doesNotThrow(() =>
      Observability.commandCompleted("cmd-1", "GENERATE_PRD", 100)
    );
  });

  test("queue stats remain telemetry-only", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    const analyticsEvents: AnalyticsEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
      analytics: {
        send: (event) => analyticsEvents.push(event),
        flush: async () => {},
      },
    });

    Observability.queueStatsChanged(3, 7);

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "queue.stats_changed");
    assert.equal(analyticsEvents.length, 0);
  });

  test("outbound network decisions emit descriptor-only telemetry", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    const signedUrl =
      "https://bucket.s3.us-east-1.amazonaws.com/users/123/report.txt" +
      "?X-Amz-Credential=AKIASECRET&X-Amz-Signature=signature-secret";
    const decision = validateOutboundUrlForSurface(
      "loop_attachment_download",
      signedUrl
    );
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.outboundNetworkDecision(decision.diagnostics);

    assert.equal(telemetryEvents.length, 1);
    assert.equal(
      telemetryEvents[0].category,
      "desktop.outbound_network_decision"
    );
    assert.equal(telemetryEvents[0].severity, "info");
    assert.deepEqual(
      telemetryEvents[0].diagnostics?.outboundNetwork,
      decision.diagnostics
    );

    const serialized = JSON.stringify(telemetryEvents[0]);
    assert.equal(serialized.includes("users/123"), false);
    assert.equal(serialized.includes("report.txt"), false);
    assert.equal(serialized.includes("X-Amz-Credential"), false);
    assert.equal(serialized.includes("X-Amz-Signature"), false);
    assert.equal(serialized.includes("AKIASECRET"), false);
    assert.equal(serialized.includes("signature-secret"), false);
    assert.equal(serialized.includes("Authorization"), false);
  });

  test("support upload lifecycle emits direct diagnostics", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.supportUploadLifecycle({
      outcome: "failed",
      loopId: "loop-1",
      s3StateKeySuffix: "state.json",
      attemptedLogicalNames: ["stdout", "stderr"],
      attemptedUploadedNames: ["stdout.txt"],
      reason: "put_http_error",
      uploadedCount: 1,
      durationMs: 250,
    });

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "desktop.support_upload");
    assert.equal(telemetryEvents[0].severity, "warn");
    assert.equal(telemetryEvents[0].trace?.loopId, "loop-1");
    assert.equal(telemetryEvents[0].trace?.jobId, "loop-1");
    assert.deepEqual(telemetryEvents[0].diagnostics?.supportUpload, {
      outcome: "failed",
      loopId: "loop-1",
      s3StateKeySuffix: "state.json",
      attemptedLogicalNames: ["stdout", "stderr"],
      attemptedUploadedNames: ["stdout.txt"],
      reason: "put_http_error",
      uploadedCount: 1,
      durationMs: 250,
    });
  });

  test("job plan source resolution emits direct diagnostics", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    const planSource = {
      source: "raw-artifact" as const,
      rawPlanPayload: true,
      rawPlanAligned: true,
      localPlanJsonPresent: true,
      localPlanJsonAligned: true,
      importedPlanFileStaged: false,
      closedLoopPlanFileSet: true,
      planArtifactContentLength: 1024,
      rawPlanContentLength: 1024,
      planArtifactContentHash: "plan-hash",
      rawPlanContentHash: "raw-hash",
    };
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.jobPlanSourceResolved(
      "cmd-1",
      "EXECUTE",
      "loop-1",
      planSource
    );

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "job.plan_source_resolved");
    assert.equal(telemetryEvents[0].severity, "info");
    assert.equal(telemetryEvents[0].trace?.commandId, "cmd-1");
    assert.equal(telemetryEvents[0].trace?.operationId, "EXECUTE");
    assert.equal(telemetryEvents[0].trace?.loopId, "loop-1");
    assert.equal(telemetryEvents[0].trace?.jobId, "loop-1");
    assert.deepEqual(telemetryEvents[0].diagnostics?.planSource, planSource);
  });

  test("telemetry emitter facade forwards events", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.getTelemetryEmitter().emit({
      severity: "info",
      category: "job.decision_table_verification",
      message: "Decision table aligned",
      trace: { commandId: "cmd-1", operationId: "EXECUTE", loopId: "loop-1" },
      diagnostics: {
        decisionTableVerification: {
          telemetryStatus: "reported",
          telemetryFilePath: "/tmp/decision-table-verifications.jsonl",
          lineNumber: 7,
          timestamp: "2026-05-12T00:00:00.000Z",
          workdir: "/tmp/work",
          decisionTablePath: ".closedloop-ai/decision-tables/PLN-536.md",
          finalStatus: "aligned",
          iterations: 1,
          driftKindCounts: {
            codeDrift: 0,
            testDrift: 0,
            planAmbiguity: 0,
          },
          fixesAttempted: 0,
          parseFailures: 0,
          verifierInvocations: 1,
          phaseDurationMs: 25,
        },
      },
    });

    assert.equal(telemetryEvents.length, 1);
    assert.equal(
      telemetryEvents[0].category,
      "job.decision_table_verification"
    );
    assert.equal(telemetryEvents[0].message, "Decision table aligned");
    assert.equal(
      telemetryEvents[0].diagnostics?.decisionTableVerification
        ?.telemetryStatus,
      "reported"
    );
  });

  test("telemetry facade emission never throws", () => {
    Observability.init({
      telemetrySend: () => {
        throw new Error("transport unavailable");
      },
    });

    assert.doesNotThrow(() => {
      Observability.commandInitiated("cmd-1", "GENERATE_PRD");
    });
  });

  test("tokenCostPricingMiss emits a warn event with typed diagnostics", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
      desktopClientVersion: "0.16.67-test",
    });

    Observability.tokenCostPricingMiss({
      model: "some-new-model-v1",
      surface: "synced_session",
      sessionId: "sess-1",
      resolveReason: () => "unknown_model",
    });

    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].category, "token_cost.pricing_miss");
    assert.equal(telemetryEvents[0].severity, "warn");
    assert.equal(
      telemetryEvents[0].trace?.desktopClientVersion,
      "0.16.67-test"
    );
    assert.deepEqual(telemetryEvents[0].diagnostics?.tokenCostPricingMiss, {
      model: "some-new-model-v1",
      reason: "unknown_model",
      surface: "synced_session",
      sessionId: "sess-1",
    });
  });

  test("tokenCostPricingMiss omits desktop version when unavailable", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    Observability.tokenCostPricingMiss({
      model: "some-new-model-v2",
      surface: "synced_session",
      resolveReason: () => "unknown_model",
    });

    assert.equal(telemetryEvents.length, 1);
    assert.equal(
      "desktopClientVersion" in (telemetryEvents[0].trace ?? {}),
      false
    );
  });

  test("tokenCostPricingMiss deduplicates per distinct model and defers reason resolution", () => {
    const telemetryEvents: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => telemetryEvents.push(event),
    });

    let reasonResolves = 0;
    const emit = (model: string) =>
      Observability.tokenCostPricingMiss({
        model,
        surface: "branch_projection",
        resolveReason: () => {
          reasonResolves += 1;
          return "no_match";
        },
      });

    emit("model-a");
    emit("model-a"); // deduped — must not emit or resolve a reason again
    emit("model-b");

    // NOTE: couples to the model-keyed dedup policy in
    // Observability.tokenCostPricingMiss — update if that key changes.
    assert.equal(telemetryEvents.length, 2);
    assert.equal(reasonResolves, 2);
    assert.deepEqual(
      telemetryEvents.map(
        (event) => event.diagnostics?.tokenCostPricingMiss?.model
      ),
      ["model-a", "model-b"]
    );
  });
});
