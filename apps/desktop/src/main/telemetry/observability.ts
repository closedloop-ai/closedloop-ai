import { OnboardingAnalyticsEvent } from "@repo/api/src/types/onboarding-analytics";
import type { TokenCostNotPricedReason } from "../../shared/token-cost.js";
import type { AgentSessionSyncTelemetryEvent } from "../agent-sync/agent-session-sync-service-options.js";
import type {
  DesktopAnalyticsEvent,
  DesktopAnalyticsEventName,
} from "../cloud/cloud-protocol.js";
import { sanitizeAnalyticsProperties } from "./analytics-property-sanitizer.js";
import {
  buildDesktopClientVersionTrace,
  getDesktopClientVersion,
  setDesktopClientVersion,
} from "./desktop-client-version.js";
import { drainTelemetryWithDeadline } from "./shutdown-deadline.js";
import type {
  DesktopShutdownDiagnostics,
  DesktopUpdateDiagnostics,
  OutboundNetworkDiagnostics,
  StoreIntegrityDiagnostics,
  TelemetryCategory,
  TelemetryDiagnostics,
  TelemetryEmitter,
  TelemetryEventPayload,
  TelemetrySeverity,
  TelemetryTraceContext,
  TokenCostPricingMissSurface,
} from "./telemetry-protocol.js";
import { getTelemetryRelaySink } from "./telemetry-relay-sink.js";
import {
  type EnrichedTelemetryEvent,
  TelemetryService,
} from "./telemetry-service.js";

export type ObservabilityOptions = {
  telemetrySend: (event: EnrichedTelemetryEvent) => void;
  /**
   * FEA-3425 (Phase 3): bounded drain of an async telemetry transport (the HTTP
   * lane) on shutdown. Optional — the socket transport is a synchronous emit
   * with nothing to drain.
   */
  telemetryFlush?: (options: { timeoutMs: number }) => Promise<void>;
  analytics?: ProductAnalyticsTransport;
  desktopClientVersion?: string;
  /**
   * ISS-10502 (PRD-736 decision #11): the install's node_uuid, stamped on every
   * product-analytics event as `device_id` — the pre/post-auth join key. A
   * PROPERTY only: it is never aliased and never `identify`-ed to a person.
   */
  deviceId?: string;
  /**
   * ISS-9743 — the commit this bundle was built from. Omitted when the process
   * cannot resolve one; `desktopClientVersion` alone names no source build.
   */
  desktopBuildCommit?: string;
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

export class Observability {
  private static telemetry: TelemetryService | null = null;
  private static telemetryFlush:
    | ((options: { timeoutMs: number }) => Promise<void>)
    | null = null;
  private static analytics: ProductAnalyticsTransport | null = null;
  private static analyticsDeviceId: string | null = null;

  // FEA-1969 — dedup set for token-cost pricing-miss events. Bounds telemetry
  // volume: the costing layers run per-row on every branch read/projection, so
  // an undeduped emit would flood the relay. Keyed per `tokenCostPricingMiss`.
  private static readonly pricingMissSeen = new Set<string>();

  // Clock-backward: negative delta < HEARTBEAT_MS -> heartbeat skipped (correct).
  private static readonly HEARTBEAT_MS = 60 * 60 * 1000; // 1 hour

  // FEA-1999 — cadence state for the SQLite store integrity probe. Memory-only
  // (re-launch re-emits the first signal). Bounds Datadog volume: a failure
  // emits once on detection (or when the affected object set changes),
  // re-emits only on the heartbeat while it persists, and a recovery /
  // first-healthy probe emits one clean signal — repeated identical states are
  // suppressed.
  private static storeIntegrityState: {
    lastState: "healthy" | "failing";
    lastIssueKey: string;
    lastEmittedAt: number;
    emittedHealthy: boolean;
  } | null = null;

  static init(options: ObservabilityOptions): void {
    Observability.telemetry = new TelemetryService({
      sendTelemetry: options.telemetrySend,
      desktopBuildCommit: options.desktopBuildCommit,
    });
    Observability.telemetryFlush = options.telemetryFlush ?? null;
    Observability.analytics = options.analytics ?? null;
    Observability.analyticsDeviceId = options.deviceId ?? null;
    setDesktopClientVersion(options.desktopClientVersion ?? "");
    Observability.storeIntegrityState = null;
  }

  static initNoOp(): void {
    Observability.init({ telemetrySend: () => {} });
  }

  static reset(): void {
    Observability.telemetry = null;
    Observability.telemetryFlush = null;
    Observability.analytics = null;
    Observability.analyticsDeviceId = null;
    setDesktopClientVersion("");
    Observability.pricingMissSeen.clear();
    Observability.storeIntegrityState = null;
  }

  static shutdown(): Promise<void> {
    // FEA-3425: drain both async transports (product analytics + the HTTP
    // telemetry lane) so a POST issued just before quit is not abandoned.
    // ISS-4585: the drain is best-effort and hard-bounded — the per-transport
    // budget and whole-drain deadline live in `drainTelemetryWithDeadline`.
    return drainTelemetryWithDeadline([
      (options) => Observability.analytics?.flush(options) ?? Promise.resolve(),
      Observability.telemetryFlush,
    ]);
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
        Observability.deliverTelemetry(event);
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

  // --- Sandbox (product analytics only) ---

  static sandboxBlocked(operationClass: string): void {
    Observability.captureAnalytics("sandbox_blocked_operation", {
      operation_class: operationClass,
    });
  }

  // --- Renderer surface analytics (product analytics only, ISS-8752) ---

  /**
   * Forward one renderer-originated surface-attributed event (already
   * validated against the renderer-permitted subset by the IPC handler) to the
   * product-analytics transport. Same enrichment/clamping as every other
   * product analytics event.
   */
  static rendererSurfaceAnalytics(
    event: DesktopAnalyticsEventName,
    properties: Record<string, unknown>
  ): void {
    Observability.captureAnalytics(event, properties);
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
    const trace = buildDesktopClientVersionTrace();

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

  // --- Store integrity health (FEA-1999) ---

  /**
   * Report one SQLite store integrity probe result (see
   * {@link file:./database/database-integrity/store-integrity-probe.ts}). The probe runs off the
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

    const trace = buildDesktopClientVersionTrace();

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

  // commandId is a log/event attribute for correlation only — must not be promoted to a Datadog metric tag dimension
  private static emitTelemetry(
    severity: TelemetrySeverity,
    category: TelemetryCategory,
    message: string,
    trace: TelemetryTraceContext,
    diagnostics?: TelemetryDiagnostics
  ): void {
    Observability.deliverTelemetry({
      severity,
      category,
      message,
      trace,
      diagnostics,
    });
  }

  /**
   * ISS-7109 — the single chokepoint every desktop telemetry event leaves
   * through, and the one place that knows this process may not own the
   * transport.
   *
   * In main the sink is null and this is `telemetry?.emit(event)` unchanged. In
   * a child process (the FEA-2038 DB host) `telemetry` is null because
   * `Observability.init` never ran there, so the optional chain below would
   * DISCARD the event; the installed relay carries it to main instead, which
   * re-emits it on the child's behalf. Routing here rather than at any single
   * reporter is what makes the fix hold for every emit the child can reach —
   * present and future — instead of the one call site that exposed it.
   */
  private static deliverTelemetry(event: TelemetryEventPayload): void {
    const relay = getTelemetryRelaySink();
    if (relay) {
      relay(event);
      return;
    }
    Observability.telemetry?.emit(event);
  }

  private static captureAnalytics(
    event: DesktopAnalyticsEventName,
    properties: Record<string, unknown>
  ): void {
    Observability.analytics?.send({
      event,
      properties: sanitizeAnalyticsProperties({
        ...properties,
        desktop_client_version: getDesktopClientVersion(),
        platform: process.platform,
        // ISS-10502 review (tamsinb/whitlockk on #7748): the FTUE family ONLY.
        // The relay refuses a whole payload on an unknown property key, so
        // stamping every event would make a newer Desktop against an older API
        // lose its ENTIRE analytics lane instead of just the new event family —
        // which that API rejects by event name anyway, so scoping the key to
        // the events that need it costs nothing and caps the blast radius.
        ...(Observability.analyticsDeviceId !== null &&
        ONBOARDING_ANALYTICS_EVENT_NAMES.has(event)
          ? { device_id: Observability.analyticsDeviceId }
          : {}),
      }),
      occurredAt: new Date().toISOString(),
    });
  }
}

/** The FTUE event family (PRD-736) — the only events that carry `device_id`. */
const ONBOARDING_ANALYTICS_EVENT_NAMES: ReadonlySet<string> = new Set(
  Object.values(OnboardingAnalyticsEvent)
);
