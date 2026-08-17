import { log } from "../log";
import { redactGatewaySessionId } from "../redact-correlation";
import type { FilterToken } from "./filter-tokens";
import type { Origin } from "./origin";

// ---------------------------------------------------------------------------
// QueueMetric — executor/queue health metrics
// ---------------------------------------------------------------------------

export type QueueMetric = {
  metric:
    | "queued_command_count"
    | "in_flight_command_count"
    | "retry_attempts"
    | "replay_frequency"
    | "executor_saturation"
    | "dropped_expired_work_items"
    | "command_state_transition";
  origin: Origin;
  count?: number;
  value?: number;
  computeTargetId?: string;
  timestamp?: string;
  fromStatus?: string;
  toStatus?: string;
  commandId?: string;
  filterToken?: FilterToken;
  reason?: string;
};

// ---------------------------------------------------------------------------
// ConnectionState — connection health state values
// ---------------------------------------------------------------------------

export const ConnectionState = {
  Online: "online",
  Degraded: "degraded",
  Disconnected: "disconnected",
} as const;
export type ConnectionState =
  (typeof ConnectionState)[keyof typeof ConnectionState];

// ---------------------------------------------------------------------------
// ProtocolMetric — connection/protocol health metrics
// ---------------------------------------------------------------------------

/** Emitted with count: 1 per state transition. Aggregate via sum(count) by {state} for transition-rate view; NOT a live gauge of currently-connected workers. The literal `count: 1` is the enforced invariant — any other numeric count on this metric is a bug. */
type ConnectionStateCountMetric = {
  metric: "connection_state_count";
  state: ConnectionState;
  count: 1;
  computeTargetId?: string;
  gatewaySessionId?: string;
  timestamp?: string;
};

type ProtocolBaseMetric = {
  metric:
    | "ack_latency"
    | "terminal_event_latency"
    | "heartbeat_freshness"
    | "presence_received_latency"
    | "reconnect_frequency"
    | "event_ordering_gaps"
    | "command_ack_lifecycle_context_omitted"
    | "connection_churn_rate"
    | "replay_window_usage";
  origin: Origin;
  value?: number;
  count?: number;
  computeTargetId?: string;
  gatewaySessionId?: string;
  timestamp?: string;
};

export type ProtocolMetric = ConnectionStateCountMetric | ProtocolBaseMetric;

// ---------------------------------------------------------------------------
// DbPoolMetric — pg connection-pool health metrics (FEA-3300)
// ---------------------------------------------------------------------------

/**
 * Structurally mirrors `PoolTelemetrySample` in `@repo/database`. The two are
 * intentionally not a shared type: `@repo/database` must stay free of any
 * `@repo/observability` import (apps/mcp packages it through a narrow Docker
 * context), so the pool emits through an injected sink and `apps/api` adapts
 * the sample to this shape.
 *
 * The duplication cannot drift silently: the sink adapter in
 * `apps/api/instrumentation.ts` only type-checks while a `PoolTelemetrySample`
 * can be widened into a `DbPoolMetric`, so adding a metric on one side and not
 * the other is a compile error at the wiring site, not a runtime surprise.
 *
 * `origin` is **required and must be set by the caller**, matching
 * `QueueMetric`/`ProtocolMetric`. It is not safe to rely on `buildEntry()` here:
 * that only enriches the agentless HTTP intake payload, while `writeConsole()`
 * emits `{...meta, message, level}` to stdout — so on the Vercel Log Drain path
 * `@origin` comes **solely from this payload**. Omitting it would make
 * `db_pool_*` the one metric family invisible to an `@origin` predicate on that
 * path.
 *
 * `poolMax`/`waitingCount`/`inUse`/`idle`/`total` ride as log attributes for
 * diagnosis; they are deliberately NOT metric tags.
 */
export type DbPoolMetric = {
  metric:
    | "db_pool_acquire_wait"
    | "db_pool_acquire_timeout"
    | "db_pool_checkout_duration"
    | "db_pool_wait_queue_depth"
    | "db_pool_in_use"
    | "db_pool_idle"
    | "db_pool_total";
  origin: Origin;
  /** Gauge/measurement (ms for durations). Mutually exclusive with `count`. */
  value?: number;
  /** Additive counter; always 1. Mutually exclusive with `value`. */
  count?: number;
  poolMax: number;
  waitingCount: number;
  inUse: number;
  idle: number;
  total: number;
  timestamp?: string;
};

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Emit any telemetry metric as JSON with the `_telemetryMetric: true` marker
 * that the Datadog log-to-metric pipeline filters on. Use this directly for
 * domain-specific metric types (e.g. loop.runner.*); use the typed wrappers
 * below for the queue/protocol metric families.
 */
export function emitTelemetryMetric<T extends { metric: string }>(
  metric: T
): void {
  // gatewaySessionId is a session-correlation token that must never be logged
  // raw. The metric pipeline emits via log.info, so redact to the stable hash
  // before stringifying; same id in means same hash out, so metric correlation
  // by session survives.
  const payload: Record<string, unknown> = {
    ...metric,
    _telemetryMetric: true,
  };
  if (typeof payload.gatewaySessionId === "string") {
    payload.gatewaySessionId = redactGatewaySessionId(payload.gatewaySessionId);
  }
  log.info(JSON.stringify(payload));
}

export function emitQueueMetric(metric: QueueMetric): void {
  emitTelemetryMetric(metric);
}

export function emitProtocolMetric(metric: ProtocolMetric): void {
  emitTelemetryMetric(metric);
}

export function emitDbPoolMetric(metric: DbPoolMetric): void {
  emitTelemetryMetric(metric);
}
