import type { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { DESKTOP_ANALYTICS_STRING_MAX_LENGTH } from "@repo/api/src/types/desktop-analytics";
import type { TokenCostNotPricedReason } from "../shared/token-cost.js";
import type { AgentSessionSyncTelemetryEvent } from "./agent-session-sync-service.js";
import type {
  DesktopAnalyticsEvent,
  DesktopAnalyticsEventName,
} from "./cloud-protocol.js";
import type {
  DesktopShutdownDiagnostics,
  DesktopUpdateDiagnostics,
  ExecutePlanSourceDiagnostics,
  OutboundNetworkDiagnostics,
  PluginUpdateDiagnostics,
  StoreIntegrityDiagnostics,
  SupportUploadDiagnostics,
  TelemetryCategory,
  TelemetryDiagnostics,
  TelemetryEmitter,
  TelemetrySeverity,
  TelemetryTraceContext,
  TokenCostPricingMissSurface,
} from "./telemetry-protocol.js";
import {
  type EnrichedTelemetryEvent,
  TelemetryService,
} from "./telemetry-service.js";

export type ObservabilityOptions = {
  telemetrySend: (event: EnrichedTelemetryEvent) => void;
  analytics?: ProductAnalyticsTransport;
  desktopClientVersion?: string;
};

export type ProductAnalyticsTransport = {
  send: (
    event: Omit<
      DesktopAnalyticsEvent,
      "protocolVersion" | "messageId" | "timestamp"
    >
  ) => void;
  flush: (options: { timeoutMs: number }) => Promise<void>;
};

type HealthCheckTelemetryInput = {
  id: string;
  passed: boolean;
  error?: string;
  debug?: {
    errorCode?: string;
    stderr?: string;
    resolvedPath?: string;
    shell?: string;
    platform?: NodeJS.Platform;
    foundAt?: string[];
  };
};

export class Observability {
  private static telemetry: TelemetryService | null = null;
  private static analytics: ProductAnalyticsTransport | null = null;
  private static desktopClientVersion = "";

  // FEA-1969 — dedup set for token-cost pricing-miss events. Bounds telemetry
  // volume: the costing layers run per-row on every branch read/projection, so
  // an undeduped emit would flood the relay. Keyed per `tokenCostPricingMiss`.
  private static readonly pricingMissSeen = new Set<string>();

  // Checks for which healthcheck telemetry is emitted. Extend this allowlist in future PRs.
  private static readonly HEALTH_CHECK_TELEMETRY_IDS = new Set(["claude-cli"]);
  // Volume math: one stuck user + 30-second poll = ~120 polls/hour.
  // This design emits: 1x failure_detected on first sighting, then
  // 7x failure_persistent over an 8-hour session. Negligible Datadog volume.
  // Clock-backward: negative delta < HEARTBEAT_MS -> heartbeat skipped (correct).
  // App restart: state is memory-only; re-launch re-emits failure_detected (correct).
  private static readonly HEARTBEAT_MS = 60 * 60 * 1000; // 1 hour

  private static healthCheckState = new Map<
    string,
    {
      lastState: "passing" | "failing";
      lastErrorCode?: string;
      lastEmittedAt: number;
    }
  >();

  // FEA-1999 — cadence state for the SQLite store integrity probe. Memory-only
  // (re-launch re-emits the first signal), mirroring `healthCheckState`. Bounds
  // Datadog volume: a failure emits once on detection (or when the affected
  // object set changes), re-emits only on the heartbeat while it persists, and a
  // recovery / first-healthy probe emits one clean signal — repeated identical
  // states are suppressed.
  private static storeIntegrityState: {
    lastState: "healthy" | "failing";
    lastIssueKey: string;
    lastEmittedAt: number;
    emittedHealthy: boolean;
  } | null = null;

  static init(options: ObservabilityOptions): void {
    Observability.telemetry = new TelemetryService({
      sendTelemetry: options.telemetrySend,
    });
    Observability.analytics = options.analytics ?? null;
    Observability.desktopClientVersion = options.desktopClientVersion ?? "";
    Observability.healthCheckState.clear();
    Observability.storeIntegrityState = null;
  }

  static initNoOp(): void {
    Observability.init({ telemetrySend: () => {} });
  }

  static reset(): void {
    Observability.telemetry = null;
    Observability.analytics = null;
    Observability.desktopClientVersion = "";
    Observability.healthCheckState.clear();
    Observability.pricingMissSeen.clear();
    Observability.storeIntegrityState = null;
  }

  static async shutdown(): Promise<void> {
    await Observability.analytics?.flush({ timeoutMs: 1500 });
  }

  // --- Context injection ---

  static setTargetId(id: string): void {
    Observability.telemetry?.setTargetId(id);
  }

  static setGatewaySessionId(id: string): void {
    Observability.telemetry?.setGatewaySessionId(id);
  }

  static getTelemetryEmitter(): TelemetryEmitter {
    return {
      emit(event) {
        Observability.telemetry?.emit(event);
      },
    };
  }

  // --- Command lifecycle ---

  static commandInitiated(commandId: string, operationId: string): void {
    Observability.emitTelemetry(
      "info",
      "command.initiated",
      "Command initiated",
      {
        commandId,
        operationId,
      }
    );
    Observability.captureAnalytics("command_initiated", {
      command_id: commandId,
      operation_type: operationId,
    });
  }

  static commandStarted(commandId: string, operationId: string): void {
    Observability.emitTelemetry("info", "command.started", "Command started", {
      commandId,
      operationId,
    });
    Observability.captureAnalytics("command_started", {
      command_id: commandId,
      operation_type: operationId,
    });
  }

  static commandCompleted(
    commandId: string,
    operationId: string,
    latencyMs: number
  ): void {
    Observability.emitTelemetry(
      "info",
      "command.completed",
      "Command completed",
      {
        commandId,
        operationId,
      },
      { extra: { latencyMs } }
    );
    Observability.captureAnalytics("command_completed", {
      command_id: commandId,
      operation_type: operationId,
      latency_ms: latencyMs,
    });
  }

  static commandTimedOut(commandId: string, operationId: string): void {
    Observability.emitTelemetry(
      "error",
      "command.timeout",
      "Command timed out",
      {
        commandId,
        operationId,
      }
    );
    Observability.captureAnalytics("command_failed", {
      command_id: commandId,
      operation_type: operationId,
      error_class: "timeout",
    });
  }

  static commandCancelled(commandId: string, operationId: string): void {
    Observability.emitTelemetry(
      "warn",
      "command.cancelled",
      "Command cancelled",
      {
        commandId,
        operationId,
      }
    );
    Observability.captureAnalytics("command_failed", {
      command_id: commandId,
      operation_type: operationId,
      error_class: "cancelled",
    });
  }

  static commandFailed(
    commandId: string,
    operationId: string,
    message: string
  ): void {
    Observability.emitTelemetry("error", "command.gateway_error", message, {
      commandId,
      operationId,
    });
    Observability.captureAnalytics("command_failed", {
      command_id: commandId,
      operation_type: operationId,
      error_class: "gateway_error",
    });
  }

  // --- Approval lifecycle (product analytics only) ---

  static approvalRequested(operationId: string, commandId?: string): void {
    Observability.captureAnalytics("approval_requested", {
      operation_type: operationId,
      ...(commandId ? { command_id: commandId } : {}),
    });
  }

  static approvalResolved(
    operationId: string,
    outcome: "granted" | "denied" | "timed_out",
    timeToResolveMs: number,
    commandId?: string
  ): void {
    Observability.captureAnalytics("approval_resolved", {
      operation_type: operationId,
      outcome,
      time_to_resolve_ms: timeToResolveMs,
      ...(commandId ? { command_id: commandId } : {}),
    });
  }

  // --- Connection lifecycle ---

  static connectionEstablished(desktopId: string, environment: string): void {
    Observability.emitTelemetry(
      "info",
      "connection.established",
      "Connection established",
      { computeTargetId: desktopId }
    );
    Observability.captureAnalytics("desktop_connection_established", {
      environment,
    });
  }

  static reconnectionResumed(reason: string, replayCommandCount: number): void {
    Observability.emitTelemetry(
      "info",
      "connection.reconnection_resumed",
      "Reconnection resumed",
      {},
      { extra: { reason, replayCommandCount } }
    );
    Observability.captureAnalytics("desktop_reconnection_resumed", {
      reason,
      replay_command_count: replayCommandCount,
    });
  }

  static connectionDegraded(error: string): void {
    Observability.emitTelemetry("warn", "connection.degraded", error, {});
    Observability.captureAnalytics("desktop_connection_degraded", { error });
  }

  static connectionLost(reason?: string): void {
    Observability.emitTelemetry(
      "warn",
      "connection.lost",
      reason ?? "Connection lost",
      {}
    );
    Observability.captureAnalytics("desktop_connection_lost", { reason });
  }

  /** Emits a redacted diagnostic when Desktop PoP cannot sign a managed-key request. */
  static desktopPopUnavailable(surface: string, reason: string): void {
    Observability.emitTelemetry(
      "warn",
      "desktop_pop.unavailable",
      "Desktop PoP unavailable; continuing compatibility mode",
      {},
      { extra: { surface, reason } }
    );
    Observability.captureAnalytics("desktop_pop_unavailable", {
      surface,
      reason,
    });
  }

  /** Emits a descriptor-only outbound network policy decision for SSRF-sensitive fetches. */
  static outboundNetworkDecision(input: OutboundNetworkDiagnostics): void {
    const severity: TelemetrySeverity =
      input.decision === "denied" ? "warn" : "info";
    const message =
      input.decision === "denied"
        ? "Outbound network request denied"
        : "Outbound network request allowed";
    Observability.emitTelemetry(
      severity,
      "desktop.outbound_network_decision",
      message,
      {},
      { outboundNetwork: input }
    );
  }

  /** Emits structured lifecycle diagnostics for failure support bundle uploads. */
  static supportUploadLifecycle(input: SupportUploadDiagnostics): void {
    const severity: TelemetrySeverity =
      input.outcome === "failed" ? "warn" : "info";
    Observability.emitTelemetry(
      severity,
      "desktop.support_upload",
      `Support upload ${input.outcome}`,
      { loopId: input.loopId, jobId: input.loopId },
      { supportUpload: input }
    );
  }

  /** Emits bounded Desktop auto-update telemetry through the relay path. */
  static electronUpdateInitiated(input: DesktopUpdateDiagnostics): void {
    Observability.emitTelemetry(
      "info",
      "electron_update.initiated",
      "Electron update initiated",
      {},
      { desktopUpdate: input }
    );
  }

  /** Emits bounded Desktop auto-update failure telemetry through the relay path. */
  static electronUpdateFailed(input: DesktopUpdateDiagnostics): void {
    Observability.emitTelemetry(
      "error",
      "electron_update.failed",
      "Electron update failed",
      {},
      { desktopUpdate: input }
    );
  }

  /** Emits bounded Desktop shutdown failure telemetry through the relay path. */
  static desktopShutdownFailed(input: DesktopShutdownDiagnostics): void {
    Observability.emitTelemetry(
      "error",
      "desktop.shutdown_failed",
      "Desktop shutdown failed",
      {},
      { desktopShutdown: input }
    );
  }

  /** Emits bounded Closedloop plugin update attempt telemetry through the relay path. */
  static pluginUpdateAttempted(input: PluginUpdateDiagnostics): void {
    Observability.emitTelemetry(
      "info",
      "plugin_update.attempted",
      "Plugin update attempted",
      {},
      { pluginUpdate: input }
    );
    Observability.captureAnalytics("plugin_update_attempted", {
      plugin_count: input.pluginIds.length,
      duration_ms: input.durationMs,
    });
  }

  /** Emits bounded Closedloop plugin update success telemetry through the relay path. */
  static pluginUpdateSucceeded(input: PluginUpdateDiagnostics): void {
    Observability.emitTelemetry(
      "info",
      "plugin_update.succeeded",
      "Plugin update succeeded",
      {},
      { pluginUpdate: input }
    );
    Observability.captureAnalytics("plugin_update_succeeded", {
      plugin_count: input.pluginIds.length,
      duration_ms: input.durationMs,
    });
  }

  /** Emits bounded Closedloop plugin update failure telemetry through the relay path. */
  static pluginUpdateFailed(input: PluginUpdateDiagnostics): void {
    Observability.emitTelemetry(
      "error",
      "plugin_update.failed",
      "Plugin update failed",
      {},
      { pluginUpdate: input }
    );
    Observability.captureAnalytics("plugin_update_failed", {
      plugin_count: input.pluginIds.length,
      duration_ms: input.durationMs,
      failure_reason: input.failureReason,
    });
  }

  // --- Sandbox (product analytics only) ---

  static sandboxBlocked(operationClass: string): void {
    Observability.captureAnalytics("sandbox_blocked_operation", {
      operation_class: operationClass,
    });
  }

  // --- Agent session sync (product analytics only) ---

  static agentSessionSyncBatchFailed(
    event: AgentSessionSyncTelemetryEvent
  ): void {
    Observability.captureAnalytics("agent_session_sync_batch_failed", {
      reason: event.reason,
      sync_mode: event.syncMode,
      session_count: event.sessionCount,
      payload_bytes: event.payloadBytes,
    });
  }

  // --- Job lifecycle (telemetry only) ---

  static jobStarted(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string,
    pid: number,
    command?: LoopCommand
  ): void {
    Observability.emitTelemetry(
      "info",
      "job.started",
      `Job started with pid=${pid}`,
      {
        commandId,
        operationId,
        loopId,
        jobId: loopId,
      },
      Observability.withLifecycleCommand(undefined, command)
    );
  }

  static jobPlanSourceResolved(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string,
    planSource: ExecutePlanSourceDiagnostics
  ): void {
    Observability.emitTelemetry(
      "info",
      "job.plan_source_resolved",
      `EXECUTE plan source resolved: ${planSource.source}`,
      {
        commandId,
        operationId,
        loopId,
        jobId: loopId,
      },
      { planSource }
    );
  }

  static jobCompleted(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string,
    diagnostics?: TelemetryDiagnostics,
    loopSessionId?: string,
    command?: LoopCommand
  ): void {
    Observability.emitTelemetry(
      "info",
      "job.completed",
      "Job completed successfully",
      {
        commandId,
        operationId,
        loopId,
        jobId: loopId,
        loopSessionId,
      },
      Observability.withLifecycleCommand(diagnostics, command)
    );
  }

  static jobFailed(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string,
    exitCode: number,
    diagnostics?: TelemetryDiagnostics,
    loopSessionId?: string,
    command?: LoopCommand
  ): void {
    const baseDiagnostics: TelemetryDiagnostics = diagnostics
      ? { ...diagnostics, exitCode }
      : { exitCode };
    Observability.emitTelemetry(
      "error",
      "job.failed",
      `Process exited with code ${exitCode}`,
      { commandId, operationId, loopId, jobId: loopId, loopSessionId },
      Observability.withLifecycleCommand(baseDiagnostics, command)
    );
  }

  static jobCancelled(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string,
    exitCode: number,
    diagnostics?: TelemetryDiagnostics,
    loopSessionId?: string,
    command?: LoopCommand
  ): void {
    const baseDiagnostics: TelemetryDiagnostics = diagnostics
      ? { ...diagnostics, exitCode }
      : { exitCode };
    Observability.emitTelemetry(
      "info",
      "job.cancelled",
      `Process cancelled (exit code ${exitCode})`,
      { commandId, operationId, loopId, jobId: loopId, loopSessionId },
      Observability.withLifecycleCommand(baseDiagnostics, command)
    );
  }

  static jobAuthChallenge(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string,
    exitCode: number,
    diagnostics?: TelemetryDiagnostics,
    loopSessionId?: string
  ): void {
    Observability.emitTelemetry(
      "error",
      "job.auth_challenge",
      `Auth challenge detected (exit code ${exitCode})`,
      { commandId, operationId, loopId, jobId: loopId, loopSessionId },
      diagnostics ? { ...diagnostics, exitCode } : { exitCode }
    );
  }

  // --- Preflight (telemetry only) ---

  static preflightBinaryNotFound(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string
  ): void {
    Observability.emitTelemetry(
      "error",
      "preflight.binary_not_found",
      "claude CLI not found in PATH",
      {
        commandId,
        operationId,
        loopId,
      }
    );
  }

  static preflightScriptNotFound(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string
  ): void {
    Observability.emitTelemetry(
      "error",
      "preflight.script_not_found",
      "run-loop.sh not found in plugin cache",
      {
        commandId,
        operationId,
        loopId,
      }
    );
  }

  static preflightSpawnFailed(
    commandId: string | undefined,
    operationId: string | undefined,
    loopId: string,
    message: string
  ): void {
    Observability.emitTelemetry("error", "preflight.spawn_failed", message, {
      commandId,
      operationId,
      loopId,
    });
  }

  // --- Token-cost pricing miss (FEA-1969) ---

  /**
   * Warn that genai-prices could not price a model's token usage. Deduplicated
   * (see the gate below) so the costing layers — which run per-row on every
   * branch read/projection — do not flood the telemetry pipe.
   *
   * `resolveReason` is a thunk so the cold-path canonical re-compute that derives
   * the not-priced reason runs ONLY for events that survive dedup, never for the
   * deduplicated repeats.
   */
  static tokenCostPricingMiss(args: {
    model: string;
    surface: TokenCostPricingMissSurface;
    resolveReason: () => TokenCostNotPricedReason;
    sessionId?: string;
  }): void {
    // ───────────────────────────────────────────────────────────────────────
    // DEDUP DECISION (defines signal-to-noise). You chose: one event per
    // distinct unpriced model. The key IS that policy — widen it (append
    // `:${args.surface}` and/or `:${args.sessionId}`) to alert more often,
    // keep it model-only to alert once per model per desktop launch.
    const dedupKey = args.model;
    // ───────────────────────────────────────────────────────────────────────
    if (Observability.pricingMissSeen.has(dedupKey)) {
      return;
    }
    Observability.pricingMissSeen.add(dedupKey);

    const reason = args.resolveReason();
    const trace: TelemetryTraceContext = {};
    if (Observability.desktopClientVersion) {
      trace.desktopClientVersion = Observability.desktopClientVersion;
    }

    Observability.emitTelemetry(
      "warn",
      "token_cost.pricing_miss",
      `token cost not priced for model "${args.model}" (${reason})`,
      trace,
      {
        tokenCostPricingMiss: {
          model: args.model,
          reason,
          surface: args.surface,
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        },
      }
    );
  }

  // --- Health check telemetry ---

  static healthCheckResult(check: HealthCheckTelemetryInput): void {
    if (!Observability.HEALTH_CHECK_TELEMETRY_IDS.has(check.id)) {
      return;
    }

    const state: "passing" | "failing" = check.passed ? "passing" : "failing";
    const errorCode = check.debug?.errorCode;
    const prior = Observability.healthCheckState.get(check.id);
    const now = Date.now();

    let category: TelemetryCategory | null = null;
    if (!prior) {
      category = state === "failing" ? "healthcheck.failure_detected" : null;
    } else if (prior.lastState !== state) {
      category =
        state === "failing"
          ? "healthcheck.failure_detected"
          : "healthcheck.recovered";
    } else if (state === "failing" && prior.lastErrorCode !== errorCode) {
      category = "healthcheck.failure_detected";
    } else if (
      state === "failing" &&
      now - prior.lastEmittedAt >= Observability.HEARTBEAT_MS
    ) {
      category = "healthcheck.failure_persistent";
    }

    Observability.healthCheckState.set(check.id, {
      lastState: state,
      lastErrorCode: errorCode,
      lastEmittedAt: category ? now : (prior?.lastEmittedAt ?? now),
    });

    if (!category) {
      return;
    }

    const message =
      category === "healthcheck.recovered"
        ? "recovered"
        : (check.error ?? "health check failed");
    const severity: TelemetrySeverity =
      category === "healthcheck.recovered" ? "info" : "error";

    Observability.emitTelemetry(
      severity,
      category,
      message,
      {},
      {
        extra: {
          check_id: check.id,
          error_code: errorCode,
          shell: check.debug?.shell,
          platform: check.debug?.platform,
          found_elsewhere: (check.debug?.foundAt?.length ?? 0) > 0,
          resolved_path: check.debug?.resolvedPath,
          found_at: check.debug?.foundAt,
          stderr: check.debug?.stderr,
        },
      }
    );
    if (
      category === "healthcheck.failure_detected" ||
      category === "healthcheck.failure_persistent" ||
      category === "healthcheck.recovered"
    ) {
      Observability.captureAnalytics(category, {
        check_id: check.id,
        error_code: errorCode,
        found_elsewhere: (check.debug?.foundAt?.length ?? 0) > 0,
        platform: check.debug?.platform,
        shell: check.debug?.shell,
      });
    }
  }

  // --- Store integrity health (FEA-1999) ---

  /**
   * Report one SQLite store integrity probe result (see
   * {@link file:./database/store-integrity-probe.ts}). The probe runs off the
   * hot path on a reader connection and hands the bounded, content-free
   * {@link StoreIntegrityDiagnostics} here; this facade owns the emit cadence so
   * the fleet signal stays low-volume:
   *
   * - first failure (or a change in the affected object set) → `failure_detected`
   * - still failing after {@link HEARTBEAT_MS} → `failure_persistent`
   * - failing → healthy → `recovered`
   * - first healthy probe of a launch → `healthy` (the clean signal)
   * - otherwise the result is recorded silently (no event).
   *
   * The diagnostics ride as a typed field so the failing check name and affected
   * index/table name reach Datadog (the server schema strips unknown keys).
   */
  static storeIntegrityResult(diagnostics: StoreIntegrityDiagnostics): void {
    const now = Date.now();
    const state: "healthy" | "failing" = diagnostics.healthy
      ? "healthy"
      : "failing";
    const issueKey = Observability.storeIntegrityIssueKey(diagnostics);
    const prior = Observability.storeIntegrityState;

    let category: TelemetryCategory | null = null;
    if (state === "failing") {
      if (prior?.lastState !== "failing" || prior.lastIssueKey !== issueKey) {
        // A fresh failure, or the same probe surfacing a different set of
        // affected objects — re-detect rather than wait for the heartbeat.
        category = "store.integrity.failure_detected";
      } else if (now - prior.lastEmittedAt >= Observability.HEARTBEAT_MS) {
        category = "store.integrity.failure_persistent";
      }
    } else if (prior?.lastState === "failing") {
      category = "store.integrity.recovered";
    } else if (!prior?.emittedHealthy) {
      category = "store.integrity.healthy";
    }

    const emittedHealthy =
      (prior?.emittedHealthy ?? false) ||
      category === "store.integrity.healthy" ||
      category === "store.integrity.recovered";

    Observability.storeIntegrityState = {
      lastState: state,
      lastIssueKey: issueKey,
      lastEmittedAt: category ? now : (prior?.lastEmittedAt ?? now),
      emittedHealthy,
    };

    if (!category) {
      return;
    }

    const severity: TelemetrySeverity = state === "failing" ? "error" : "info";
    // Content-free message: object names live in the structured diagnostics, not
    // free text, so the message can never carry row content.
    const message = Observability.storeIntegrityMessage(category, diagnostics);

    const trace: TelemetryTraceContext = {};
    if (Observability.desktopClientVersion) {
      trace.desktopClientVersion = Observability.desktopClientVersion;
    }

    Observability.emitTelemetry(severity, category, message, trace, {
      storeIntegrity: diagnostics,
    });
  }

  /** Content-free message for a store-integrity event (object names live in the
   *  structured diagnostics, never in free text). */
  private static storeIntegrityMessage(
    category: TelemetryCategory,
    diagnostics: StoreIntegrityDiagnostics
  ): string {
    if (category === "store.integrity.recovered") {
      return "SQLite store integrity recovered";
    }
    if (diagnostics.healthy) {
      return "SQLite store integrity healthy";
    }
    const plural = diagnostics.issueCount === 1 ? "" : "s";
    return `SQLite store integrity check failed (${diagnostics.issueCount} issue${plural})`;
  }

  /**
   * Stable key over the affected object set (sorted), used to decide when a
   * still-failing probe should re-emit `failure_detected` because the corruption
   * shape changed. Only schema identifiers and bounded enums — never row content.
   */
  private static storeIntegrityIssueKey(
    diagnostics: StoreIntegrityDiagnostics
  ): string {
    if (diagnostics.healthy) {
      return "healthy";
    }
    // Prefix the full issue count so corruption GROWTH still re-detects even when
    // the issue list is truncated (the array is capped at maxReportedIssues, so a
    // store that grows from 20 → 25 issues keeps the same first-N objects; without
    // the count the cadence would never leave heartbeat for the new corruption).
    const objects = diagnostics.issues
      .map((issue) => `${issue.check}:${issue.category}:${issue.object ?? ""}`)
      .sort()
      .join("|");
    return `${diagnostics.issueCount}|${objects}`;
  }

  // --- Queue stats (telemetry only) ---

  static queueStatsChanged(activeCommands: number, queueDepth: number): void {
    Observability.emitTelemetry(
      "info",
      "queue.stats_changed",
      "Queue stats changed",
      {},
      { extra: { activeCommands, queueDepth } }
    );
  }

  // --- Onboarding popup (telemetry only) ---

  static onboardingPopupShown(): void {
    Observability.emitTelemetry(
      "info",
      "onboarding.popup_shown",
      "Onboarding reminder popup shown",
      {}
    );
  }

  static onboardingPopupCtaClicked(): void {
    Observability.emitTelemetry(
      "info",
      "onboarding.popup_cta_clicked",
      "Onboarding reminder popup CTA clicked",
      {}
    );
  }

  static onboardingPopupDismissedSession(): void {
    Observability.emitTelemetry(
      "info",
      "onboarding.popup_dismissed_session",
      "Onboarding reminder popup dismissed for session",
      {}
    );
  }

  static onboardingPopupDismissedPermanent(): void {
    Observability.emitTelemetry(
      "info",
      "onboarding.popup_dismissed_permanent",
      "Onboarding reminder popup dismissed permanently",
      {}
    );
  }

  static onboardingPopupSuppressedAuto(): void {
    Observability.emitTelemetry(
      "info",
      "onboarding.popup_suppressed_auto",
      "Onboarding reminder popup auto-suppressed; web wizard already complete",
      {}
    );
  }

  // --- Internal helpers ---

  private static withLifecycleCommand(
    diagnostics: TelemetryDiagnostics | undefined,
    command: LoopCommand | undefined
  ): TelemetryDiagnostics | undefined {
    if (command === undefined) {
      return diagnostics;
    }
    return {
      ...diagnostics,
      lifecycle: { ...diagnostics?.lifecycle, command },
    };
  }

  // commandId is a log/event attribute for correlation only — must not be promoted to a Datadog metric tag dimension
  private static emitTelemetry(
    severity: TelemetrySeverity,
    category: TelemetryCategory,
    message: string,
    trace: TelemetryTraceContext,
    diagnostics?: TelemetryDiagnostics
  ): void {
    Observability.telemetry?.emit({
      severity,
      category,
      message,
      trace,
      diagnostics,
    });
  }

  private static captureAnalytics(
    event: DesktopAnalyticsEventName,
    properties: Record<string, unknown>
  ): void {
    Observability.analytics?.send({
      event,
      properties: sanitizeAnalyticsProperties({
        ...properties,
        desktop_client_version: Observability.desktopClientVersion,
        platform: process.platform,
      }),
      occurredAt: new Date().toISOString(),
    });
  }
}

function sanitizeAnalyticsProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    // The cloud caps each string property at DESKTOP_ANALYTICS_STRING_MAX_LENGTH
    // and rejects the entire event on overflow, so clamp here to truncate the
    // offending value instead of silently dropping the whole diagnostic.
    if (typeof value === "string") {
      sanitized[key] = value.slice(0, DESKTOP_ANALYTICS_STRING_MAX_LENGTH);
      continue;
    }
    // The cloud validates every numeric property with z.number().finite() and
    // likewise rejects the entire event on a NaN/Infinity value (e.g. a
    // time_to_resolve_ms computed from a missing/malformed createdAt), so coerce
    // non-finite numbers to null — an accepted value — instead of dropping the
    // whole diagnostic.
    if (typeof value === "number" && !Number.isFinite(value)) {
      sanitized[key] = null;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
