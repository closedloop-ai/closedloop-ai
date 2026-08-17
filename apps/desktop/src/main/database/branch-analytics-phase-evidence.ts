import {
  activeWriteLinkSql,
  BRANCH_LINKED_SESSION_SUBQUERY,
  type BranchKeyRow,
  type BranchLifecycleEventRawRow,
  type BranchLifecycleEventRow,
  mapBranchLifecycleEventRows,
} from "./branch-reads.js";
import type { DbHostPrisma } from "./prisma-client.js";

/** Persisted classifier span used by the corpus-wide canonical metric fold. */
export type BranchActivitySegmentRow = {
  sessionId: string;
  phase: string;
  startMs: number;
  endMs: number;
  confidence: number;
};

export type BoundedBranchEvidenceRows<Row> = {
  rows: Row[];
  capped: boolean;
};

/** Read a fixed request-wide pool of classifier spans for Branch-linked Sessions. */
export function readBranchAnalyticsActivitySegmentRows(
  prisma: DbHostPrisma,
  branchKeys?: readonly BranchKeyRow[]
): Promise<BoundedBranchEvidenceRows<BranchActivitySegmentRow>> {
  if (branchKeys?.length === 0) {
    return Promise.resolve({ rows: [], capped: false });
  }
  const cohortScope = buildBranchCohortSqlScope(branchKeys);
  return prisma.client
    .$queryRawUnsafe<
      {
        session_id: string;
        phase: string;
        start_ms: number | bigint;
        end_ms: number | bigint;
        confidence: number;
      }[]
    >(
      `${cohortScope.cte}SELECT session_id, phase, start_ms, end_ms, confidence
       FROM session_activity_segments
       WHERE session_id IN (${cohortScope.sessionSubquery})
       ORDER BY session_id ASC, start_ms ASC, id ASC
       LIMIT ${BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS + 1}`,
      ...cohortScope.parameters
    )
    .then((rows) => ({
      rows: rows
        .slice(0, BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS)
        .map((row) => ({
          sessionId: row.session_id,
          phase: row.phase,
          startMs: Number(row.start_ms),
          endMs: Number(row.end_ms),
          confidence: row.confidence,
        })),
      capped: rows.length > BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS,
    }));
}

/** Read lifecycle evidence for every Branch-linked Session in one bounded scan. */
export function readBranchAnalyticsLifecycleEventRows(
  prisma: DbHostPrisma,
  branchKeys?: readonly BranchKeyRow[]
): Promise<BoundedBranchEvidenceRows<BranchLifecycleEventRow>> {
  if (branchKeys?.length === 0) {
    return Promise.resolve({ rows: [], capped: false });
  }
  const cohortScope = buildBranchCohortSqlScope(branchKeys);
  return prisma.client
    .$queryRawUnsafe<BranchLifecycleEventRawRow[]>(
      `WITH ${cohortScope.requestedBranchesCte}pr_branch AS (
         SELECT repo_full_name, pr_number, MAX(branch_name) AS branch_name
         FROM pull_requests
         WHERE branch_name IS NOT NULL AND pr_number IS NOT NULL
         GROUP BY repo_full_name, pr_number
       ),
       branch_sessions AS (
         SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
         FROM session_artifact_links sal
         JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
         ${cohortScope.requestedBranchesJoin}
         WHERE a.branch_name IS NOT NULL
           AND ${activeWriteLinkSql("sal", "a")}
       )
       SELECT DISTINCT
         sal.id AS link_id,
         sal.session_id AS session_id,
         sal.relation AS relation,
         sal.method AS method,
         a.kind AS target_kind,
         bs.repo_full_name AS repo_full_name,
         bs.branch_name AS branch_name,
         CASE
           WHEN a.kind = 'commit' THEN a.committed_at
           ELSE sal.observed_at
         END AS observed_at,
         s.started_at AS session_started_at,
         s.ended_at AS session_ended_at
       FROM branch_sessions bs
       JOIN session_artifact_links sal ON sal.session_id = bs.session_id
       JOIN sessions s ON s.id = sal.session_id
       JOIN artifacts a ON a.id = sal.artifact_id
       LEFT JOIN pr_branch
         ON a.kind = 'pull_request'
        AND pr_branch.pr_number = a.pr_number
        AND pr_branch.repo_full_name IS NOT DISTINCT FROM a.repo_full_name
       WHERE (
           a.kind = 'branch'
           AND a.branch_name = bs.branch_name
           AND a.repo_full_name IS NOT DISTINCT FROM bs.repo_full_name
         )
         OR (
           a.kind = 'pull_request'
           AND COALESCE(a.branch_name, pr_branch.branch_name) = bs.branch_name
           AND a.repo_full_name IS NOT DISTINCT FROM bs.repo_full_name
         )
         OR (
           a.kind = 'commit'
           AND a.branch_name = bs.branch_name
           AND a.repo_full_name IS NOT DISTINCT FROM bs.repo_full_name
           AND a.committed_at IS NOT NULL
       )
       ORDER BY sal.session_id ASC, observed_at ASC, sal.id ASC
       LIMIT ${BRANCH_ANALYTICS_LIFECYCLE_EVENT_MAX_ROWS + 1}`,
      ...cohortScope.parameters
    )
    .then((rows) => ({
      rows: mapBranchLifecycleEventRows(
        rows.slice(0, BRANCH_ANALYTICS_LIFECYCLE_EVENT_MAX_ROWS)
      ),
      capped: rows.length > BRANCH_ANALYTICS_LIFECYCLE_EVENT_MAX_ROWS,
    }));
}

/** Shared cap for the canonical activity-segment evidence population. */
export const BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS = 50_000;
const BRANCH_ANALYTICS_LIFECYCLE_EVENT_MAX_ROWS = 10_000;

type BranchCohortSqlScope = {
  cte: string;
  requestedBranchesCte: string;
  requestedBranchesJoin: string;
  sessionSubquery: string;
  parameters: (string | null)[];
};

/** Build a parameterized branch-key join so exact-cohort caps apply after scoping. */
function buildBranchCohortSqlScope(
  branchKeys: readonly BranchKeyRow[] | undefined
): BranchCohortSqlScope {
  if (!branchKeys) {
    return {
      cte: "",
      requestedBranchesCte: "",
      requestedBranchesJoin: "",
      sessionSubquery: BRANCH_LINKED_SESSION_SUBQUERY,
      parameters: [],
    };
  }
  const values = branchKeys.map(() => "(?, ?)").join(", ");
  const requestedBranchesCte = `requested_branches(repo_full_name, branch_name) AS (VALUES ${values}),\n       `;
  const requestedBranchesJoin = `JOIN requested_branches rb
           ON rb.branch_name = a.branch_name
          AND rb.repo_full_name IS NOT DISTINCT FROM a.repo_full_name`;
  return {
    cte: `WITH ${requestedBranchesCte}cohort_sessions AS (
         SELECT DISTINCT sal.session_id
         FROM session_artifact_links sal
         JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
         ${requestedBranchesJoin}
         WHERE ${activeWriteLinkSql("sal", "a")}
       )\n       `,
    requestedBranchesCte,
    requestedBranchesJoin,
    sessionSubquery: "SELECT session_id FROM cohort_sessions",
    parameters: branchKeys.flatMap(({ repoFullName, branchName }) => [
      repoFullName,
      branchName,
    ]),
  };
}
