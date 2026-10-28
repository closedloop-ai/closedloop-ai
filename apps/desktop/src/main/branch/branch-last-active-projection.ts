import { type BranchRow, encodeBranchId } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  type BranchLinkedSessionActivity,
  resolveBranchLastActiveMetric,
} from "@repo/lib/branches/branch-last-active";
import type { BranchCanonicalActivityRow } from "../database/branch-activity-read.js";
import type {
  BranchCommitRow,
  BranchLinkRow,
  BranchPrRow,
} from "../database/branch-reads.js";

/** One operation-scoped canonical Last-active result per encoded Branch id. */
export type DesktopBranchLastActiveProjection = ReadonlyMap<
  string,
  BranchMetricResult<string>
>;

/**
 * Combine persisted monitored activity, commits, and PR lifecycle instants, and
 * resolve them through the shared Branch Last-active definition, which falls
 * back to linked Session last activity (ISS-11915). Link/import/request/passive
 * update times stay excluded.
 */
export function projectDesktopBranchLastActive(
  branchIds: readonly string[],
  activityRows: readonly BranchCanonicalActivityRow[],
  pullRequests: readonly BranchPrRow[],
  commits: readonly BranchCommitRow[],
  links: readonly BranchLinkRow[] = []
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

  const sessionsByBranch = new Map<string, BranchLinkedSessionActivity[]>();
  for (const link of links) {
    const branchId = encodeBranchId(link);
    const sessions = sessionsByBranch.get(branchId) ?? [];
    sessions.push({
      sessionId: link.sessionId,
      lastActivityAt: link.sessionLastActivityAt,
    });
    sessionsByBranch.set(branchId, sessions);
  }
  return new Map(
    branchIds.map((branchId) => [
      branchId,
      resolveBranchLastActiveMetric(
        eventsByBranch.get(branchId) ?? [],
        sessionsByBranch.get(branchId) ?? []
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
