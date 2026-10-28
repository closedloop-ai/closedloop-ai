import { GitHubPRState, Prisma, withDb } from "@repo/database";
import type { BranchMetricPullRequestFacts } from "@repo/lib/branches/branch-pull-request-metrics";
import { PROJECTED_PR_IDENTITY_SQL } from "@/app/insights/merged-pr-queries";
import { toNumber } from "@/lib/prisma-number";
import { orgMergedPullRequestMembershipSql } from "@/lib/pull-request-population";

/** ISS-11589 / ISS-12346: Median PR size and Merge rate, computed in SQL. */

export type PullRequestMetricWindow = {
  key: string;
  /** `null` is unbounded below, the all-time window. */
  startAt: string | null;
  endAt: string;
};

type WindowFactsRow = {
  key: string;
  merged: number | bigint;
  sized: number | bigint;
  median_size: number | null;
  closed_unmerged: number | bigint;
  decided_identities: number | bigint;
  conflicted: boolean;
};

const UNBOUNDED_BELOW = "-infinity";

/**
 * Per-window PR facts for the branches `cohort` (a statement selecting branch
 * artifact ids), over the PRs that count: verified, session-linked, one row per
 * `repo#number` after twin collapse (ISS-11589 rulings D1-D5).
 */
export function readPullRequestMetricFacts(
  organizationId: string,
  cohort: Prisma.Sql,
  windows: readonly PullRequestMetricWindow[]
): Promise<BranchMetricPullRequestFacts> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<WindowFactsRow[]>(
      pullRequestMetricFactsSql(organizationId, cohort, windows)
    );
    return {
      conflicted: rows.some((row) => row.conflicted),
      windows: new Map(
        rows.map((row) => [
          row.key,
          {
            merged: toNumber(row.merged),
            sized: toNumber(row.sized),
            medianSize:
              row.median_size === null ? null : Number(row.median_size),
            closedUnmerged: toNumber(row.closed_unmerged),
            decidedIdentities: toNumber(row.decided_identities),
          },
        ])
      ),
    };
  });
}

export function pullRequestMetricFactsSql(
  organizationId: string,
  cohort: Prisma.Sql,
  windows: readonly PullRequestMetricWindow[]
): Prisma.Sql {
  const keys = windows.map((window) => window.key);
  const starts = windows.map((window) => window.startAt ?? UNBOUNDED_BELOW);
  const ends = windows.map((window) => window.endAt);
  return Prisma.sql`
    WITH counting AS MATERIALIZED (
      SELECT
        p.id,
        ${PROJECTED_PR_IDENTITY_SQL} AS identity,
        p.merged_at,
        p.closed_at,
        COALESCE(p.github_id, '') <> '' AS owned,
        COALESCE(p.additions >= 0 AND p.deletions >= 0, FALSE) AS sized,
        p.additions + p.deletions AS loc,
        (
          p.is_draft
          AND p.merged_at IS NULL
          AND p.pr_state = ${GitHubPRState.CLOSED}::"GitHubPRState"
        ) AS closed_draft
      FROM pull_request_detail p
      LEFT JOIN github_installation_repositories pr_repository
        ON pr_repository.id = p.repository_id
      WHERE p.organization_id = ${organizationId}::uuid
        AND p.branch_artifact_id IN (${cohort})
        AND ${orgMergedPullRequestMembershipSql(organizationId)}
    ),
    -- isClosedUnmergedDraft, operator ruling 2026-10-14: a pull request whose
    -- representative row (the twin order below) is a closed, unmerged draft is
    -- left out of every count, on Branches and Insights alike (COMMON-014).
    excluded AS MATERIALIZED (
      SELECT identity FROM (
        SELECT DISTINCT ON (identity) identity, closed_draft
        FROM counting
        ORDER BY identity, sized DESC, owned DESC, id
      ) representative
      WHERE closed_draft
    ),
    identity_state AS MATERIALIZED (
      SELECT
        identity,
        COUNT(DISTINCT (
          COALESCE(merged_at::text, '') || '|' || COALESCE(closed_at::text, '')
        )) > 1 AS lifecycle_conflict,
        (
          COUNT(DISTINCT loc) FILTER (WHERE sized AND owned) > 1
          OR COUNT(DISTINCT loc) FILTER (WHERE sized AND NOT owned) > 1
        ) AS unsettled
      FROM counting
      GROUP BY identity
    ),
    twin AS MATERIALIZED (
      SELECT DISTINCT ON (c.identity) c.identity, c.merged_at, c.closed_at, c.sized, c.loc
      FROM counting c
      INNER JOIN identity_state s ON s.identity = c.identity
      WHERE NOT s.lifecycle_conflict
        AND c.identity NOT IN (SELECT identity FROM excluded)
      ORDER BY c.identity, c.sized DESC, c.owned DESC, c.id
    ),
    flags AS (
      SELECT COALESCE(BOOL_OR(lifecycle_conflict OR unsettled), FALSE) AS conflicted
      FROM identity_state
    ),
    windows AS (
      SELECT w.key, w.start_at, w.end_at
      FROM unnest(
        ${keys}::text[],
        ${starts}::timestamptz[],
        ${ends}::timestamptz[]
      ) AS w(key, start_at, end_at)
    ),
    decided AS (
      SELECT w.key, COUNT(DISTINCT c.identity) AS decided_identities
      FROM windows w
      LEFT JOIN counting c
        ON (
          (c.merged_at >= w.start_at AND c.merged_at < w.end_at)
          OR (c.merged_at IS NULL AND c.closed_at >= w.start_at AND c.closed_at < w.end_at)
        )
        AND c.identity NOT IN (SELECT identity FROM excluded)
      GROUP BY w.key
    ),
    folded AS (
      SELECT
        w.key,
        COUNT(t.identity) FILTER (
          WHERE t.merged_at >= w.start_at AND t.merged_at < w.end_at
        )::int AS merged,
        COUNT(t.identity) FILTER (
          WHERE t.merged_at >= w.start_at AND t.merged_at < w.end_at AND t.sized
        )::int AS sized,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY t.loc) FILTER (
          WHERE t.merged_at >= w.start_at AND t.merged_at < w.end_at AND t.sized
        ) AS median_size,
        COUNT(t.identity) FILTER (
          WHERE t.merged_at IS NULL
            AND t.closed_at >= w.start_at AND t.closed_at < w.end_at
        )::int AS closed_unmerged
      FROM windows w
      LEFT JOIN twin t ON TRUE
      GROUP BY w.key
    )
    SELECT
      folded.key,
      folded.merged,
      folded.sized,
      folded.median_size,
      folded.closed_unmerged,
      decided.decided_identities::int AS decided_identities,
      flags.conflicted
    FROM folded
    INNER JOIN decided ON decided.key = folded.key
    CROSS JOIN flags`;
}
