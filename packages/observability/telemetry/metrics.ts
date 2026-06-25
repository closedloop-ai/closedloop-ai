import { log } from "../log";
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
  log.info(JSON.stringify({ ...metric, _telemetryMetric: true }));
}

export function emitQueueMetric(metric: QueueMetric): void {
  emitTelemetryMetric(metric);
}

export function emitProtocolMetric(metric: ProtocolMetric): void {
  emitTelemetryMetric(metric);
}
