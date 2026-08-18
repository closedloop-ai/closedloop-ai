import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type SessionCursorRow,
  SessionListCursorSortKey,
} from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
  MAX_WORKING_SET_SESSIONS,
} from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  session,
  usageAggregate,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-4558: the Repository facet advertises a per-repo session count drawn from
 * the uncapped SQL aggregate over the WHOLE corpus, while selecting that repo
 * falls to the hydrated path whose matched id set is capped at
 * MAX_WORKING_SET_SESSIONS. ISS-4535 already fixed the empty-table half (the
 * predicate now runs pre-hydration, so an older-than-the-window repo resolves),
 * but a repo with MORE than the ceiling's worth of sessions still advertises a
 * count the filtered list cannot reach.
 *
 * The governing invariant (Metal Logic): a facet count and the filter it drives
 * must resolve over the same population, and the screen must never claim one
 * number while showing another.
 */
/**
 * A window of the shape `SessionsView` sends: `getStableUtcDateWindowForRange`
 * quantizes the selected range (90d by default) to whole UTC days and returns
 * BOTH bounds as ISO strings. Only the "All" range omits them.
 */
const SESSIONS_VIEW_WINDOW_START = "2026-04-01T00:00:00.000Z";
const SESSIONS_VIEW_WINDOW_END = "2026-06-30T23:59:59.999Z";
const IN_WINDOW_UPDATED_AT = "2026-05-01T00:00:00.000Z";
const BEFORE_WINDOW_UPDATED_AT = "2026-01-15T00:00:00.000Z";
const SESSIONS_VIEW_PAGE_SIZE = 50;

/**
 * A session whose date bases AGREE: the cursor row's `updated_at` (what the SQL
 * window compares, via `sessionDateWindowTsExpr`) and the hydrated row's
 * `lastActivityAt ?? startedAt` (what `matchesDateBounds` compares) are the same
 * instant. Real rows behave this way, and pinning it here is what lets one
 * fixture be windowed identically on the pre-hydration path and the hydrated
 * fallback — otherwise "the window excluded it" and "the fixture disagreed with
 * itself" are indistinguishable.
 */
function windowedSession(
  id: string,
  repositoryFullName: string,
  at: string
): SyncedAgentSession {
  return session({
    id,
    repositoryFullName,
    updatedAt: at,
    startedAt: at,
    lastActivityAt: at,
  });
}

/**
 * The list request `SessionsView` actually issues for a Repository selection —
 * wongk's #4751 review point. It carries a bounded date window AND
 * `sortBy: lastActivity` from the FIRST render (`defaultSortKey:
 * SortKey.LastActivity` in `useSessionsViewState`, threaded at
 * `SessionsView.tsx`'s `useAgentSessionsPageData` call), so a regression that
 * omits either field is testing a shape no user can produce — which is exactly
 * how the first cut of this fix stayed green while shipping the contradiction.
 */
function sessionsViewListRequest(repositories: readonly string[]) {
  return {
    repositories,
    startDate: SESSIONS_VIEW_WINDOW_START,
    endDate: SESSIONS_VIEW_WINDOW_END,
    sortBy: SessionListCursorSortKey.LastActivity,
    sortDir: "desc",
    limit: SESSIONS_VIEW_PAGE_SIZE,
    offset: 0,
  } as const;
}

describe("Sessions Repository facet ↔ filter population", () => {
  /**
   * Seed sessions that ALL belong to `repositoryFullName`, newest-first in
   * cursor order: `inWindow` of them inside the request's date window and
   * `beforeWindow` of them older than it, plus the matching SQL aggregate the
   * facet folds.
   *
   * The out-of-window rows are what stop the window from being decorative: they
   * belong to the SAME repo, so a read that fails to apply the window counts
   * them and misses the expected total.
   */
  function createOverCapRepoSource(
    repositoryFullName: string,
    inWindow: number,
    beforeWindow: number
  ): ReturnType<typeof createFakeSource> {
    const sessions: Record<string, SyncedAgentSession> = {};
    const cursorRows: SessionCursorRow[] = [];
    const push = (id: string, updatedAt: string) => {
      sessions[id] = windowedSession(id, repositoryFullName, updatedAt);
      cursorRows.push(cursor(id, updatedAt));
    };
    for (let index = 0; index < inWindow; index++) {
      push(`in-${String(index).padStart(6, "0")}`, IN_WINDOW_UPDATED_AT);
    }
    for (let index = 0; index < beforeWindow; index++) {
      push(`out-${String(index).padStart(6, "0")}`, BEFORE_WINDOW_UPDATED_AT);
    }
    return createFakeSource({
      cursorRows,
      sessions,
      // The Repository facet options come from this O(grouped) aggregate, which
      // never hydrates. SessionsView threads the SAME window into its facet
      // query, so the count it advertises is the in-window one.
      aggregateUsage: () =>
        usageAggregate({
          totalSessions: inWindow,
          repoSessionCounts: [{ repositoryFullName, sessionCount: inWindow }],
        }),
    });
  }

  test("the production request shape — bounded window + lastActivity sort — reaches the same population the facet counts (ISS-4558)", async () => {
    const targetRepo = "closedloop-ai/over-cap";
    const inWindow = MAX_WORKING_SET_SESSIONS + 50;
    const beforeWindow = 25;
    const source = createOverCapRepoSource(targetRepo, inWindow, beforeWindow);

    // The facet the user clicks, read with the same window the view sends.
    const facet = await getSharedAgentSessionUsage(source, {
      startDate: SESSIONS_VIEW_WINDOW_START,
      endDate: SESSIONS_VIEW_WINDOW_END,
    });
    const advertised = facet.byRepository.find(
      (entry) => entry.repositoryFullName === targetRepo
    );
    assert.ok(advertised, "the Repository facet must offer the seeded repo");

    // Selecting it: the repository-filtered list read, in the shape the view
    // really sends.
    const filtered = await getSharedAgentSessions(
      source,
      sessionsViewListRequest([targetRepo])
    );

    assert.equal(
      filtered.total,
      advertised.sessionCount,
      `Repository facet advertised ${advertised.sessionCount} sessions for ${targetRepo}, but selecting it returned a total of ${filtered.total} — the facet and the filter are counting different populations`
    );
    // And the window is genuinely applied rather than merely survived: the
    // same repo's out-of-window sessions must not be counted.
    assert.equal(
      filtered.total,
      inWindow,
      `the repo-filtered total must cover exactly the ${inWindow} in-window sessions, not the ${inWindow + beforeWindow} the repo owns overall`
    );
  });

  // `sortDir` cannot change this fixture's row order (its activity basis IS the
  // cursor order), so the only way to pin that the sort reaches the SQL is the
  // downstream call shape — and an unpinned sort is how a pushed-down window
  // would silently start ordering by the wrong column.
  test("the window and sort are pushed into the pre-hydration repository read (ISS-4558)", async () => {
    const targetRepo = "closedloop-ai/over-cap";
    const source = createOverCapRepoSource(targetRepo, 10, 5);

    await getSharedAgentSessions(source, sessionsViewListRequest([targetRepo]));

    const scoped = source.calls.find(
      (call) => call.kind === "listRepositoryScopedSessionIds"
    );
    assert.ok(scoped, "the repo-filtered read must resolve ids pre-hydration");
    assert.equal(
      scoped.repositoryScope?.sortBy,
      SessionListCursorSortKey.LastActivity
    );
    assert.equal(scoped.repositoryScope?.sortDir, "desc");
    assert.equal(
      scoped.repositoryScope?.startDate?.toISOString(),
      SESSIONS_VIEW_WINDOW_START
    );
    assert.equal(
      scoped.repositoryScope?.endDate?.toISOString(),
      SESSIONS_VIEW_WINDOW_END
    );
  });

  // The pre-hydration paging branch runs NO in-memory matcher, so it may only
  // admit a repository filter the source can actually resolve.
  // `resolveRepositoryScopedSessionIds` degrades to the FULL cursor list on a
  // source without `listRepositoryScopedSessionIds`, so admitting one of those
  // would page the whole corpus with the filter silently dropped. Such a source
  // must keep the hydrated fallback, where `sessionMatchesRepositoryFilter`
  // narrows the rows.
  test("a source that cannot resolve repositories pre-hydration still filters (ISS-4558)", async () => {
    const targetRepo = "closedloop-ai/target";
    const otherRepo = "closedloop-ai/other";
    const source = createFakeSource({
      cursorRows: [
        cursor("a", IN_WINDOW_UPDATED_AT),
        cursor("b", IN_WINDOW_UPDATED_AT),
        cursor("c", IN_WINDOW_UPDATED_AT),
      ],
      sessions: {
        a: windowedSession("a", targetRepo, IN_WINDOW_UPDATED_AT),
        b: windowedSession("b", otherRepo, IN_WINDOW_UPDATED_AT),
        c: windowedSession("c", targetRepo, IN_WINDOW_UPDATED_AT),
      },
    });
    // Model a fake/legacy source predating ISS-4535's pre-hydration read.
    Reflect.deleteProperty(source, "listRepositoryScopedSessionIds");

    // Still the production shape: such a source must be REFUSED the paging
    // branch (it cannot apply the window or the filter pre-hydration) and land
    // on the hydrated fallback, which applies both.
    const filtered = await getSharedAgentSessions(
      source,
      sessionsViewListRequest([targetRepo])
    );

    assert.deepEqual(
      filtered.items.map((item) => item.id).sort(),
      ["a", "c"],
      "the repository filter must still narrow on a source without the pre-hydration read"
    );
    assert.equal(filtered.total, 2);
  });

  // thadeusb (cid 3754019307): with the paging branch now reachable, an
  // assertion that only runs there stops covering the FALLBACK's cap. What
  // still forces the fallback is a repo filter combined with a predicate that
  // needs the hydrated row — `harness` here — and THAT path must still stop at
  // the ceiling. Note the request shape thadeusb suggested for this (repo +
  // dates + sortBy) is precisely the one that now PAGES, which is the point of
  // this PR, so the fallback is forced the way it is actually still reached.
  test("a repo filter that falls back still hydrates at most the cap (FEA-4286)", async () => {
    const targetRepo = "closedloop-ai/over-cap";
    const source = createOverCapRepoSource(
      targetRepo,
      MAX_WORKING_SET_SESSIONS + 50,
      0
    );

    await getSharedAgentSessions(source, {
      ...sessionsViewListRequest([targetRepo]),
      // Not SQL-expressible, so `canPageBeforeLoading` refuses the read and the
      // capped full-corpus hydration answers it.
      harness: "claude",
    });

    const loadCalls = source.calls.filter(
      (call) => call.kind === "loadSyncedSessions"
    );
    assert.equal(loadCalls.length, 1, "expected a single hydration call");
    assert.equal(
      loadCalls[0]?.ids?.length,
      MAX_WORKING_SET_SESSIONS,
      "the fallback must hydrate the matched set truncated at the ceiling"
    );
  });

  // The bound the fix must NOT trade away: FEA-4286's hydration ceiling. The
  // total may be honest about the whole corpus, but the number of sessions
  // hydrated into JS must still stay at or under the cap.
  test("an honest over-cap total does not reopen uncapped hydration (FEA-4286)", async () => {
    const targetRepo = "closedloop-ai/over-cap";
    const source = createOverCapRepoSource(
      targetRepo,
      MAX_WORKING_SET_SESSIONS + 50,
      25
    );

    await getSharedAgentSessions(source, sessionsViewListRequest([targetRepo]));

    for (const call of source.calls) {
      if (call.kind !== "loadSyncedSessions") {
        continue;
      }
      assert.ok(
        (call.ids?.length ?? 0) <= MAX_WORKING_SET_SESSIONS,
        `repo-filtered hydration loaded ${call.ids?.length} sessions, above the ${MAX_WORKING_SET_SESSIONS} ceiling`
      );
    }
  });
});
