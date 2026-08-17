import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import {
  type RepositoryScopedSessionIdsOptions,
  SessionListCursorSortKey,
} from "../agent-sync/agent-session-read-model.js";
import { createAttributionYieldCadence } from "../agent-sync/attribution-path-memo.js";
import {
  SESSION_LAST_ACTIVITY_AT_TS_EXPR,
  SESSION_STARTED_AT_TS_EXPR,
} from "../agent-sync/session-date-window.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { resolveRepositoryFullNameStoredFirst } from "./repository-facet.js";
import { buildListCursorFilterClause } from "./session-aggregate-filters.js";

/**
 * The SQLite Repository-scoped session-id read: the pre-hydration half of the
 * Sessions Repository facet.
 *
 * Split out of `sync-source.ts` (a shrink-only grandfathered file) by ISS-4558,
 * which taught this read the list's date window and sort. It is one cohesive
 * responsibility — resolve which session ids belong to a repository selection,
 * in the order and window the list asked for, without hydrating anything — and
 * it is deliberately NOT part of the generic cursor-page read, because the repo
 * identity is resolved in JS (a filesystem-aware precedence the SQL has no
 * expression for) rather than by a WHERE clause.
 */

/**
 * ISS-4535 (@wongk): the ids of sessions whose repository identity is one of
 * `repositories`, PRE-hydration — so the Repository facet's predicate applies
 * against every session's metadata (not just the MAX_WORKING_SET_SESSIONS
 * newest window) WITHOUT hydrating the full corpus. Reading only
 * `(id, cwd, repo_full_name)` and resolving the identity via the SAME shared
 * `resolveRepositoryFullNameStoredFirst` (ISS-5271 ruled precedence: durable
 * stored `repo_full_name` wins, live resolution only for an existing-on-disk
 * cwd with no stored name) that the Repository facet options use means every
 * offered option resolves to its real rows — the facet's option identity and
 * this filter's row identity come from one helper by construction — and the
 * caller can then cap the MATCHED id set, keeping the FEA-4286 hydration bound
 * intact.
 *
 * ISS-4558: `options` pushes the list's date window and sort into THIS read, so
 * a repo-filtered page answers the real Sessions request shape (a bounded
 * window plus `sortBy: lastActivity`) pre-hydration instead of falling to the
 * capped fallback. It reuses `buildListCursorFilterClause` and the same sort
 * columns as `listSqliteSessionCursorPage` rather than restating the predicate,
 * so a repo-filtered page and an unfiltered one cannot drift onto different
 * window bases or orderings.
 *
 * ISS-5625: the identity resolution runs over a `GROUP BY` read — once per
 * DISTINCT `(cwd, repo_full_name)` pair, exactly as the sibling
 * `resolveAnalyticsRepositoryGroups` already does — and the ids are then
 * selected in SQL from the pairs that matched, under the same window clause and
 * the same `ORDER BY`. Repository identity is a pure function of that pair, so
 * resolving it once per row was `O(corpus)` awaits and an `O(corpus)` row
 * materialization on the heap-capped db-host worker to answer a question with
 * `O(distinct worktrees)` distinct answers. `options.limit` bounds the id read
 * itself rather than leaving the caller to discard the tail.
 */
export async function listSqliteRepositoryScopedSessionIds(
  prisma: DesktopPrisma,
  repositories: readonly string[],
  cache: SessionAttributionResolverCache,
  options?: RepositoryScopedSessionIdsOptions
): Promise<string[]> {
  // Nothing asked for is answered without touching the store: a caller spending
  // a remaining budget (`Math.max(0, cap - taken)`) would otherwise pay the
  // grouped read AND a live resolution per distinct worktree to produce `[]`.
  if (repositories.length === 0 || options?.limit === 0) {
    return [];
  }
  const { clause, params } = buildListCursorFilterClause({
    ...(options?.startDate ? { startDate: options.startDate } : {}),
    ...(options?.endDate ? { endDate: options.endDate } : {}),
  });
  const matchedKeys = await resolveMatchedRepositoryPairKeys(
    prisma,
    repositories,
    cache,
    { clause, params }
  );
  if (matchedKeys.length === 0) {
    return [];
  }
  // The matched pairs travel as ONE bound JSON array exploded by `json_each` —
  // the convention `readSessionBranchCounts` already uses for a key set — rather
  // than one placeholder per pair, so the predicate cannot run into SQLite's
  // bound-parameter ceiling however many worktrees a repository has.
  const idParams: unknown[] = [...params, JSON.stringify(matchedKeys)];
  const matchedCondition = `${REPOSITORY_PAIR_KEY_EXPR} IN (SELECT value FROM json_each($${idParams.length}))`;
  const where = clause
    ? `${clause} AND ${matchedCondition}`
    : `WHERE ${matchedCondition}`;
  // The cap the caller would otherwise apply in JS, pushed into SQL under the
  // SAME ordering — equivalent because `sessions.id` is the primary key, so the
  // caller's dedupe drops nothing and its truncation point is this LIMIT.
  // A `limit` of 0 is honored as "no ids", NOT as "unbounded" — a caller
  // computing a remaining budget (`Math.max(0, cap - taken)`) would otherwise
  // get the whole corpus back at the exact moment it asked for none. A negative
  // limit is not a bound at all (SQLite reads `LIMIT -1` as unbounded), so it is
  // dropped and the caller's own cap stays the only one.
  const limit = options?.limit;
  let limitClause = "";
  if (limit !== undefined && Number.isInteger(limit) && limit >= 0) {
    idParams.push(limit);
    limitClause = `LIMIT $${idParams.length}`;
  }
  const direction = options?.sortDir === "asc" ? "ASC" : "DESC";
  const sortExpression = repositoryScopedSortExpression(options?.sortBy);
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ id: string }[]>(
      `
        SELECT s.id AS id
        FROM sessions s
        ${where}
        ORDER BY ${sortExpression} ${direction}, s.id ${direction}
        ${limitClause}
      `,
      ...idParams
    )
  );
  return rows.map((row) => row.id);
}

/**
 * ISS-4558: sort column for the repository-scoped id resolution, mirroring
 * `listSqliteSessionCursorPage` so a repo-filtered page and an unfiltered one
 * order by the same thing.
 *
 * An OMITTED `sortBy` keeps the legacy `updated_at DESC, id DESC` order, and
 * that default is load-bearing rather than arbitrary: the capped fallback
 * (`resolveOrderedIds` with `cap: true`) bounds this list at
 * MAX_WORKING_SET_SESSIONS and documents the survivors as "the MOST RECENT N",
 * which is only true while the order is the cursor's own `updated_at`.
 *
 * Goal stage 1b added {@link SessionListCursorSortKey.Updated}, which names that
 * same `updated_at` order explicitly — so it lands on the fall-through return
 * and orders identically to an omitted `sortBy`, which is the correct mapping
 * rather than an unhandled case. (`repositoryScopeOptionsFromQuery` resolves
 * through `cursorSortKeyFromQuery`, which never emits it, so today it only
 * arrives here if a future caller passes it deliberately.)
 */
function repositoryScopedSortExpression(
  sortBy: SessionListCursorSortKey | undefined
): string {
  if (sortBy === SessionListCursorSortKey.Started) {
    return SESSION_STARTED_AT_TS_EXPR;
  }
  if (sortBy === SessionListCursorSortKey.LastActivity) {
    return SESSION_LAST_ACTIVITY_AT_TS_EXPR;
  }
  return "s.updated_at";
}

/**
 * ISS-5625: the SQLite expression that keys a session row by the
 * `(cwd, repo_full_name)` pair its repository identity is a pure function of.
 * BOTH reads render this one expression — the grouped read selects it, the id
 * read matches against the keys that resolved into the selection — so the two
 * cannot key rows differently.
 *
 * A NULL/blank stored name is collapsed to `''` — `TRIM` over `COALESCE`, the
 * same normalization `resolveRepositoryFullNameStoredFirst` applies before its
 * `if (stored)` test and the same one `applyRepoFullNameFillBacks` admits rows
 * by — and a NULL cwd likewise, since a falsy cwd short-circuits that resolver.
 * So the collapse can only merge rows the resolver would have answered
 * identically. `CHAR(31)` — the ASCII unit separator — delimits the halves: it
 * occurs in neither a filesystem path nor a repository full name, so no pair
 * can forge another pair's key.
 */
const REPOSITORY_PAIR_KEY_EXPR =
  "COALESCE(s.cwd, '') || CHAR(31) || TRIM(COALESCE(s.repo_full_name, ''))";

/**
 * ISS-5625: the {@link REPOSITORY_PAIR_KEY_EXPR} keys whose repository identity
 * is one of `repositories`, resolved ONCE per distinct `(cwd, repo_full_name)`
 * pair over a grouped read of the same windowed population.
 *
 * Identity still comes from the shared `resolveRepositoryFullNameStoredFirst`,
 * so the facet's option identity and this filter's row identity remain one
 * helper by construction — only the number of times it is asked changes, from
 * once per session row to once per distinct worktree/stored-name pair.
 */
async function resolveMatchedRepositoryPairKeys(
  prisma: DesktopPrisma,
  repositories: readonly string[],
  cache: SessionAttributionResolverCache,
  window: { clause: string; params: unknown[] }
): Promise<string[]> {
  const selected = new Set(repositories);
  const pairs = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      { pair_key: string; cwd: string | null; repo_full_name: string | null }[]
    >(
      `
        SELECT
          ${REPOSITORY_PAIR_KEY_EXPR} AS pair_key,
          s.cwd AS cwd,
          s.repo_full_name AS repo_full_name
        FROM sessions s
        ${window.clause}
        GROUP BY pair_key
      `,
      ...window.params
    )
  );
  const matchedKeys: string[] = [];
  // ISS-5272 (M3/C5): the shared path memo turns most of these resolutions into
  // microtask-only work, removing the per-row `execFile` await that used to hand
  // the db-host loop back to libuv. Tick the cadence at the TOP of the body so
  // the pairs that resolve to nothing still yield.
  const yieldTick = createAttributionYieldCadence();
  for (const pair of pairs) {
    await yieldTick();
    const repositoryFullName = await resolveRepositoryFullNameStoredFirst(
      pair.cwd,
      pair.repo_full_name,
      cache
    );
    if (repositoryFullName === null || !selected.has(repositoryFullName)) {
      continue;
    }
    matchedKeys.push(pair.pair_key);
    if (!pair.repo_full_name?.trim()) {
      // ISS-5625: this pair was decided by LIVE resolution, and the usage
      // aggregate's `applyRepoFullNameFillBacks` durably writes exactly that
      // resolved name onto exactly these rows — concurrently, since the page
      // read runs the list and the usage aggregate under one `Promise.allSettled`
      // (`getSharedAgentSessionsPageData`). A fill-back landing between the two
      // reads below re-keys the row from `<cwd>CHAR(31)` to
      // `<cwd>CHAR(31)<name>`, so pre-register that key too and the row survives
      // the write instead of dropping out of this render's page and total.
      // Appending to the key the FIRST read returned — rather than rebuilding it
      // — keeps the encoding rendered in exactly one place, and is exact because
      // a blank stored name contributes nothing after the separator.
      matchedKeys.push(pair.pair_key + repositoryFullName.trim());
    }
  }
  return matchedKeys;
}
