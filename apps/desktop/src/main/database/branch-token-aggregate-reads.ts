import { branchUsageTokenCount } from "./branch-usage-token-counts.js";
import type { DbHostPrisma } from "./prisma-client.js";

/** Branch identity accepted by the branch-scoped aggregate read. */
export type BranchTokenAggregateKey = {
  repoFullName: string | null;
  branchName: string;
};

/** Per-`(branch, model)` token totals and both compatible cost interpretations. */
export type BranchTokenAggregateRow = {
  repoFullName: string | null;
  branchName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Raw replicated session cost retained for `estimatedCostUsd` compatibility. */
  rawCostUsdEstimated: number | null;
  /** Canonical cost attributed by even-splitting shared sessions once. */
  costUsdEstimated: number | null;
};

type BranchTokenAggregateRawRow = {
  repo_full_name: string | null;
  branch_name: string;
  model: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  raw_cost_usd_estimated: number | null;
  cost_usd_estimated: number | null;
};

type ActiveWriteLinkSql = (linkAlias: string, artifactAlias: string) => string;

/**
 * Read all Desktop branch/model aggregates while keeping Product output and
 * the attribution divisor under separate authorities (both publication-gated
 * since ISS-8148).
 */
export function queryBranchTokenAggregateRows(
  prisma: DbHostPrisma,
  activeWriteLinkSql: ActiveWriteLinkSql,
  visibleKeys?: readonly BranchTokenAggregateKey[],
  denominatorKeys: readonly BranchTokenAggregateKey[] | undefined = visibleKeys
): Promise<BranchTokenAggregateRow[]> {
  if (visibleKeys?.length === 0) {
    return Promise.resolve([]);
  }
  return prisma.client
    .$queryRawUnsafe<BranchTokenAggregateRawRow[]>(
      branchTokenAggregateSql(
        activeWriteLinkSql,
        false,
        visibleKeys,
        denominatorKeys
      ),
      ...serializeEligibilityParameters(visibleKeys, denominatorKeys)
    )
    .then(mapBranchTokenAggregateRows);
}

/**
 * Read one Product-visible branch while retaining the global
 * publication-gated denominator used to attribute its shared Session cost.
 */
export function queryBranchTokenAggregateRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchTokenAggregateKey,
  activeWriteLinkSql: ActiveWriteLinkSql,
  visibleKeys?: readonly BranchTokenAggregateKey[],
  denominatorKeys: readonly BranchTokenAggregateKey[] | undefined = visibleKeys
): Promise<BranchTokenAggregateRow[]> {
  if (visibleKeys?.length === 0) {
    return Promise.resolve([]);
  }
  return prisma.client
    .$queryRawUnsafe<BranchTokenAggregateRawRow[]>(
      branchTokenAggregateSql(
        activeWriteLinkSql,
        true,
        visibleKeys,
        denominatorKeys
      ),
      ...serializeEligibilityParameters(visibleKeys, denominatorKeys),
      key.branchName,
      key.repoFullName
    )
    .then(mapBranchTokenAggregateRows);
}

function branchTokenAggregateSql(
  activeWriteLinkSql: ActiveWriteLinkSql,
  scoped: boolean,
  visibleKeys?: readonly BranchTokenAggregateKey[],
  denominatorKeys?: readonly BranchTokenAggregateKey[]
): string {
  const visibleArtifactSql = visibleKeys
    ? `AND EXISTS (
           SELECT 1 FROM visible_branches vb
           WHERE vb.branch_name = a.branch_name
             AND vb.repo_full_name IS a.repo_full_name
         )`
    : "";
  const denominatorArtifactSql = denominatorKeys
    ? `AND EXISTS (
           SELECT 1 FROM denominator_branches db
           WHERE db.branch_name = a2.branch_name
             AND db.repo_full_name IS a2.repo_full_name
         )`
    : "";
  const scopeSql = scoped
    ? `a.branch_name = ?
             AND a.repo_full_name IS NOT DISTINCT FROM ?
             AND`
    : "a.branch_name IS NOT NULL AND";
  const orderSql = scoped
    ? "ORDER BY t.model ASC"
    : "ORDER BY l.branch_name ASC, t.model ASC";

  return `WITH ${branchTokenAggregateCtes({
    activeWriteLinkSql,
    denominatorArtifactSql,
    scopeSql,
    visibleArtifactSql,
    visibleKeys,
    denominatorKeys,
  }).join(",\n")}
       SELECT
         l.repo_full_name AS repo_full_name,
         l.branch_name AS branch_name,
         t.model AS model,
         ${branchEvenSplitTokenTextSql("t.input_tokens", "t.baseline_input", "l.branch_count")} AS input_tokens,
         ${branchEvenSplitTokenTextSql("t.output_tokens", "t.baseline_output", "l.branch_count")} AS output_tokens,
         ${branchEvenSplitTokenTextSql("t.cache_read_tokens", "t.baseline_cache_read", "l.branch_count")} AS cache_read_tokens,
         ${branchEvenSplitTokenTextSql("t.cache_write_tokens", "t.baseline_cache_write", "l.branch_count")} AS cache_write_tokens,
         SUM(t.cost_usd_estimated) AS raw_cost_usd_estimated,
         SUM(t.cost_usd_estimated / CAST(l.branch_count AS REAL)) AS cost_usd_estimated
       FROM token_usage t
       JOIN visible_session_branches_with_counts l
         ON l.session_id = t.session_id
       GROUP BY l.repo_full_name, l.branch_name, t.model
       ${orderSql}`;
}

function serializeEligibilityParameters(
  visibleKeys?: readonly BranchTokenAggregateKey[],
  denominatorKeys?: readonly BranchTokenAggregateKey[]
): string[] {
  const parameters: string[] = [];
  if (visibleKeys) {
    parameters.push(serializeEligibleKeys(visibleKeys));
  }
  if (denominatorKeys) {
    parameters.push(serializeEligibleKeys(denominatorKeys));
  }
  return parameters;
}

function serializeEligibleKeys(
  keys: readonly BranchTokenAggregateKey[]
): string {
  return JSON.stringify(
    keys.map((key) => ({
      repoFullName: key.repoFullName,
      branchName: key.branchName,
    }))
  );
}

function mapBranchTokenAggregateRows(
  rows: BranchTokenAggregateRawRow[]
): BranchTokenAggregateRow[] {
  return rows.map((row) => ({
    repoFullName: row.repo_full_name,
    branchName: row.branch_name,
    model: row.model,
    inputTokens: tokenCount(row.input_tokens, "branch.input_tokens"),
    outputTokens: tokenCount(row.output_tokens, "branch.output_tokens"),
    cacheReadTokens: tokenCount(
      row.cache_read_tokens,
      "branch.cache_read_tokens"
    ),
    cacheWriteTokens: tokenCount(
      row.cache_write_tokens,
      "branch.cache_write_tokens"
    ),
    rawCostUsdEstimated:
      row.raw_cost_usd_estimated == null
        ? null
        : Number(row.raw_cost_usd_estimated),
    costUsdEstimated:
      row.cost_usd_estimated == null ? null : Number(row.cost_usd_estimated),
  }));
}

function branchEvenSplitTokenTextSql(
  tokenColumn: string,
  baselineColumn: string,
  branchCountColumn: string
): string {
  return `CAST(CAST(SUM((COALESCE(${tokenColumn}, 0) + COALESCE(${baselineColumn}, 0)) / CAST(${branchCountColumn} AS REAL)) AS INTEGER) AS TEXT)`;
}

function tokenCount(value: unknown, fieldName: string): number {
  return branchUsageTokenCount(value, fieldName);
}

function branchTokenAggregateCtes(input: {
  activeWriteLinkSql: ActiveWriteLinkSql;
  denominatorArtifactSql: string;
  scopeSql: string;
  visibleArtifactSql: string;
  visibleKeys?: readonly BranchTokenAggregateKey[];
  denominatorKeys?: readonly BranchTokenAggregateKey[];
}): string[] {
  const ctes: string[] = [];
  if (input.visibleKeys) {
    ctes.push(`visible_branches AS (
          SELECT json_extract(value, '$.repoFullName') AS repo_full_name,
                 json_extract(value, '$.branchName') AS branch_name
          FROM json_each(?)
        )`);
  }
  if (input.denominatorKeys) {
    ctes.push(`denominator_branches AS (
          SELECT json_extract(value, '$.repoFullName') AS repo_full_name,
                 json_extract(value, '$.branchName') AS branch_name
          FROM json_each(?)
        )`);
  }
  ctes.push(
    `visible_session_branches AS (
          SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
          FROM session_artifact_links sal
          JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
          WHERE ${input.scopeSql} ${input.activeWriteLinkSql("sal", "a")}
            ${input.visibleArtifactSql}
        )`,
    `visible_sessions AS (
          SELECT DISTINCT session_id FROM visible_session_branches
        )`,
    `denominator_session_branches AS (
          SELECT DISTINCT sal2.session_id, a2.repo_full_name, a2.branch_name
          FROM session_artifact_links sal2
          JOIN visible_sessions visible
            ON visible.session_id = sal2.session_id
          JOIN artifacts a2 ON a2.id = sal2.artifact_id AND a2.kind = 'branch'
          WHERE a2.branch_name IS NOT NULL
            AND ${input.activeWriteLinkSql("sal2", "a2")}
            ${input.denominatorArtifactSql}
        )`,
    `denominator_session_branch_counts AS (
          SELECT session_id, COUNT(*) AS branch_count
          FROM denominator_session_branches
          GROUP BY session_id
        )`,
    `visible_session_branches_with_counts AS (
          SELECT visible.session_id, visible.repo_full_name, visible.branch_name,
                 COALESCE(counts.branch_count, 0) AS branch_count
          FROM visible_session_branches visible
          LEFT JOIN denominator_session_branch_counts counts
            ON counts.session_id = visible.session_id
        )`
  );
  return ctes;
}
