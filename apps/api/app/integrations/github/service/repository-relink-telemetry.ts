/**
 * Telemetry vocabulary and metric emitters for repository-artifact relinking.
 *
 * Split out of `service.ts` (grandfathered over the file-size ceiling): the
 * relink result shape, its failure taxonomy, and the two emitters are one
 * cohesive concern that the connect, reconnect, and sync paths all report
 * into, and none of it touches the database or GitHub.
 *
 * A leaf of the composition root, per `apps/api/AGENTS.md`: a single service
 * surface decomposing its internals puts them in `service/<concern>.ts`, and
 * this module imports nothing from `service.ts` in return.
 *
 * The emitters swallow their own failures deliberately. Telemetry must never
 * break a connect or sync flow, so a failed emit degrades to a warn and, for
 * the completed metric, to a `telemetry_emit_failed` failure metric.
 */

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";

export const RepositoryArtifactRelinkStatus = {
  Completed: "completed",
  Partial: "partial",
  Skipped: "skipped",
} as const;
export type RepositoryArtifactRelinkStatus =
  (typeof RepositoryArtifactRelinkStatus)[keyof typeof RepositoryArtifactRelinkStatus];

export const RepositoryArtifactRelinkReason = {
  None: "none",
  NoActiveInstallation: "no_active_installation",
  NoActiveRepositories: "no_active_repositories",
  ActiveRepositoryAmbiguous: "active_repository_ambiguous",
  BranchNameCollision: "branch_name_collision",
  PullRequestNumberCollision: "pull_request_number_collision",
  GuardedWriteFailed: "guarded_write_failed",
} as const;
export type RepositoryArtifactRelinkReason =
  (typeof RepositoryArtifactRelinkReason)[keyof typeof RepositoryArtifactRelinkReason];

export type RepositoryArtifactRelinkResult = {
  status: RepositoryArtifactRelinkStatus;
  reasons: RepositoryArtifactRelinkReason[];
  activeRepositoryCount: number;
  staleRepositoryCount: number;
  branchRelinkedCount: number;
  pullRequestRelinkedCount: number;
  branchCollisionSkippedCount: number;
  pullRequestCollisionSkippedCount: number;
  ambiguousRepositorySkippedCount: number;
  blockedBranchCount: number;
};

export const RepositoryArtifactRelinkFailureStage = {
  OAuthClaim: "oauth_claim",
  // Same-account reconnect (PLN-634). Kept distinct from `OAuthClaim` because
  // the consequences differ: a claim failure leaves the org connected with
  // repositories unsynced, while a reconnect failure refuses the reconnect
  // outright to protect existing artifact references.
  OAuthReconnect: "oauth_reconnect",
  SyncRepositories: "sync_repositories",
  AddRepositories: "add_repositories",
  SyncPreflightRelink: "sync_preflight_relink",
} as const;
export type RepositoryArtifactRelinkFailureStage =
  (typeof RepositoryArtifactRelinkFailureStage)[keyof typeof RepositoryArtifactRelinkFailureStage];

export const RepositoryArtifactRelinkFailureReason = {
  RepositoryFetchFailed: "repository_fetch_failed",
  RepositoryFetchPartial: "repository_fetch_partial",
  TransactionFailed: "transaction_failed",
  TelemetryEmitFailed: "telemetry_emit_failed",
} as const;
export type RepositoryArtifactRelinkFailureReason =
  (typeof RepositoryArtifactRelinkFailureReason)[keyof typeof RepositoryArtifactRelinkFailureReason];

export const RepositoryArtifactRelinkMetricName = {
  Completed: "github.installation_artifact_relink.completed",
  Failed: "github.installation_artifact_relink.failed",
} as const;
export type RepositoryArtifactRelinkMetricName =
  (typeof RepositoryArtifactRelinkMetricName)[keyof typeof RepositoryArtifactRelinkMetricName];
export function createRepositoryArtifactRelinkResult(
  overrides: Partial<RepositoryArtifactRelinkResult> = {}
): RepositoryArtifactRelinkResult {
  return {
    status: RepositoryArtifactRelinkStatus.Skipped,
    reasons: [RepositoryArtifactRelinkReason.None],
    activeRepositoryCount: 0,
    staleRepositoryCount: 0,
    branchRelinkedCount: 0,
    pullRequestRelinkedCount: 0,
    branchCollisionSkippedCount: 0,
    pullRequestCollisionSkippedCount: 0,
    ambiguousRepositorySkippedCount: 0,
    blockedBranchCount: 0,
    ...overrides,
  };
}

export function addRelinkReason(
  result: RepositoryArtifactRelinkResult,
  reason: RepositoryArtifactRelinkReason
) {
  if (reason === RepositoryArtifactRelinkReason.None) {
    return;
  }
  result.reasons = result.reasons.filter(
    (existing) => existing !== RepositoryArtifactRelinkReason.None
  );
  if (!result.reasons.includes(reason)) {
    result.reasons.push(reason);
  }
}

export function finalizeRepositoryArtifactRelinkResult(
  result: RepositoryArtifactRelinkResult
): RepositoryArtifactRelinkResult {
  const skippedOrBlocked =
    result.branchCollisionSkippedCount +
    result.pullRequestCollisionSkippedCount +
    result.ambiguousRepositorySkippedCount +
    result.blockedBranchCount;
  if (skippedOrBlocked > 0) {
    return { ...result, status: RepositoryArtifactRelinkStatus.Partial };
  }
  if (result.branchRelinkedCount > 0 || result.pullRequestRelinkedCount > 0) {
    return { ...result, status: RepositoryArtifactRelinkStatus.Completed };
  }
  return { ...result, status: RepositoryArtifactRelinkStatus.Skipped };
}

export function emitRepositoryArtifactRelinkCompletedMetric(
  result: RepositoryArtifactRelinkResult,
  failureStage: RepositoryArtifactRelinkFailureStage
) {
  try {
    emitTelemetryMetric({
      metric: RepositoryArtifactRelinkMetricName.Completed,
      count: 1,
      status: result.status,
      reasonCount: result.reasons.filter(
        (reason) => reason !== RepositoryArtifactRelinkReason.None
      ).length,
      activeRepositoryCount: result.activeRepositoryCount,
      staleRepositoryCount: result.staleRepositoryCount,
      branchRelinkedCount: result.branchRelinkedCount,
      pullRequestRelinkedCount: result.pullRequestRelinkedCount,
      branchCollisionSkippedCount: result.branchCollisionSkippedCount,
      pullRequestCollisionSkippedCount: result.pullRequestCollisionSkippedCount,
      ambiguousRepositorySkippedCount: result.ambiguousRepositorySkippedCount,
      blockedBranchCount: result.blockedBranchCount,
    });
  } catch (error) {
    emitRepositoryArtifactRelinkFailedMetric(
      failureStage,
      RepositoryArtifactRelinkFailureReason.TelemetryEmitFailed
    );
    log.warn("[github] Failed to emit artifact relink metric", {
      error: parseError(error),
    });
  }
}

export function emitRepositoryArtifactRelinkFailedMetric(
  stage: RepositoryArtifactRelinkFailureStage,
  reason: RepositoryArtifactRelinkFailureReason
) {
  try {
    emitTelemetryMetric({
      metric: RepositoryArtifactRelinkMetricName.Failed,
      count: 1,
      stage,
      reason,
    });
  } catch (error) {
    log.warn("[github] Failed to emit artifact relink failure metric", {
      stage,
      reason,
      error: parseError(error),
    });
  }
}
