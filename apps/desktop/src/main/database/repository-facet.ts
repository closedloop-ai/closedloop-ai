import {
  resolveSessionAttributionAsync,
  type SessionAttributionResolverCache,
} from "../agent-sync/agent-session-attribution.js";
import type { AgentSessionAnalyticsRepositoryGroup } from "../agent-sync/agent-session-read-model.js";
import { resolveTokenUsageCostUsd } from "../agent-sync/agent-session-token-cost-resolution.js";
import { createAttributionYieldCadence } from "../agent-sync/attribution-path-memo.js";
import { cwdExists } from "../enrichment/repo-identity.js";
import { nullableNumber, tokenCountValue } from "./db-helpers.js";

/**
 * FEA-2038 / FEA-4299: resolve a cwd to its repository identity using the SAME
 * resolver the hydrate/sync path uses (`resolveSessionAttributionAsync` over the
 * shared `cache`), returning the resolved Git remote `repositoryFullName` or
 * `null` when no remote has resolved. This matches `buildAnalytics`'s repository
 * fold (`sessionRepositoryName`) and the rendered Repository column exactly, so
 * the SQL-aggregate facet never invents a `worktreePath`/`cwd`/"unknown" folder
 * option that no row displays and the filter cannot honor. A `null` identity is
 * dropped from the facet by the caller. Cached per cwd by the resolver cache.
 */
async function resolveCwdRepositoryFullName(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): Promise<string | null> {
  const attribution = await resolveSessionAttributionAsync(cwd, cache);
  return attribution?.repositoryFullName ?? null;
}

/**
 * ISS-5271: resolve a (cwd, stored repo_full_name) pair to its repository
 * identity STORED-FIRST. The durable stored `repo_full_name` wins outright; the
 * live cwd git-remote resolution runs only for a row with no stored name whose
 * cwd still exists on disk. This precedence was ruled by ISS-5271 (2026-08-07):
 * the read path must not spawn `git remote get-url origin` per cwd — on a real
 * corpus that was ~1,024 serial spawns per aggregation, almost all for cwds
 * deleted long ago, costing 8-122s per Sessions page turn. The accepted trade:
 * a repo renamed on the remote shows its stored name until the SYNC lane
 * (`resolveSyncAttributions`, which stays live-first as the producer of stored
 * values) writes the fresh name back.
 *
 * Every read consumer shares this helper — the usage aggregate's facet fold,
 * the analytics fold, and the Repository-filter row scan — so the facet's
 * option identity and the filter's row identity cannot drift. Note: the
 * LIST/render hydration path (`resolveSyncAttributions`) stays live-first as
 * the freshness producer, so a row's rendered repo can temporarily differ
 * from its stored-first facet identity until the write-back converges them.
 * Returns `null` only when the stored name is absent AND the live resolution is
 * unavailable (cwd null, deleted, or not a git repo) — such a row renders
 * "Unknown" and is not a facet option, exactly as before.
 *
 * A gone cwd is settled by an existence probe (µs) instead of a doomed spawn,
 * and the verdict is memoized in the per-request `cache` so per-row consumers
 * pay one probe per distinct cwd. When a live resolution succeeds for a row
 * with no stored name, the (cwd → repo) pair is recorded in `fillBackIntents`
 * so the caller can durably fill `sessions.repo_full_name` (fill-only, never
 * overwriting a non-empty stored value) once its read transaction has closed —
 * after which this row never needs live resolution again.
 */
async function resolveRepositoryFullNameStoredFirst(
  cwd: string | null,
  storedRepoFullName: string | null,
  cache: SessionAttributionResolverCache,
  fillBackIntents?: Map<string, string>
): Promise<string | null> {
  const stored = storedRepoFullName?.trim();
  if (stored) {
    return stored;
  }
  if (!cwd) {
    return null;
  }
  const cached = cache.attributionByCwd.get(cwd);
  if (cached !== undefined) {
    return cached?.repositoryFullName ?? null;
  }
  if (!(await cwdExists(cwd))) {
    // Gone cwd → null identity at existence-probe cost (µs, no spawn). Seeding
    // the attribution cache makes later rows with this cwd skip the probe too.
    cache.attributionByCwd.set(cwd, null);
    return null;
  }
  const live = await resolveCwdRepositoryFullName(cwd, cache);
  if (live !== null) {
    fillBackIntents?.set(cwd, live);
  }
  return live;
}

/**
 * FEA-2038: resolve each per-cwd repository row to its `repositoryFullName`,
 * then merge cwds that resolve to one identity — summing the same fields the JS
 * `buildAnalytics`'s repository fold accumulates. Cost is folded from the
 * per-(cwd, model) cost rollup exactly as `aggregateSqliteUsage` does (stored
 * priced cost + `resolveTokenUsageCostUsd` over the unpriced token sums per
 * model), so a row with a null `cost_usd_estimated` is priced via model pricing
 * identically to the hydrate loader's per-row `resolveTokenUsageCostUsd`.
 */
async function resolveAnalyticsRepositoryGroups(
  repoRows: {
    cwd: string | null;
    repo_full_name: string | null;
    session_count: number | string | null;
    input_tokens: string | null;
    output_tokens: string | null;
    error_count: number | string | null;
  }[],
  repoCostRows: {
    cwd: string | null;
    repo_full_name: string | null;
    model: string | null;
    estimated_cost_usd: number | null;
    unpriced_input_tokens: string | null;
    unpriced_output_tokens: string | null;
    unpriced_cache_read_tokens: string | null;
    unpriced_cache_write_tokens: string | null;
    unpriced_cache_write_1h_tokens: string | null;
  }[],
  cache: SessionAttributionResolverCache
): Promise<AgentSessionAnalyticsRepositoryGroup[]> {
  const groups = new Map<string, AgentSessionAnalyticsRepositoryGroup>();
  const ensureGroup = (
    repositoryFullName: string
  ): AgentSessionAnalyticsRepositoryGroup => {
    const existing = groups.get(repositoryFullName);
    if (existing) {
      return existing;
    }
    const created: AgentSessionAnalyticsRepositoryGroup = {
      repositoryFullName,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      errorCount: 0,
    };
    groups.set(repositoryFullName, created);
    return created;
  };

  // ISS-5272 (M3/C5): both folds below tick a cooperative-yield cadence at the
  // TOP of the body. The shared path memo removes the per-row `execFile` await
  // that used to hand the db-host loop back to libuv, and the rows that
  // `continue` on a null repository are precisely the ones it makes
  // microtask-only — a tail-positioned bump would skip them entirely.
  const repoYieldTick = createAttributionYieldCadence();
  for (const row of repoRows) {
    await repoYieldTick();
    const repositoryFullName = await resolveRepositoryFullNameStoredFirst(
      row.cwd,
      row.repo_full_name,
      cache
    );
    // FEA-4299: a row that resolves to no repo either way (no live remote AND no
    // stored repo_full_name) renders "Unknown", not a facet option, so skip it
    // rather than bucket it under a folder name.
    if (repositoryFullName === null) {
      continue;
    }
    const group = ensureGroup(repositoryFullName);
    group.sessionCount += Number(row.session_count ?? 0);
    group.inputTokens += tokenCountValue(
      row.input_tokens,
      "analytics.repo.input"
    );
    group.outputTokens += tokenCountValue(
      row.output_tokens,
      "analytics.repo.output"
    );
    group.errorCount += Number(row.error_count ?? 0);
  }

  const costYieldTick = createAttributionYieldCadence();
  for (const row of repoCostRows) {
    await costYieldTick();
    const repositoryFullName = await resolveRepositoryFullNameStoredFirst(
      row.cwd,
      row.repo_full_name,
      cache
    );
    if (repositoryFullName === null) {
      continue;
    }
    const group = ensureGroup(repositoryFullName);
    group.estimatedCost +=
      (nullableNumber(row.estimated_cost_usd) ?? 0) +
      (resolveTokenUsageCostUsd({
        session_id: "",
        model: row.model ?? "",
        input_tokens: tokenCountValue(
          row.unpriced_input_tokens,
          "analytics.repo.unpriced_input"
        ),
        output_tokens: tokenCountValue(
          row.unpriced_output_tokens,
          "analytics.repo.unpriced_output"
        ),
        cache_read_tokens: tokenCountValue(
          row.unpriced_cache_read_tokens,
          "analytics.repo.unpriced_cache_read"
        ),
        cache_write_tokens: tokenCountValue(
          row.unpriced_cache_write_tokens,
          "analytics.repo.unpriced_cache_write"
        ),
        cache_write_1h_tokens: tokenCountValue(
          row.unpriced_cache_write_1h_tokens,
          "analytics.repo.unpriced_cache_write_1h"
        ),
        cost_usd_estimated: null,
      }) ?? 0);
  }
  return [...groups.values()];
}

export {
  resolveAnalyticsRepositoryGroups,
  resolveRepositoryFullNameStoredFirst,
};
