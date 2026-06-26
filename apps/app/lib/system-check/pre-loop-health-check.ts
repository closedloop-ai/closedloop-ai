"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import type {
  CheckResult,
  HealthCheckResponse,
} from "@/lib/engineer/queries/health-check";
import {
  getHealthCheckTargetKey,
  getRenderableHealthChecks,
} from "@/lib/engineer/queries/health-check";
import {
  type HealthCheckCacheEntry,
  isHealthCheckCacheEntryFresh,
} from "./health-check-freshness";

/** Maximum time a pre-loop health-check fetch may block a command before fail-open. */
export const PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS = 5000;
/** Maximum pre-loop health-check wait when plugin auto-update may run. */
export const PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS = 45_000;

/** Launch commands currently protected by the pre-loop system-check gate. */
export const PreLoopCommand = {
  GeneratePlan: "generate_plan",
  GeneratePrd: "generate_prd",
  ExecutePlan: "execute_plan",
} as const;
export type PreLoopCommand =
  (typeof PreLoopCommand)[keyof typeof PreLoopCommand];

/** PostHog event names emitted by the pre-loop system-check funnel. */
export const PreLoopAnalyticsEvent = {
  CommandAttempted: "pre_loop_command_attempted",
  SystemCheckBlocked: "pre_loop_system_check_blocked",
  SystemCheckRecheckClicked: "pre_loop_system_check_recheck_clicked",
  SystemCheckResolved: "pre_loop_system_check_resolved",
  SystemCheckCancelled: "pre_loop_system_check_cancelled",
  SystemCheckUnavailable: "pre_loop_system_check_unavailable",
  ComputeSelectionBlocked: "pre_loop_compute_selection_blocked",
} as const;
export type PreLoopAnalyticsEvent =
  (typeof PreLoopAnalyticsEvent)[keyof typeof PreLoopAnalyticsEvent];

/** Local compute target snapshot used for one pre-loop gate evaluation. */
export type PreLoopTarget = {
  targetKey: string;
  computeTargetId: string;
  label: string;
  isOnline: boolean;
  isOwnedByCurrentUser: boolean;
  mode: "local_compute_target";
};

/** Debug/test-visible outcome returned by a pre-loop gate attempt. */
export type PreLoopHealthCheckOutcome =
  | { status: "executed"; attemptId: string }
  | { status: "blocked"; attemptId: string }
  | { status: "blocked_missing_compute_selection"; attemptId: string }
  | { status: "duplicate_ignored"; attemptId: null }
  | { status: "skipped_no_local_target"; attemptId: string }
  | { status: "blocked_unavailable"; attemptId: string }
  | { status: "cancelled"; attemptId: string };

export type PreLoopExecutionContext = {
  computeTargetId?: string | null;
};

/** Command metadata supplied by Generate Plan and Execute Plan callers. */
export type PreLoopMetadata = {
  command: PreLoopCommand;
  documentType?: string;
  documentId?: string | null;
  /** `undefined` resolves the current preference; `null` explicitly targets Cloud/no local target. */
  computeTargetId?: string | null;
  ownerKey: string;
};

/** Stable required-failure summary used for blocking and analytics. */
export type RequiredFailureSummary = {
  checkIds: string[];
  checks: CheckResult[];
  fingerprint: string;
};

let fallbackAttemptCounter = 0;

/** Creates a stable attempt id, with a deterministic fallback for test environments. */
export function createPreLoopAttemptId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  fallbackAttemptCounter += 1;
  return `pre-loop-attempt-${fallbackAttemptCounter}`;
}

export function getPreLoopTargetKey(computeTargetId: string): string {
  return getHealthCheckTargetKey({
    mode: EngineerRoutingMode.CloudRelay,
    computeTargetId,
  });
}

/** Returns whether a cached health-check result is fresh enough for pre-loop use. */
export function isPreLoopHealthCheckFresh({
  entry,
  expectedMcpUrl,
  latestVersion = null,
  pluginAutoUpdateEnabled = false,
  now = Date.now(),
}: {
  entry: HealthCheckCacheEntry;
  expectedMcpUrl: string | null;
  latestVersion?: string | null;
  pluginAutoUpdateEnabled?: boolean;
  now?: number;
}): boolean {
  return isHealthCheckCacheEntryFresh({
    entry,
    expectedMcpUrl,
    latestVersion,
    pluginAutoUpdateEnabled,
    now,
    requiredOnly: true,
  });
}

/** Selects the pre-loop health-check timeout for the request mutation mode. */
export function getPreLoopHealthCheckTimeoutMs(
  pluginAutoUpdateEnabled = false
): number {
  return pluginAutoUpdateEnabled
    ? PRE_LOOP_PLUGIN_UPDATE_HEALTH_CHECK_TIMEOUT_MS
    : PRE_LOOP_HEALTH_CHECK_TIMEOUT_MS;
}

/** Extracts required renderable checks that currently fail. */
export function getFailingRequiredChecks(
  response: HealthCheckResponse | undefined,
  expectedMcpUrl: string | null
): CheckResult[] {
  return (
    getRenderableHealthChecks(response, expectedMcpUrl)?.filter(
      (check) => check.required && !check.passed
    ) ?? []
  );
}

/** Extracts sorted IDs for required renderable checks that currently fail. */
export function getFailingRequiredCheckIds(
  response: HealthCheckResponse | undefined,
  expectedMcpUrl: string | null
): string[] {
  return getFailingRequiredChecks(response, expectedMcpUrl)
    .map((check) => check.id)
    .sort();
}

/** Creates the stable failure fingerprint from sorted failing check IDs. */
export function getFailingRequiredFingerprint(checkIds: string[]): string {
  return JSON.stringify([...checkIds].sort());
}

/** Builds the required-failure summary from a health-check response. */
export function getRequiredFailureSummary(
  response: HealthCheckResponse | undefined,
  expectedMcpUrl: string | null
): RequiredFailureSummary {
  const checks = getFailingRequiredChecks(response, expectedMcpUrl);
  const checkIds = checks.map((check) => check.id).sort();
  return {
    checks,
    checkIds,
    fingerprint: getFailingRequiredFingerprint(checkIds),
  };
}

/** Shapes shared analytics properties for all pre-loop system-check events. */
export function buildPreLoopAnalyticsProperties({
  attemptId,
  metadata,
  target,
  healthCheckCacheAgeMs,
  usedCachedHealthCheck,
  failingChecks,
  failingRequiredFingerprint,
  recheckAttempts,
  reason,
}: {
  attemptId: string;
  metadata: PreLoopMetadata;
  target?: PreLoopTarget | null;
  healthCheckCacheAgeMs?: number | null;
  usedCachedHealthCheck?: boolean | null;
  failingChecks?: CheckResult[];
  failingRequiredFingerprint?: string;
  recheckAttempts?: number;
  reason?: string;
}): Record<string, unknown> {
  const sortedFailingChecks = failingChecks
    ? [...failingChecks].sort((a, b) => a.id.localeCompare(b.id))
    : undefined;
  return {
    attemptId,
    loopCommand: metadata.command,
    documentType: metadata.documentType,
    documentId: metadata.documentId ?? undefined,
    ownerKey: metadata.ownerKey,
    requestedComputeTargetId:
      metadata.computeTargetId === undefined
        ? undefined
        : metadata.computeTargetId,
    computePreference: target ? "local" : undefined,
    computeTargetId: target?.computeTargetId,
    computeTargetLabel: target?.label,
    healthCheckCacheAgeMs,
    usedCachedHealthCheck,
    failingCheckIds: sortedFailingChecks?.map((check) => check.id),
    failingCheckLabels: sortedFailingChecks?.map((check) => check.label),
    failingRequiredCount: sortedFailingChecks?.length,
    failingRequiredFingerprint,
    recheckAttempts,
    reason,
  };
}
