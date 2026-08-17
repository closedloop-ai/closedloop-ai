import type { SharedAgentSessionRepositoryBreakdown } from "../../shared/shared-agent-sessions-contract.js";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { RepositoryScopedSessionIdsOptions } from "../agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";

/** The per-session token/cost fields the Repository facet rollup consumes. */
type RepositoryTotalsInput = {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};

/**
 * FEA-4299: Repo identity used for the Repository facet, filter predicate, and
 * sort — the resolved Git remote `repositoryFullName`, or `null` when no remote
 * has resolved yet. This is the SAME derivation the Repository column renders
 * via `resolveSessionRepoLabel` (`repositoryFullName ?? null` → "Unknown"), so
 * the filter's selectable options and the rendered values agree: every repo a
 * row can show is filterable, and the filter never offers a value no row shows.
 *
 * It deliberately does NOT fall back to `worktreePath`/`cwd` (e.g. a numbered
 * worktree leaf or a machine/user home folder): coercing a
 * folder into a repo identity would make the facet/filter/sort disagree with the
 * "Unknown" the column and the session-detail Properties panel render, which is
 * exactly the divergence FEA-4274 and FEA-4299 remove. Sessions with a `null`
 * identity are dropped from the facet (nothing to filter to) — mirroring the
 * cloud, which groups the Repository facet on `repositoryFullName` and drops
 * nulls (see `apps/api/app/agent-sessions/service.ts`).
 *
 * Exported for the FEA-4426 decorate-sort-undecorate sort (`sessionSortKey` in
 * `session-working-set-sort.ts`), which routes the `repo` column through this
 * SAME identity so the sort's "Unknown" (null) placement matches the facet.
 */
export function sessionRepositoryName(
  session: SyncedAgentSession
): string | null {
  return session.attribution?.repositoryFullName ?? null;
}

/**
 * FEA-4299: fold one session into the Repository facet options, keyed by the
 * SAME `repositoryFullName` the row renders (`sessionRepositoryName`). Sessions
 * with no resolved remote are skipped so the facet never offers a value no row
 * can display.
 */
export function accumulateUsageRepositoryTotals(
  byRepository: Map<string, SharedAgentSessionRepositoryBreakdown>,
  session: SyncedAgentSession,
  totals: RepositoryTotalsInput
): void {
  const repositoryFullName = sessionRepositoryName(session);
  if (repositoryFullName === null) {
    return;
  }
  const group = byRepository.get(repositoryFullName) ?? {
    repositoryFullName,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    errorCount: 0,
  };
  group.sessionCount += 1;
  group.inputTokens += totals.inputTokens;
  group.outputTokens += totals.outputTokens;
  group.estimatedCost += totals.estimatedCost;
  byRepository.set(repositoryFullName, group);
}

/**
 * FEA-4299: Repository facet options from the per-repo session counts the SQL
 * O(grouped) aggregate resolves (cwd → `repositoryFullName`, nulls dropped).
 * Token/cost columns are not surfaced by the facet, so they are zero here — the
 * facet only needs the option id (`repositoryFullName`) and its session count,
 * which matches exactly the repos the rows render. Kept aligned with
 * `accumulateUsageRepositoryTotals` (the hydrate path) so the two usage paths
 * agree.
 */
export function mapAggregateRepoCountsToBreakdowns(
  repoSessionCounts: { repositoryFullName: string; sessionCount: number }[]
): SharedAgentSessionRepositoryBreakdown[] {
  return repoSessionCounts.map((entry) => ({
    repositoryFullName: entry.repositoryFullName,
    sessionCount: entry.sessionCount,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    errorCount: 0,
  }));
}

/**
 * FEA-4299: does the session satisfy an explicit Repository filter? A session
 * with no resolved remote (`sessionRepositoryName` null) renders an honest
 * "Unknown" and is not a Repository facet option, so it can never satisfy an
 * explicit repository filter — mirroring the cloud `where.repositoryFullName =
 * { in: [...] }` which excludes nulls.
 */
export function sessionMatchesRepositoryFilter(
  session: SyncedAgentSession,
  repositories: readonly string[]
): boolean {
  if (repositories.length === 0) {
    return true;
  }
  const repositoryName = sessionRepositoryName(session);
  return repositoryName !== null && repositories.includes(repositoryName);
}

/**
 * ISS-4535 (@wongk): resolve the newest-first ids of sessions matching the
 * Repository facet selection PRE-hydration, via the source's
 * `listRepositoryScopedSessionIds` (which resolves each row's repo identity from
 * `(cwd, repo_full_name)` with the facet's live-first/stored-fallback
 * precedence — the SAME persisted-aware identity the hydrated
 * `attribution.repositoryFullName` carries, so a deleted-worktree repo resolves
 * on both sides). Pushing the predicate into this pre-hydration read lets the
 * caller cap the MATCHED id set, keeping the FEA-4286 full-corpus hydration bound
 * intact while every offered repo option still resolves to its rows. A source
 * without the method (fake/legacy) falls back to the full cursor list; the
 * in-memory `sessionMatchesRepositoryFilter` on the hydrated rows then still
 * narrows it correctly (only its footprint is un-pre-bounded).
 *
 * ISS-4558: `options` carries the list's date window and sort into that read so
 * the ids come back already windowed and already ordered — what the paging
 * branch needs, since it runs no in-memory matcher over them. Omitted by the
 * capped fallback, which still applies both from the hydrated rows.
 */
export async function resolveRepositoryScopedSessionIds(
  source: AgentSessionSyncSource,
  repositories: readonly string[],
  cache: SessionAttributionResolverCache,
  options?: RepositoryScopedSessionIdsOptions
): Promise<string[]> {
  if (source.listRepositoryScopedSessionIds) {
    return await source.listRepositoryScopedSessionIds(
      repositories,
      cache,
      options
    );
  }
  const rows = await source.listAllSessionCursorRows();
  return rows.map((row) => row.id);
}

/**
 * ISS-4558: may a Repository selection take the pre-hydration cursor-paging
 * branch (uncapped `total`, ONE page hydrated) instead of the capped full-corpus
 * hydration fallback?
 *
 * The Repository facet counts the WHOLE corpus from the O(grouped) SQL
 * aggregate, but the repo-filtered list used to fall to that fallback, whose
 * matched id set is capped at `MAX_WORKING_SET_SESSIONS` — so a repo holding
 * more sessions than the ceiling advertised a count the table could never reach
 * (facet 5050, list 5000) and the screen contradicted itself. ISS-4535 already
 * made the predicate resolvable PRE-hydration via
 * `resolveRepositoryScopedSessionIds`, which returns matches newest-first
 * (`updated_at DESC, id DESC` — the order that branch slices). So when the
 * repository filter is the ONLY active predicate, the ids need no in-memory
 * matcher and page like any unfiltered read: facet and filter then resolve over
 * the same population (the PRD-590 invariant), and hydration drops from 5,000
 * rows to one page — further BELOW the FEA-4286 ceiling, not through it.
 *
 * Gated on the source really having the method: the resolver above degrades to
 * the FULL cursor list without it, and the paging branch runs no matcher, so
 * admitting such a source there would page the whole corpus with the filter
 * silently dropped. Those sources keep the fallback, where the in-memory
 * `sessionMatchesRepositoryFilter` still narrows the hydrated rows.
 */
export function canPageRepositoryFilterBeforeHydration(
  source: AgentSessionSyncSource,
  repositories: readonly string[]
): boolean {
  return (
    repositories.length === 0 ||
    source.listRepositoryScopedSessionIds !== undefined
  );
}
