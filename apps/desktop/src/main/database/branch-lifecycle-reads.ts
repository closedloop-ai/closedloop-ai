import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import {
  branchLifecycleEventsForBranchLink,
  branchLifecycleEventsForPrLink,
} from "./branch-lifecycle-events.js";
import type {
  BranchKeyRow,
  BranchLifecycleEventRawRow,
  BranchLifecycleEventRow,
  BranchSessionTokenRow,
} from "./branch-reads.js";
import { branchUsageTokenCount } from "./branch-usage-token-counts.js";
import type { DbHostPrisma } from "./prisma-client.js";

type ActiveWriteLinkSql = (linkAlias: string, artifactAlias: string) => string;

/** Sum one compacted token column as TEXT before the lenient read boundary. */
function branchSumTokenTextSql(
  tokenColumn: string,
  baselineColumn: string
): string {
  return `CAST(CAST(SUM(COALESCE(${tokenColumn}, 0) + COALESCE(${baselineColumn}, 0)) AS INTEGER) AS TEXT)`;
}

type BranchSessionTokenRawRow = {
  session_id: string;
  branch_count: number | bigint | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cost_usd_estimated: number | null;
  even_split_cost_usd: number | null;
};

/**
 * Lifecycle boundary evidence for one branch detail. The branch session set is
 * first narrowed by the existing active-write predicate; read-only links never
 * create branch membership, but same-branch read-only PR/branch evidence from
 * those member sessions can still produce an `unknown` lifecycle segment.
 */
export function readBranchLifecycleEventRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchKeyRow,
  activeWriteLinkSql: ActiveWriteLinkSql
): Promise<BranchLifecycleEventRow[]> {
  return prisma.client
    .$queryRawUnsafe<BranchLifecycleEventRawRow[]>(
      `WITH pr_branch AS (
         SELECT repo_full_name, pr_number, MAX(branch_name) AS branch_name
         FROM pull_requests
         WHERE branch_name IS NOT NULL AND pr_number IS NOT NULL
         GROUP BY repo_full_name, pr_number
       ),
       branch_sessions AS (
         SELECT DISTINCT sal.session_id
         FROM session_artifact_links sal
         JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
         WHERE a.branch_name = ?
           AND a.repo_full_name IS NOT DISTINCT FROM ?
           AND ${activeWriteLinkSql("sal", "a")}
       )
       SELECT DISTINCT
         sal.id AS link_id,
         sal.session_id AS session_id,
         sal.relation AS relation,
         sal.method AS method,
         a.kind AS target_kind,
         a.repo_full_name AS repo_full_name,
         CASE
           WHEN a.kind = 'pull_request' THEN COALESCE(a.branch_name, pr_branch.branch_name)
           ELSE a.branch_name
         END AS branch_name,
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
           AND a.branch_name = ?
           AND a.repo_full_name IS NOT DISTINCT FROM ?
         )
         OR (
           a.kind = 'pull_request'
           AND COALESCE(a.branch_name, pr_branch.branch_name) = ?
           AND a.repo_full_name IS NOT DISTINCT FROM ?
         )
         OR (
           a.kind = 'commit'
           AND a.branch_name = ?
           AND a.repo_full_name IS NOT DISTINCT FROM ?
           AND a.committed_at IS NOT NULL
         )
       ORDER BY sal.session_id ASC, sal.observed_at ASC, sal.id ASC`,
      key.branchName,
      key.repoFullName,
      key.branchName,
      key.repoFullName,
      key.branchName,
      key.repoFullName,
      key.branchName,
      key.repoFullName
    )
    .then(mapBranchLifecycleEventRows);
}

/**
 * Per-session full token totals and branch-attributed cost for one branch
 * detail. The denominator is the session's global active-write branch count,
 * matching `readBranchTokenAggregateRowsForBranch` exactly.
 */
export function readBranchSessionTokenRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchKeyRow,
  activeWriteLinkSql: ActiveWriteLinkSql,
  denominatorKeys?: readonly BranchKeyRow[]
): Promise<BranchSessionTokenRow[]> {
  const denominatorCte = denominatorKeys
    ? `denominator_branches AS (
         SELECT json_extract(value, '$.repoFullName') AS repo_full_name,
                json_extract(value, '$.branchName') AS branch_name
         FROM json_each(?)
       ),`
    : "";
  const denominatorSql = denominatorKeys
    ? `AND EXISTS (
           SELECT 1 FROM denominator_branches db
           WHERE db.branch_name = a2.branch_name
             AND db.repo_full_name IS a2.repo_full_name
         )`
    : "";
  const parameters: unknown[] = denominatorKeys
    ? [JSON.stringify(denominatorKeys)]
    : [];
  return prisma.client
    .$queryRawUnsafe<BranchSessionTokenRawRow[]>(
      `WITH ${denominatorCte}
       branch_session_counts AS (
         SELECT d.session_id,
                (SELECT COUNT(*) FROM (
                   SELECT DISTINCT sal2.session_id, a2.repo_full_name, a2.branch_name
                   FROM session_artifact_links sal2
                   JOIN artifacts a2 ON a2.id = sal2.artifact_id AND a2.kind = 'branch'
                   WHERE a2.branch_name IS NOT NULL AND sal2.session_id = d.session_id
                     AND ${activeWriteLinkSql("sal2", "a2")}
                     ${denominatorSql}
                )) AS branch_count
         FROM (
           SELECT DISTINCT sal.session_id
           FROM session_artifact_links sal
           JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
           WHERE a.branch_name = ?
             AND a.repo_full_name IS NOT DISTINCT FROM ?
             AND ${activeWriteLinkSql("sal", "a")}
         ) d
       )
       SELECT
         bsc.session_id AS session_id,
         bsc.branch_count AS branch_count,
         ${branchSumTokenTextSql("t.input_tokens", "t.baseline_input")} AS input_tokens,
         ${branchSumTokenTextSql("t.output_tokens", "t.baseline_output")} AS output_tokens,
         ${branchSumTokenTextSql("t.cache_read_tokens", "t.baseline_cache_read")} AS cache_read_tokens,
         ${branchSumTokenTextSql("t.cache_write_tokens", "t.baseline_cache_write")} AS cache_write_tokens,
         SUM(t.cost_usd_estimated) AS cost_usd_estimated,
         SUM(t.cost_usd_estimated / CAST(bsc.branch_count AS REAL)) AS even_split_cost_usd
       FROM branch_session_counts bsc
       LEFT JOIN token_usage t ON t.session_id = bsc.session_id
       GROUP BY bsc.session_id, bsc.branch_count
       ORDER BY bsc.session_id ASC`,
      ...parameters,
      key.branchName,
      key.repoFullName
    )
    .then(mapBranchSessionTokenRows);
}

export function mapBranchLifecycleEventRows(
  rows: BranchLifecycleEventRawRow[]
): BranchLifecycleEventRow[] {
  const lifecycleRows: BranchLifecycleEventRow[] = [];
  for (const row of rows) {
    if (row.branch_name === null) {
      continue;
    }
    const relation = toArtifactRefRelation(row.relation);
    const events =
      row.target_kind === ArtifactRefTargetKind.Branch ||
      row.target_kind === ArtifactRefTargetKind.Commit
        ? branchLifecycleEventsForBranchLink({
            linkId: row.link_id,
            method: row.method,
            observedAt: row.observed_at,
            relation,
          })
        : branchLifecycleEventsForPrLink({
            linkId: row.link_id,
            method: row.method,
            observedAt: row.observed_at,
            relation,
          });
    for (const event of events) {
      lifecycleRows.push({
        repoFullName: row.repo_full_name,
        branchName: row.branch_name,
        sessionId: row.session_id,
        sessionStartedAt: row.session_started_at,
        sessionEndedAt: row.session_ended_at,
        kind: event.kind,
        observedAt: event.observedAt ?? null,
        evidenceId: event.evidenceId ?? null,
        method: row.method,
      });
    }
  }
  return lifecycleRows.sort(compareBranchLifecycleEventRows);
}

function compareBranchLifecycleEventRows(
  left: BranchLifecycleEventRow,
  right: BranchLifecycleEventRow
): number {
  const sessionOrder = left.sessionId.localeCompare(right.sessionId);
  if (sessionOrder !== 0) {
    return sessionOrder;
  }
  const timestampOrder = compareLifecycleTimestamp(
    left.observedAt,
    right.observedAt
  );
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  return branchLifecycleEventKey(left).localeCompare(
    branchLifecycleEventKey(right)
  );
}

function compareLifecycleTimestamp(
  left: string | null,
  right: string | null
): number {
  const leftTime = lifecycleTimestampSortValue(left);
  const rightTime = lifecycleTimestampSortValue(right);
  return leftTime === rightTime ? 0 : leftTime - rightTime;
}

function lifecycleTimestampSortValue(value: string | null): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function branchLifecycleEventKey(row: BranchLifecycleEventRow): string {
  return `${row.kind}|${row.observedAt ?? ""}|${row.evidenceId ?? ""}`;
}

function mapBranchSessionTokenRows(
  rows: BranchSessionTokenRawRow[]
): BranchSessionTokenRow[] {
  return rows.map((row) => {
    const branchCount = Math.max(1, Number(row.branch_count ?? 1));
    return {
      sessionId: row.session_id,
      branchCount,
      inputTokens: tokenCount(row.input_tokens, "branch_session.input_tokens"),
      outputTokens: tokenCount(
        row.output_tokens,
        "branch_session.output_tokens"
      ),
      cacheReadTokens: tokenCount(
        row.cache_read_tokens,
        "branch_session.cache_read_tokens"
      ),
      cacheWriteTokens: tokenCount(
        row.cache_write_tokens,
        "branch_session.cache_write_tokens"
      ),
      costUsdEstimated:
        row.cost_usd_estimated == null ? null : Number(row.cost_usd_estimated),
      evenSplitCostUsd:
        row.even_split_cost_usd == null
          ? null
          : Number(row.even_split_cost_usd),
    };
  });
}

function toArtifactRefRelation(
  value: string | null
): ArtifactRefRelation | null {
  if (value === ArtifactRefRelation.Input) {
    return ArtifactRefRelation.Input;
  }
  if (value === ArtifactRefRelation.Output) {
    return ArtifactRefRelation.Output;
  }
  if (value === ArtifactRefRelation.Referenced) {
    return ArtifactRefRelation.Referenced;
  }
  if (value === ArtifactRefRelation.Created) {
    return ArtifactRefRelation.Created;
  }
  if (value === ArtifactRefRelation.Reviewed) {
    return ArtifactRefRelation.Reviewed;
  }
  if (value === ArtifactRefRelation.Workspace) {
    return ArtifactRefRelation.Workspace;
  }
  return null;
}

/**
 * Read a stored token counter for a Branches DISPLAY read, degrading gracefully
 * on a bad value instead of throwing.
 *
 * These mappers serve the read-only Branches usage/analytics views. A single
 * out-of-range counter — e.g. a version-skewed peer/cloud row that widened a
 * count past `Number.MAX_SAFE_INTEGER` (FEA-4280) — must not throw
 * `InvalidTokenCountError` and take down the ENTIRE Branches usage view. So we
 * clamp the offending value to `0` and log the anomaly (desktop main process,
 * not a client bundle) so it stays observable, while the rest of the batch flows
 * through. WRITE/ingest paths keep the strict throwing readers so a bad counter
 * is never persisted.
 */
function tokenCount(value: unknown, fieldName: string): number {
  return branchUsageTokenCount(value, fieldName);
}
