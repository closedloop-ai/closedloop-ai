import { type BranchRow, encodeBranchId } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { calculateBranchLastActiveMetric } from "@repo/lib/branches/branch-list-metrics";
import type { BranchCanonicalActivityRow } from "../database/branch-activity-read.js";
import type { BranchCommitRow, BranchPrRow } from "../database/branch-reads.js";

/** One operation-scoped canonical Last-active result per encoded Branch id. */
export type DesktopBranchLastActiveProjection = ReadonlyMap<
  string,
  BranchMetricResult<string>
>;

/**
 * Combine persisted monitored activity, commits, and PR lifecycle instants.
 * Session/link/import/request/passive and generic update times never enter this
 * boundary, so every downstream consumer can safely share the result.
 */
export function projectDesktopBranchLastActive(
  branchIds: readonly string[],
  activityRows: readonly BranchCanonicalActivityRow[],
  pullRequests: readonly BranchPrRow[],
  commits: readonly BranchCommitRow[]
): DesktopBranchLastActiveProjection {
  const eventsByBranch = new Map<string, BranchActivityEvent[]>();
  for (const branchId of branchIds) {
    eventsByBranch.set(branchId, []);
  }
  for (const activity of activityRows) {
    const branchId = encodeActivityBranchId(activity);
    const events = eventsByBranch.get(branchId);
    if (!events) {
      continue;
    }
    events.push({
      sourceEventId: activity.sourceEventId,
      occurredAt: activity.occurredAt,
    });
  }
  for (const pullRequest of pullRequests) {
    const branchId = encodeBranchId(pullRequest);
    const events = eventsByBranch.get(branchId);
    if (!events) {
      continue;
    }
    appendPullRequestEvents(events, pullRequest);
  }
  for (const commit of commits) {
    const branchId = encodeBranchId(commit);
    const events = eventsByBranch.get(branchId);
    if (!events) {
      continue;
    }
    events.push({
      sourceEventId: `commit:${commit.repoFullName ?? ""}:${commit.sha}`,
      occurredAt: commit.committedAt,
    });
  }

  return new Map(
    branchIds.map((branchId) => [
      branchId,
      calculateBranchLastActiveMetric(
        eventsByBranch.get(branchId) ?? [],
        // Desktop's persisted sources do not prove complete historical
        // coverage. A timestamp is therefore Partial, while no evidence stays
        // Unavailable, matching the cloud projection's conservative contract.
        false
      ),
    ])
  );
}

/** Project cohort Last-active evidence from the exact row results. */
export function canonicalLastActiveEvidenceFromRows(
  rows: readonly BranchRow[]
): {
  events: readonly BranchActivityEvent[];
  coverageComplete: boolean;
} {
  return {
    events: rows.flatMap((row) => {
      const value = row.canonicalLastActiveAt?.value;
      return value
        ? [{ sourceEventId: `branch:${row.id}`, occurredAt: value }]
        : [];
    }),
    coverageComplete: rows.every(
      (row) =>
        row.canonicalLastActiveAt?.state === BranchMetricAvailability.Complete
    ),
  };
}

type BranchActivityEvent = {
  sourceEventId: string;
  occurredAt: string | null;
};

function encodeActivityBranchId(row: BranchCanonicalActivityRow): string {
  return encodeBranchId({
    repoFullName: row.repoFullName,
    branchName: row.branchName,
  });
}

function appendPullRequestEvents(
  events: BranchActivityEvent[],
  pullRequest: BranchPrRow
): void {
  const identity = `${pullRequest.repoFullName ?? ""}#${pullRequest.prNumber}`;
  for (const [kind, occurredAt] of [
    ["opened", pullRequest.openedAt],
    ["merged", pullRequest.mergedAt],
    ["closed", pullRequest.closedAt],
  ] as const) {
    if (occurredAt) {
      events.push({
        sourceEventId: `pr:${identity}:${kind}`,
        occurredAt,
      });
    }
  }
}
