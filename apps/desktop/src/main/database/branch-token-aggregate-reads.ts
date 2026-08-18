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
 * Read all Desktop branch/model aggregates while keeping Product output and the
 * pre-publication attribution divisor under separate authorities.
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
 * Read one Product-visible branch while retaining the global pre-publication
 * denominator used to attribute its shared Session cost.
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
  const eligibilityCte = eligibilityCteSql(visibleKeys, denominatorKeys);
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

  return `${eligibilityCte}
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
       JOIN (
         SELECT d.session_id, d.repo_full_name, d.branch_name,
                (SELECT COUNT(*) FROM (
                   SELECT DISTINCT sal2.session_id, a2.repo_full_name, a2.branch_name
                   FROM session_artifact_links sal2
                   JOIN artifacts a2 ON a2.id = sal2.artifact_id AND a2.kind = 'branch'
                   WHERE a2.branch_name IS NOT NULL AND sal2.session_id = d.session_id
                     AND ${activeWriteLinkSql("sal2", "a2")}
                     ${denominatorArtifactSql}
                )) AS branch_count
         FROM (
           SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
           FROM session_artifact_links sal
           JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
           WHERE ${scopeSql} ${activeWriteLinkSql("sal", "a")}
             ${visibleArtifactSql}
         ) d
       ) l ON l.session_id = t.session_id
       GROUP BY l.repo_full_name, l.branch_name, t.model
       ${orderSql}`;
}

function eligibilityCteSql(
  visibleKeys?: readonly BranchTokenAggregateKey[],
  denominatorKeys?: readonly BranchTokenAggregateKey[]
): string {
  const ctes: string[] = [];
  if (visibleKeys) {
    ctes.push(`visible_branches AS (
          SELECT json_extract(value, '$.repoFullName') AS repo_full_name,
                 json_extract(value, '$.branchName') AS branch_name
          FROM json_each(?)
        )`);
  }
  if (denominatorKeys) {
    ctes.push(`denominator_branches AS (
          SELECT json_extract(value, '$.repoFullName') AS repo_full_name,
                 json_extract(value, '$.branchName') AS branch_name
          FROM json_each(?)
        )`);
  }
  return ctes.length > 0 ? `WITH ${ctes.join(",\n")}` : "";
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
