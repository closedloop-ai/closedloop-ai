import {
  type InsightsGitHubProvenance,
  InsightsGitHubProvenanceState,
  InsightsScope,
  type ReviewerRow,
} from "@repo/api/src/types/insights";
import { Prisma, ReviewDecision, withDb } from "@repo/database";
import { resolveGitHubDataConnectionStatus } from "@/app/integrations/github/data-connection-status";
import type { InsightsScopeContext } from "./scope";

/**
 * Per-reviewer load for the org-scope "reviewer load" table: review count,
 * approval count, and median PR-open→review wait, all rolled up in Postgres via
 * a single GROUP BY author_login scan. Replaces materializing every review row
 * org-wide (unbounded for the "all" period, which starts at the epoch) and
 * reducing to per-author aggregates in JS. Raw SQL because the per-group median
 * (`percentile_cont`) has no Prisma `groupBy` expression.
 *
 * Org-scope only (the sole caller guards on {@link isOrgScope}), so the scope is
 * just the branch artifact's org — no per-user/team predicate like
 * {@link artifactScope}. The wait mirrors the prior JS `wait >= 0` guard with a
 * `FILTER (WHERE r.submitted_at >= a.created_at)`, so reviews submitted before
 * their branch's recorded open time are excluded from the median (and the median
 * is NULL when a reviewer has no non-negative wait), matching `median([]) → null`.
 * `submitted_at - created_at` is an interval; EXTRACT(EPOCH ...)*1000 yields the
 * same millisecond wait the JS path derived from `getTime()` deltas.
 */
export async function fetchReviewerLoad(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<ReviewerRow[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<
      {
        reviewer: string;
        reviewed: number;
        approved: number;
        median_wait_ms: number | null;
      }[]
    >(
      Prisma.sql`
        SELECT
          r.author_login AS reviewer,
          COUNT(*)::int AS reviewed,
          COUNT(*) FILTER (WHERE r.state::text = ${ReviewDecision.APPROVED})::int
            AS approved,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (r.submitted_at - a.created_at)) * 1000
          ) FILTER (WHERE r.submitted_at >= a.created_at) AS median_wait_ms
        FROM github_pr_reviews r
        JOIN pull_request_detail p ON p.id = r.pull_request_id
        JOIN artifacts a ON a.id = p.branch_artifact_id
        WHERE r.submitted_at >= ${start}
          AND r.submitted_at <= ${end}
          AND a.organization_id = ${ctx.organizationId}::uuid
        GROUP BY r.author_login
        ORDER BY reviewed DESC, reviewer ASC
      `
    )
  );
  return rows.map((row) => ({
    reviewer: row.reviewer,
    reviewed: row.reviewed,
    approved: row.approved,
    medianWaitMs:
      row.median_wait_ms === null ? null : Number(row.median_wait_ms),
  }));
}

export async function resolveGitHubProvenance(
  ctx: InsightsScopeContext
): Promise<InsightsGitHubProvenance | null> {
  if (ctx.scope === InsightsScope.Me) {
    return null;
  }
  const githubDataConnection = await withDb((db) =>
    resolveGitHubDataConnectionStatus(db, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    })
  );
  return {
    state: githubDataConnection.connected
      ? InsightsGitHubProvenanceState.Active
      : InsightsGitHubProvenanceState.Disconnected,
    checkedAt: new Date().toISOString(),
  };
}
