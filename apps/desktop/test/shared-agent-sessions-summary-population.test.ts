import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { SESSION_HYDRATION_WINDOW } from "../src/main/session/session-hydration-window.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  type SourceCall,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-6895 — a summary and its list must describe the same population.
 *
 * The desktop Sessions reads resolve their matched id set the same way for the
 * list and for the summary, but only the summary used to TRUNCATE it: the list
 * pages before hydrating and reported every match, while usage/analytics
 * hydrated the newest `SESSION_HYDRATION_WINDOW` ids and folded only those. Past
 * that ceiling the same screen showed a header counting N sessions above cards
 * costing 5,000 — a confident number computed over a population the user was
 * never told about.
 *
 * These tests pin the invariant on the reads that CANNOT use the SQL usage
 * aggregate — the ones the ceiling actually governed: a free-text search (the
 * hydrating fallback), a Repository selection on the lightweight usage load, and
 * the deep-offset page the truncation used to blank out entirely. Each fails if
 * the truncation returns, in the specific way it would be felt.
 */
describe("shared agent sessions — summary/list population parity (ISS-6895)", () => {
  const OVER_WINDOW = SESSION_HYDRATION_WINDOW + 137;

  /**
   * A corpus larger than one hydration window whose every row matches the
   * "match" search needle, so a searched read's matched set IS the corpus and any
   * truncation is directly visible in a total.
   */
  function createOverWindowCorpus(size: number): {
    cursorRows: SessionCursorRow[];
    sessions: Record<string, SyncedAgentSession>;
  } {
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    for (let index = 0; index < size; index++) {
      const id = `match-${String(index).padStart(6, "0")}`;
      cursorRows.push(cursor(id));
      sessions[id] = session({ id, cwd: `/tmp/match/${id}` });
    }
    return { cursorRows, sessions };
  }

  test("a searched summary reconciles with its searched list above the hydration window", async () => {
    const source = createFakeSource(createOverWindowCorpus(OVER_WINDOW));

    // Free-text search disables the SQL aggregate and the cursor page, so both
    // reads land on the hydrating path this ticket is about.
    const list = await getSharedAgentSessions(source, { search: "match" });
    const usage = await getSharedAgentSessionUsage(source, { search: "match" });

    assert.equal(list.total, OVER_WINDOW, "the list must report every match");
    assert.equal(
      usage.totalSessions,
      list.total,
      `the summary counted ${usage.totalSessions} sessions while the list counted ${list.total} — the two are describing different populations`
    );
  });

  test("a searched summary's cost totals cover the rows past the window, not just the newest ones", async () => {
    const source = createFakeSource(createOverWindowCorpus(OVER_WINDOW));

    const usage = await getSharedAgentSessionUsage(source, { search: "match" });

    // Every fixture session carries one token-usage row of the same shape, so
    // the fold's totals are exactly per-session-value × population. A truncated
    // fold produces a plausible, confidently-wrong, SMALLER number — which is
    // precisely the failure mode a cap hides.
    assert.equal(usage.totalInputTokens, 10 * OVER_WINDOW);
    assert.equal(usage.totalOutputTokens, 20 * OVER_WINDOW);
    assert.ok(
      Math.abs(usage.totalEstimatedCost - 0.25 * OVER_WINDOW) < 1e-6,
      `total cost ${usage.totalEstimatedCost} does not cover all ${OVER_WINDOW} matched sessions`
    );
  });

  test("analytics folds every matched session past the hydration window", async () => {
    const repositoryFullName = "closedloop-ai/over-window";
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    for (let index = 0; index < OVER_WINDOW; index++) {
      const id = `match-${String(index).padStart(6, "0")}`;
      cursorRows.push(cursor(id));
      sessions[id] = session({ id, repositoryFullName });
    }
    const source = createFakeSource({ cursorRows, sessions });

    const analytics = await getSharedAgentSessionAnalytics(source, {
      search: "match",
    });

    assert.deepEqual(
      analytics.byRepository.map((entry) => [
        entry.repositoryFullName,
        entry.sessionCount,
      ]),
      [[repositoryFullName, OVER_WINDOW]],
      "the analytics repository rollup must count every matched session"
    );
  });

  test("a hydrating list read reports every match, not a truncated prefix", async () => {
    const { cursorRows, sessions } = createOverWindowCorpus(OVER_WINDOW);
    const source = createFakeSource({ cursorRows, sessions });

    // `harness` is not expressible in the cursor page's SQL, so BOTH the list
    // and the summary land on the hydrating path here — the branch where the
    // truncation shortened `total` itself, not just the summary.
    const list = await getSharedAgentSessions(source, { harness: "claude" });
    const usage = await getSharedAgentSessionUsage(source, {
      harness: "claude",
    });

    assert.equal(list.total, OVER_WINDOW, "the list must report every match");
    assert.equal(usage.totalSessions, list.total);
  });

  test("a page past the hydration window returns its rows instead of an empty page", async () => {
    const { cursorRows, sessions } = createOverWindowCorpus(OVER_WINDOW);
    const source = createFakeSource({ cursorRows, sessions });
    const offset = SESSION_HYDRATION_WINDOW + 130;
    const limit = 10;
    const expectedIds = Object.keys(sessions).slice(offset, offset + limit);
    assert.ok(
      expectedIds.length > 0,
      "the fixture must have rows at this offset for the assertion to mean anything"
    );

    // A hydrating read (`harness`) at an offset beyond the old ceiling.
    // Truncating the matched ids left nothing to slice here, so this page came
    // back empty while the header still claimed the rows existed.
    const page = await getSharedAgentSessions(source, {
      harness: "claude",
      offset,
      limit,
    });

    assert.equal(page.total, OVER_WINDOW);
    assert.deepEqual(
      page.items.map((item) => item.id),
      expectedIds,
      "the tail page must serve the rows the total promises"
    );
  });

  test("the hidden-idle count accumulates across windows instead of resetting at each boundary", async () => {
    // FEA-3450's `idleCount` is folded per window and summed by
    // `streamWorkingSessions`. A boundary bug (reset, or double count) is only
    // visible on a corpus that spans more than one window, and only when idle
    // rows sit on BOTH sides of the boundary.
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    let idleSeeded = 0;
    let idleAfterFirstWindow = 0;
    for (let index = 0; index < OVER_WINDOW; index++) {
      const id = `match-${String(index).padStart(6, "0")}`;
      // Idle every 100th row, so idle rows fall in the first window and in the
      // short trailing one.
      const idle = index % 100 === 0;
      if (idle) {
        idleSeeded += 1;
        if (index >= SESSION_HYDRATION_WINDOW) {
          idleAfterFirstWindow += 1;
        }
      }
      cursorRows.push(cursor(id));
      sessions[id] = idle
        ? { ...session({ id }), agents: [], events: [], tokenUsageByModel: [] }
        : session({ id });
    }
    const source = createFakeSource({ cursorRows, sessions });

    const list = await getSharedAgentSessions(source, {
      harness: "claude",
      quality: "substantive",
    });

    assert.ok(
      idleAfterFirstWindow > 0 && idleSeeded > idleAfterFirstWindow,
      "idle rows must straddle the window boundary for this to bite"
    );
    assert.equal(
      list.idleCount,
      idleSeeded,
      "every hidden idle row in scope must be counted, in every window"
    );
    assert.equal(
      list.total,
      OVER_WINDOW - idleSeeded,
      "the substantive total must exclude exactly the hidden idle rows"
    );
  });

  test("analytics harness and agent-type breakdowns fold across window boundaries", async () => {
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    for (let index = 0; index < OVER_WINDOW; index++) {
      const id = `match-${String(index).padStart(6, "0")}`;
      cursorRows.push(cursor(id));
      sessions[id] = session({ id });
    }
    const source = createFakeSource({ cursorRows, sessions });
    const perSessionAgents = sessions["match-000000"]?.agents.length ?? 0;
    assert.ok(perSessionAgents > 0, "the fixture must carry agents to roll up");

    const analytics = await getSharedAgentSessionAnalytics(source, {
      search: "match",
    });

    const agentTypeTotal = analytics.byAgentType.reduce(
      (sum, entry) => sum + entry.count,
      0
    );
    assert.equal(
      agentTypeTotal,
      perSessionAgents * OVER_WINDOW,
      "the agent-type rollup must cover every session's agents, not the first window's"
    );
  });

  test("a deep-offset page never hydrates more than one window at a time", async () => {
    // The page buffer is sized `offset + limit`, which the caller controls. It
    // holds `{ id, sort key }` entries, NOT hydrated rows, so a deep offset over
    // a large matched set cannot pin the population's payload in memory. What
    // the source sees is the proof: every hydration stays within the ceiling.
    const { cursorRows, sessions } = createOverWindowCorpus(
      SESSION_HYDRATION_WINDOW * 2 + 40
    );
    const source = createFakeSource({ cursorRows, sessions });

    await getSharedAgentSessions(source, {
      harness: "claude",
      sortBy: "cost",
      offset: SESSION_HYDRATION_WINDOW * 2,
      limit: 20,
    });

    const loadCalls = source.calls.filter(
      (call) => call.kind === "loadSyncedSessions"
    );
    assert.ok(loadCalls.length > 1, "the corpus must span multiple windows");
    for (const call of loadCalls) {
      assert.ok(
        (call.ids?.length ?? 0) <= SESSION_HYDRATION_WINDOW,
        `a hydration call carried ${call.ids?.length} ids, above the ${SESSION_HYDRATION_WINDOW} residency ceiling`
      );
    }
  });

  test("a summary from a source without the lightweight usage load still covers the whole population", async () => {
    const { cursorRows, sessions } = createOverWindowCorpus(OVER_WINDOW);
    const source = createFakeSource({ cursorRows, sessions });
    // `createFakeSource` exposes no `loadUsageSessions`, so this exercises the
    // OTHER hydrating usage path — the one that shares `streamWorkingSessions`
    // with the list fallback. Both had opted into the cap; neither may now.
    assert.equal(
      "loadUsageSessions" in source,
      false,
      "this fixture must have no lightweight usage load, or it exercises the wrong path"
    );

    const usage = await getSharedAgentSessionUsage(source, { search: "match" });

    assert.equal(usage.totalSessions, OVER_WINDOW);
  });

  test("usage `loadUsageSessions` fast path folds the whole corpus in bounded windows (ISS-6895)", async () => {
    // ISS-6895 REVERSES FEA-4286's truncation while keeping its bound.
    //
    // `loadUsageSessions` materializes every session it is handed into JS and
    // folds it; "lightweight per row" (metadata + tokenUsageByModel, no
    // agents/events) is not "bounded in total", and this runs on the Sessions
    // page's 2 s background page-data poll — so one unbounded full-corpus
    // hydrate here starved the desktop main process and wedged the renderer (the
    // Vite HMR "server connection lost" hang). FEA-4286 bought that bound by
    // TRUNCATING the id set to the ceiling, which made `totalSessions` describe
    // only the newest 5,000 while the list header reported the full matched
    // population — the same screen contradicting itself.
    //
    // The bound now applies per WINDOW, not to the population: no single
    // `loadUsageSessions` call exceeds the ceiling, every matched id is folded
    // exactly once, and `totalSessions` equals the corpus.
    const corpusSize = SESSION_HYDRATION_WINDOW + 137;
    const cursorRows: SessionCursorRow[] = [];
    const sessions: Record<string, SyncedAgentSession> = {};
    for (let i = 0; i < corpusSize; i++) {
      const id = `bulk-${String(i).padStart(5, "0")}`;
      cursorRows.push(cursor(id));
      sessions[id] = session({ id });
    }

    // Capture the ids of EVERY `loadUsageSessions` call, so we can assert both
    // halves: each call is bounded, and together they cover the whole corpus.
    const usageLoadCalls: string[][] = [];
    const source: AgentSessionSyncSource & { calls: SourceCall[] } = {
      ...createFakeSource({ cursorRows, sessions }),
      loadUsageSessions(ids: string[]): SyncedAgentSession[] {
        usageLoadCalls.push([...ids]);
        return ids.flatMap((id) => {
          const loaded = sessions[id];
          return loaded ? [loaded] : [];
        });
      },
    };

    // No facet filters + no `aggregateUsage`: the usage summary takes the
    // pushable `loadUsageSessions` fast path (the SQL aggregate is tried first,
    // but `createFakeSource` omits it here).
    const usage = await getSharedAgentSessionUsage(source, {});

    // Sanity: the corpus genuinely exceeds one window, so a single-shot path
    // would have had to either hydrate all of it or drop the remainder.
    assert.ok(
      corpusSize > SESSION_HYDRATION_WINDOW,
      "corpus must exceed the hydration window to exercise the bound"
    );
    for (const ids of usageLoadCalls) {
      assert.ok(
        ids.length <= SESSION_HYDRATION_WINDOW,
        `a loadUsageSessions call carried ${ids.length} ids, above the ${SESSION_HYDRATION_WINDOW} residency ceiling`
      );
    }
    const foldedIds = usageLoadCalls.flat();
    assert.equal(
      new Set(foldedIds).size,
      corpusSize,
      "every session must be folded exactly once across the windows"
    );
    // The summary now describes the population the list describes, which is the
    // whole point: a bounded read must not shorten an answer.
    assert.equal(
      usage.totalSessions,
      corpusSize,
      "usage summary must aggregate over the full matched population, not the newest window"
    );
    const list = await getSharedAgentSessions(source, {});
    assert.equal(
      usage.totalSessions,
      list.total,
      "the summary total and the list total must reconcile above the hydration window"
    );
  });

  // FEA-3142 (FEA-3132 P0 / A5b): a search or facet filter that can't be pushed
  // into SQL drops onto the hydrating fallback (`streamWorkingSessions` →
  // `loadSyncedSessions` over `resolveOrderedIds`). No single hydration there may
  // exceed SESSION_HYDRATION_WINDOW rows — otherwise a searched read over a huge
  // corpus is the read-side allocator that co-peaks with backfill.
  //
  // ISS-6895: that residency bound used to be bought by TRUNCATING the matched id
  // set, so a searched summary over 5,025 matches reported 5,000 while the list
  // reported 5,025. The fallback now walks the matched set in successive windows:
  // each call stays under the ceiling AND the fold covers every match.
  test("search/facet fallback hydrates the full match set in windows no larger than the ceiling (ISS-6895)", async () => {
    const overCap = SESSION_HYDRATION_WINDOW + 25;
    const sessions: Record<string, SyncedAgentSession> = {};
    const cursorRows: SessionCursorRow[] = [];
    for (let index = 0; index < overCap; index++) {
      // Zero-pad so the id substring "match" needle hits every session and the
      // fallback's matchesQuery keeps them all (worst case for hydration).
      const id = `match-${String(index).padStart(6, "0")}`;
      sessions[id] = session({ id, cwd: `/tmp/match/${id}` });
      cursorRows.push(cursor(id));
    }
    const source = createFakeSource({ cursorRows, sessions });

    // Free-text search flips canUseAggregateSessionFilters false and, absent a
    // cursor-page-eligible sort, lands on the full-corpus hydration fallback.
    const summary = await getSharedAgentSessionUsage(source, {
      search: "match",
    });

    const loadCalls = source.calls.filter(
      (call) => call.kind === "loadSyncedSessions"
    );
    for (const call of loadCalls) {
      assert.ok(
        (call.ids?.length ?? 0) <= SESSION_HYDRATION_WINDOW,
        `a hydration call carried ${call.ids?.length} ids, above the ${SESSION_HYDRATION_WINDOW} residency ceiling`
      );
    }
    const hydratedIds = loadCalls.flatMap((call) => call.ids ?? []);
    assert.equal(
      new Set(hydratedIds).size,
      overCap,
      "the windows together must cover every matched id"
    );
    // The searched summary now describes the same population the searched list
    // header does.
    assert.equal(summary.totalSessions, overCap);
    assert.equal(summary.viewerScope, "self");
    const list = await getSharedAgentSessions(source, { search: "match" });
    assert.equal(
      summary.totalSessions,
      list.total,
      "a searched summary and its list must reconcile above the hydration window"
    );
  });
});
