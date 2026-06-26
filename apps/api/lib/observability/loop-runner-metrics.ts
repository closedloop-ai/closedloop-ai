import type { RefreshTokenErrorCode as RefreshTokenErrorCodeType } from "@repo/api/src/types/loop";
import { RefreshTokenErrorCode } from "@repo/api/src/types/loop";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";

// ---------------------------------------------------------------------------
// loop.runner.* metric emitter module
//
// Single import point for all loop-runner observability metrics. Follows the
// emitQueueMetric / emitProtocolMetric pattern from
// packages/observability/telemetry/metrics.ts.
//
// Downstream features (e.g. FEA-1075 reaper) import from this module for
// loop.runner.reap.transition metrics.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Refresh failure reason codes
//
// Maps the 8 RefreshTokenErrorCode values to the 6 PRD-specified metric reason
// strings. Multi-to-one: NotRunning+LoopNotFound→terminal_status,
// GenerationFailed+RaceLost→network.
// ---------------------------------------------------------------------------

/**
 * Reap-transition reason codes for the FEA-1075 reaper job. Wire-level
 * snake_case values are consumed verbatim by the telemetry pipeline and
 * downstream dashboards; do not rename them without coordinating that change.
 */
export const ReapReason = {
  TokenExpired: "token_expired",
  ZombieDetected: "zombie_detected",
  ManualReap: "manual_reap",
  DesktopHeartbeatStale: "desktop_heartbeat_stale",
  DesktopNoHeartbeat: "desktop_no_heartbeat",
  DesktopLegacy24h: "desktop_legacy_24h",
} as const;
export type ReapReason = (typeof ReapReason)[keyof typeof ReapReason];

export const RefreshFailureReason = {
  Expired: "expired",
  JtiMismatch: "jti_mismatch",
  TerminalStatus: "terminal_status",
  RateLimited: "rate_limited",
  Network: "network",
  StaleIdempotencyKey: "stale_idempotency_key",
} as const;
export type RefreshFailureReason =
  (typeof RefreshFailureReason)[keyof typeof RefreshFailureReason];

const REFRESH_ERROR_CODE_TO_REASON: Record<
  RefreshTokenErrorCodeType,
  RefreshFailureReason
> = {
  [RefreshTokenErrorCode.TokenExpired]: RefreshFailureReason.Expired,
  [RefreshTokenErrorCode.JtiMismatch]: RefreshFailureReason.JtiMismatch,
  [RefreshTokenErrorCode.NotRunning]: RefreshFailureReason.TerminalStatus,
  [RefreshTokenErrorCode.LoopNotFound]: RefreshFailureReason.TerminalStatus,
  [RefreshTokenErrorCode.RateLimited]: RefreshFailureReason.RateLimited,
  [RefreshTokenErrorCode.GenerationFailed]: RefreshFailureReason.Network,
  [RefreshTokenErrorCode.JtiAlreadyUsed]:
    RefreshFailureReason.StaleIdempotencyKey,
  [RefreshTokenErrorCode.RaceLost]: RefreshFailureReason.Network,
};

/**
 * Map a RefreshTokenErrorCode to the canonical PRD metric reason string.
 */
export function mapRefreshErrorCodeToReason(
  code: RefreshTokenErrorCodeType
): RefreshFailureReason {
  return REFRESH_ERROR_CODE_TO_REASON[code];
}

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

type RefreshAttemptMetric = {
  metric: typeof FilterToken.LoopRunnerRefreshAttempt;
  orgId: string;
  count: 1;
  timestamp?: string;
};

type RefreshFailureMetric = {
  metric: typeof FilterToken.LoopRunnerRefreshFailure;
  orgId: string;
  reason: RefreshFailureReason;
  count: 1;
  timestamp?: string;
};

type HeartbeatLagMetric = {
  metric: typeof FilterToken.LoopRunnerHeartbeatLag;
  orgId: string;
  loopId: string;
  value: number;
  timestamp?: string;
};

type HeartbeatAcceptedMetric = {
  metric: typeof FilterToken.LoopRunnerHeartbeatAccepted;
  orgId: string;
  loopId: string;
  count: 1;
  timestamp?: string;
};

type ReapTransitionMetric = {
  metric: typeof FilterToken.LoopRunnerReapTransition;
  loopId: string;
  reason: ReapReason;
  count: 1;
  timestamp?: string;
};

type ReapReversedMetric = {
  metric: typeof FilterToken.LoopRunnerReapReversed;
  loopId: string;
  orgId: string;
  count: 1;
  timestamp?: string;
};

type ZombieDetectorMetric = {
  metric: typeof FilterToken.LoopRunnerZombieDetector;
  count: number;
  timestamp?: string;
};

// ---------------------------------------------------------------------------
// Emitters
//
// Each wrapper exists to enforce the per-metric payload shape at compile time.
// The actual JSON emission is delegated to emitTelemetryMetric so the
// `_telemetryMetric: true` marker contract lives in exactly one place.
// ---------------------------------------------------------------------------

export function emitRefreshAttempt(orgId: string): void {
  emitTelemetryMetric<RefreshAttemptMetric>({
    metric: FilterToken.LoopRunnerRefreshAttempt,
    orgId,
    count: 1,
  });
}

export function emitRefreshFailure(
  orgId: string,
  reason: RefreshFailureReason
): void {
  emitTelemetryMetric<RefreshFailureMetric>({
    metric: FilterToken.LoopRunnerRefreshFailure,
    orgId,
    reason,
    count: 1,
  });
}

export function emitHeartbeatLag(
  orgId: string,
  loopId: string,
  lagMs: number
): void {
  emitTelemetryMetric<HeartbeatLagMetric>({
    metric: FilterToken.LoopRunnerHeartbeatLag,
    orgId,
    loopId,
    value: lagMs,
  });
}

export function emitHeartbeatAccepted(orgId: string, loopId: string): void {
  emitTelemetryMetric<HeartbeatAcceptedMetric>({
    metric: FilterToken.LoopRunnerHeartbeatAccepted,
    orgId,
    loopId,
    count: 1,
  });
}

/** Used by FEA-1075 reaper to track loop reap transitions by reason. */
export function emitReapTransition(loopId: string, reason: ReapReason): void {
  emitTelemetryMetric<ReapTransitionMetric>({
    metric: FilterToken.LoopRunnerReapTransition,
    loopId,
    reason,
    count: 1,
  });
}

/** Emitted when a TIMED_OUT loop is successfully revived via wake heartbeat. */
export function emitReapReversed(loopId: string, orgId: string): void {
  emitTelemetryMetric<ReapReversedMetric>({
    metric: FilterToken.LoopRunnerReapReversed,
    loopId,
    orgId,
    count: 1,
  });
}

export function emitZombieDetector(count: number): void {
  emitTelemetryMetric<ZombieDetectorMetric>({
    metric: FilterToken.LoopRunnerZombieDetector,
    count,
  });
}
