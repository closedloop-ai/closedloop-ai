/**
 * The desktop Sessions usage aggregate's ROW MODEL and its JS folds — the shapes
 * `aggregateSqliteUsage` reads, the fold that turns them into an
 * `AgentSessionUsageAggregate`, the Repository-facet fold, and its durable
 * fill-back. All extracted from `sync-source.ts` (a shrink-only grandfathered
 * file): the Repository fold by ISS-5271, the row model and outer fold by
 * ISS-10573. The grouped SQL itself stays in `sync-source.ts`.
 *
 * The fold resolves each per-(cwd, stored repo) count row to its repository
 * identity STORED-FIRST via the shared `resolveRepositoryFullNameStoredFirst`
 * (see `repository-facet.ts` for the ruled precedence) and merges rows that
 * resolve to one repo. Rows with no stored name are settled by a batched,
 * bounded-concurrency existence probe first, so a corpus dominated by deleted
 * throwaway worktrees pays microseconds per cwd instead of a doomed git spawn.
 *
 * A successful live resolution for a row with no stored name is recorded as a
 * fill-back intent; `applyRepoFullNameFillBacks` persists those AFTER the
 * caller's read has materialized, through the write queue, fill-only — so the
 * next aggregation answers from `sessions.repo_full_name` with zero spawns and
 * the sync lane's live-first per-id writer remains the only overwriter.
 */

import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { AgentSessionUsageAggregate } from "../agent-sync/agent-session-read-model.js";
import { resolveTokenUsageCostUsd } from "../agent-sync/agent-session-token-cost-resolution.js";
import { cwdExists } from "../enrichment/repo-identity.js";
import { tokenCountValue } from "./db-helpers.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { resolveRepositoryFullNameStoredFirst } from "./repository-facet.js";

/** One per-(cwd, stored repo) count row from the usage aggregate's SQL. */
export type UsageRepoCountRow = {
  cwd: string | null;
  repo_full_name: string | null;
  session_count: number | string | null;
};

export type UsageRepoSessionCounts = {
  repoSessionCounts: { repositoryFullName: string; sessionCount: number }[];
  /** cwd → live-resolved repo name, for rows whose stored name was empty. */
  fillBackIntents: Map<string, string>;
};

/** Existence probes run this many at a time — plenty for ~1k stat calls. */
const EXISTENCE_PROBE_CONCURRENCY = 24;

/**
 * Settle every uncovered cwd's existence verdict up front, in parallel, by
 * seeding the per-request attribution cache with `null` for gone cwds — the
 * same verdict a failed spawn produced. The fold (and any later per-row
 * consumer sharing `cache`) then never probes twice for one cwd.
 */
async function probeUncoveredCwds(
  rows: readonly UsageRepoCountRow[],
  cache: SessionAttributionResolverCache
): Promise<void> {
  const uncovered = new Set<string>();
  for (const row of rows) {
    if (row.repo_full_name?.trim()) {
      continue;
    }
    if (row.cwd && !cache.attributionByCwd.has(row.cwd)) {
      uncovered.add(row.cwd);
    }
  }
  const pending = [...uncovered];
  const workers = Array.from(
    { length: Math.min(EXISTENCE_PROBE_CONCURRENCY, pending.length) },
    async () => {
      for (;;) {
        const cwd = pending.pop();
        if (cwd === undefined) {
          return;
        }
        if (!(await cwdExists(cwd))) {
          cache.attributionByCwd.set(cwd, null);
        }
      }
    }
  );
  await Promise.all(workers);
}

/**
 * The Repository-facet fold: stored-first identity per row, merged counts per
 * resolved repo. A row resolving to no identity renders "Unknown" and is not a
 * facet option — dropped here, exactly as the live-first fold dropped it.
 */
export async function resolveUsageRepoSessionCounts(
  rows: readonly UsageRepoCountRow[],
  cache: SessionAttributionResolverCache
): Promise<UsageRepoSessionCounts> {
  await probeUncoveredCwds(rows, cache);
  const fillBackIntents = new Map<string, string>();
  const repoCountByFullName = new Map<string, number>();
  for (const row of rows) {
    const repositoryFullName = await resolveRepositoryFullNameStoredFirst(
      row.cwd,
      row.repo_full_name,
      cache,
      fillBackIntents
    );
    if (repositoryFullName === null) {
      continue;
    }
    repoCountByFullName.set(
      repositoryFullName,
      (repoCountByFullName.get(repositoryFullName) ?? 0) +
        Number(row.session_count ?? 0)
    );
  }
  const repoSessionCounts = [...repoCountByFullName.entries()].map(
    ([repositoryFullName, sessionCount]) => ({
      repositoryFullName,
      sessionCount,
    })
  );
  return { repoSessionCounts, fillBackIntents };
}

/**
 * Durably fill `sessions.repo_full_name` for cwds the fold live-resolved.
 * FILL-ONLY by construction (the WHERE admits only rows the resolver itself
 * treats as empty — NULL or blank-after-trim — mirroring the `?.trim()` guard
 * in `resolveRepositoryFullNameStoredFirst`), so a concurrent sync-lane
 * write-back of a fresher name can never be clobbered — the sync lane's per-id
 * writer stays the only overwriter. Raw SQL (SQLite dialect) because Prisma's
 * typed filter cannot express TRIM(); without it a whitespace-only stored value
 * would be treated as absent by the resolver yet never repaired here, paying
 * the live resolution on every aggregation forever.
 * Best-effort: the read result is already correct, so a failed write is
 * swallowed and the next aggregation simply retries the same fill.
 */
export async function applyRepoFullNameFillBacks(
  prisma: DesktopPrisma,
  fillBackIntents: ReadonlyMap<string, string>
): Promise<void> {
  if (fillBackIntents.size === 0) {
    return;
  }
  try {
    await prisma.write(async (writer) => {
      for (const [cwd, repoFullName] of fillBackIntents) {
        await writer.$executeRawUnsafe(
          `UPDATE sessions SET repo_full_name = ?
           WHERE cwd = ? AND (repo_full_name IS NULL OR TRIM(repo_full_name) = '')`,
          repoFullName,
          cwd
        );
      }
    });
  } catch {
    // Best-effort by design — see the doc comment.
  }
}

/** One grouped `token_usage` × `sessions` row from the usage aggregate's SQL. */
export type UsageTokenGroupRow = {
  billing_mode: string | null;
  harness: string | null;
  model: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  session_count: number | null;
  estimated_cost_usd: number | null;
  invalid_estimated_cost?: number | null;
  unpriced_input_tokens: string | null;
  unpriced_output_tokens: string | null;
  unpriced_cache_read_tokens: string | null;
  unpriced_cache_write_tokens: string | null;
  unpriced_cache_write_1h_tokens: string | null;
};

/** Per-harness session counts — the `totalSessions` basis. */
export type UsageHarnessCountRow = {
  harness: string | null;
  session_count: number | null;
};

/** Per-PRIMARY-model (`sessions.model`) session counts — the Model facet. */
export type UsageModelCountRow = {
  model: string | null;
  session_count: number | null;
};

/** Per-owner session counts — the Owner facet. */
export type UsageUserCountRow = {
  user_id: string | null;
  session_count: number | null;
};

/** MIN/MAX session start across the filtered corpus; NULL over zero rows. */
export type UsageBoundsRow = {
  earliest_session_at: string | null;
  latest_session_at: string | null;
};

/** Everything the usage aggregate's one snapshot transaction materializes. */
export type UsageAggregateRows = {
  tokenRows: readonly UsageTokenGroupRow[];
  harnessRows: readonly UsageHarnessCountRow[];
  primaryModelRows: readonly UsageModelCountRow[];
  userRows: readonly UsageUserCountRow[];
  repoRows: readonly UsageRepoCountRow[];
  boundsRow: UsageBoundsRow | null;
};

/**
 * The JS half of the usage aggregate: grouped rows in, the aggregate the fold in
 * `getSharedAgentSessionUsage` consumes out. Runs strictly AFTER the snapshot
 * transaction has materialized its rows. The optional read-only path suppresses
 * repo fill-back so narrowed Sessions metrics never write while polling.
 */
export async function foldSqliteUsageAggregate(
  prisma: DesktopPrisma,
  rows: UsageAggregateRows,
  cache: SessionAttributionResolverCache,
  readOnly = false
): Promise<AgentSessionUsageAggregate> {
  const {
    tokenRows,
    harnessRows,
    primaryModelRows,
    userRows,
    repoRows,
    boundsRow,
  } = rows;
  const tokenGroups = tokenRows.map((row) => ({
    billingMode: row.billing_mode,
    harness: row.harness,
    model: row.model,
    inputTokens: tokenCountValue(row.input_tokens, "insights.input"),
    outputTokens: tokenCountValue(row.output_tokens, "insights.output"),
    cacheReadTokens: tokenCountValue(
      row.cache_read_tokens,
      "insights.cache_read"
    ),
    cacheWriteTokens: tokenCountValue(
      row.cache_write_tokens,
      "insights.cache_write"
    ),
    sessionCount: Number(row.session_count ?? 0),
    estimatedCostUsd:
      usageAggregateCostUsd(
        row.estimated_cost_usd,
        row.invalid_estimated_cost
      ) +
      (resolveTokenUsageCostUsd({
        session_id: "",
        model: row.model ?? "",
        input_tokens: tokenCountValue(
          row.unpriced_input_tokens,
          "insights.unpriced_input"
        ),
        output_tokens: tokenCountValue(
          row.unpriced_output_tokens,
          "insights.unpriced_output"
        ),
        cache_read_tokens: tokenCountValue(
          row.unpriced_cache_read_tokens,
          "insights.unpriced_cache_read"
        ),
        cache_write_tokens: tokenCountValue(
          row.unpriced_cache_write_tokens,
          "insights.unpriced_cache_write"
        ),
        cache_write_1h_tokens: tokenCountValue(
          row.unpriced_cache_write_1h_tokens,
          "insights.unpriced_cache_write_1h"
        ),
        cost_usd_estimated: null,
      }) ?? 0),
  }));

  const harnessSessionCounts = harnessRows.map((row) => ({
    harness: row.harness,
    sessionCount: Number(row.session_count ?? 0),
  }));

  const primaryModelSessionCounts = primaryModelRows.map((row) => ({
    model: row.model,
    sessionCount: Number(row.session_count ?? 0),
  }));

  const userSessionCounts = userRows.map((row) => ({
    userId: row.user_id,
    sessionCount: Number(row.session_count ?? 0),
  }));

  // ISS-5271: stored-first Repository-facet fold (see session-usage-aggregate).
  // The grouped reads above already materialized their rows. When enabled, the
  // fill-back write runs outside the reader transaction through the write queue.
  // Supersedes the ISS-5272 yield cadence this loop briefly carried: stored-first
  // makes the fold map-lookups plus at most a handful of one-time live
  // resolutions, so there is no per-row execFile await left to yield around.
  const { repoSessionCounts, fillBackIntents } =
    await resolveUsageRepoSessionCounts(repoRows, cache);
  if (!readOnly) {
    await applyRepoFullNameFillBacks(prisma, fillBackIntents);
  }

  const totalSessions = harnessSessionCounts.reduce(
    (sum, entry) => sum + entry.sessionCount,
    0
  );

  return {
    totalSessions,
    earliestSessionAt: boundsRow?.earliest_session_at ?? null,
    latestSessionAt: boundsRow?.latest_session_at ?? null,
    tokenGroups,
    harnessSessionCounts,
    primaryModelSessionCounts,
    userSessionCounts,
    repoSessionCounts,
  };
}

/**
 * The sanitized message a failed usage aggregate rejects with. Carries no SQL,
 * no filesystem path and no driver detail, so the same no-leak contract
 * `runSource` applies at the renderer boundary already holds one layer earlier.
 */
export const USAGE_AGGREGATE_UNAVAILABLE_MESSAGE =
  "local usage aggregate unavailable";

function usageAggregateCostUsd(
  value: number | null,
  invalid: number | null | undefined
): number {
  if (Number(invalid ?? 0) !== 0) {
    throw new Error("Invalid persisted Sessions usage cost aggregate");
  }
  if (value === null) {
    return 0;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid persisted Sessions usage cost aggregate");
  }
  return value;
}
