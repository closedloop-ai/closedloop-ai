import type { BranchPhaseAttributionCompletenessReason } from "@repo/api/src/types/branch-phase-attribution";
import { BranchPhaseAttributionCompletenessReason as PhaseCompletenessReason } from "@repo/api/src/types/branch-phase-attribution";
import type { PrismaClient } from "@repo/database";
import { z } from "zod";
import type { SessionUsage } from "./branch-read-service/session-usage-window";
import { getSessionBranchCounts } from "./session-branch-divisor";

const CANONICAL_METRIC_SESSION_MAX = 1000;
const UUID_SCHEMA = z.uuid();

/** Whether a cloud Branch id satisfies the persisted UUID identity contract. */
export function isValidCloudBranchId(value: string): boolean {
  return UUID_SCHEMA.safeParse(value).success;
}

/** Return the non-date cohort when a metric request carries a date boundary. */
export function resolveCanonicalMetricCohort<Row, Query extends object>(
  query: Query & { startDate?: unknown; endDate?: unknown },
  windowedRows: Row[],
  loadNonDateCohort: (query: Query) => Promise<Row[]>
): Promise<Row[]> {
  if (!(query.startDate || query.endDate)) {
    return Promise.resolve(windowedRows);
  }
  return loadNonDateCohort({
    ...query,
    startDate: undefined,
    endDate: undefined,
  });
}

/** Preserve selected-PR LOC as the canonical gross-LOC numerator. */
export function selectedPullRequestLoc(
  pullRequest:
    | { additions: number | null; deletions: number | null }
    | null
    | undefined
): { additions: number | null; deletions: number | null } | null {
  if (!pullRequest) {
    return null;
  }
  return {
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
  };
}

/** Bound corpus-wide metric hydration and stamp the global even-split divisor. */
export async function prepareCanonicalMetricUsage(
  db: Pick<PrismaClient, "artifactLink">,
  organizationId: string,
  usageByBranch: ReadonlyMap<string, SessionUsage>
): Promise<{
  usageByBranch: Map<string, SessionUsage>;
  coverageReasons: BranchPhaseAttributionCompletenessReason[];
}> {
  const sessionIds = [
    ...new Set(
      [...usageByBranch.values()].flatMap((usage) => usage.sessionIds)
    ),
  ].sort();
  const admittedSessionIds = sessionIds.slice(0, CANONICAL_METRIC_SESSION_MAX);
  const admitted = new Set(admittedSessionIds);
  const branchCounts = await getSessionBranchCounts(
    db,
    organizationId,
    admittedSessionIds
  );
  const prepared = new Map<string, SessionUsage>();
  for (const [branchId, usage] of usageByBranch) {
    prepared.set(branchId, {
      ...usage,
      sessions: usage.sessions.flatMap((session) =>
        admitted.has(session.sessionId)
          ? [
              {
                ...session,
                branchCount: branchCounts.get(session.sessionId) ?? 1,
              },
            ]
          : []
      ),
    });
  }
  return {
    usageByBranch: prepared,
    coverageReasons:
      admittedSessionIds.length === sessionIds.length
        ? []
        : [PhaseCompletenessReason.CoverageCapped],
  };
}
