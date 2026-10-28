/**
 * @file shared-agent-sessions-fallback-batching-budget.test.ts
 * @description ISS-9763 — the per-window batching budget for
 * `streamWorkingSessions`, the desktop full-hydration fallback.
 *
 * ISS-9556 budgeted the cursor FAST PATH with an exact count ("expected 30 to be
 * 6") and deliberately left this fallback unbudgeted, because a constant is the
 * wrong shape here: this read hydrates the whole matched set, so its IPC round
 * trips necessarily scale with the corpus. A constant would be vacuous on a
 * small corpus and false on a large one.
 *
 * THE SHAPE BUDGETED HERE IS A RATIO WITH A FLOOR:
 *
 *   hydrate round trips === ceil(matched rows / SESSION_HYDRATION_WINDOW)
 *   rows per round trip === SESSION_HYDRATION_WINDOW, for every trip but the last
 *
 * THE PROPERTY IT PRESERVES: the fallback pays one store round trip per WINDOW,
 * never one per row, per page, or per chunk smaller than the window. That is
 * what keeps a searched read over a large local history a handful of IPC hops
 * instead of hundreds, while still folding every matched row (ISS-6895) — and,
 * unlike a fixed count, it is a statement that stays true at any corpus size.
 *
 * Both corpora below are asserted against the SAME formula, and they disagree on
 * the answer (3 trips vs 1). That is what makes the budget arithmetically
 * distinguishable from a constant: no single number satisfies both rows.
 *
 * Countable and deterministic only — round trips, ids per trip, corpus size. The
 * repo bans timing assertions (`scripts/lint/rules/no-timing-assertions.ts`) and
 * a wall-clock budget would be noise on a loaded box regardless.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { SESSION_HYDRATION_WINDOW } from "../src/main/session/session-hydration-window.js";
import { getSharedAgentSessionUsage } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * Two windows plus a remainder, so the last trip is provably SHORT while the
 * ones before it are provably FULL. One window exactly would leave the floor
 * untested; a single window would make the whole assertion vacuous.
 */
const MULTI_WINDOW_CORPUS = SESSION_HYDRATION_WINDOW * 2 + 25;

/** Comfortably inside one window — the same formula must yield a single trip. */
const SINGLE_WINDOW_CORPUS = 500;

/** The budget itself, as a function of the corpus rather than a constant. */
function expectedHydrationRoundTrips(rows: number): number {
  return Math.ceil(rows / SESSION_HYDRATION_WINDOW);
}

/**
 * A corpus whose every id contains the search needle, so the fallback's matcher
 * keeps all of them — the worst case for hydration, and the only one where the
 * round-trip count is a clean function of the corpus size.
 */
function buildMatchingCorpus(size: number): {
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

/**
 * One usage read over the hydrating fallback. Free-text search is what takes it
 * there: it flips `canUseAggregateSessionFilters` false, and the fake exposes no
 * `aggregateUsage`/`loadUsageSessions` delegate, so the read lands on
 * `streamWorkingSessions`.
 */
async function readUsageOverFallback(size: number) {
  const source = createFakeSource(buildMatchingCorpus(size));
  const usage = await getSharedAgentSessionUsage(source, { search: "match" });
  const hydrations = source.calls.filter(
    (call) => call.kind === "loadSyncedSessions"
  );
  const idEnumerations = source.calls.filter(
    (call) => call.kind === "listAllSessionCursorRows"
  );
  return { usage, hydrations, idEnumerations };
}

describe("ISS-9763 — fallback per-window batching budget", () => {
  test("pays one hydration round trip per window, not per row", async () => {
    const { usage, hydrations, idEnumerations } =
      await readUsageOverFallback(MULTI_WINDOW_CORPUS);

    // The ratio: trips are the corpus over the window, rounded up.
    assert.equal(
      hydrations.length,
      expectedHydrationRoundTrips(MULTI_WINDOW_CORPUS)
    );

    // The floor, which is the half a bare count cannot express: every trip but
    // the last carries a FULL window. A read that chunked into 200s would still
    // cover the corpus and still be "bounded" — and would cost 51 round trips.
    const carried = hydrations.map((call) => call.ids?.length ?? 0);
    const [...allTrips] = carried;
    const lastTrip = allTrips.pop();
    for (const trip of allTrips) {
      assert.equal(trip, SESSION_HYDRATION_WINDOW);
    }
    assert.equal(lastTrip, MULTI_WINDOW_CORPUS % SESSION_HYDRATION_WINDOW);

    // The id enumeration ahead of the windows is ONE trip, corpus-independent.
    assert.equal(idEnumerations.length, 1);

    // And the read still describes its whole population, so the budget above is
    // a real fold over every matched row rather than an early return.
    assert.equal(usage.totalSessions, MULTI_WINDOW_CORPUS);
    assert.equal(
      carried.reduce((total, trip) => total + trip, 0),
      MULTI_WINDOW_CORPUS
    );
  });

  test("the same formula yields a single trip inside one window", async () => {
    const { usage, hydrations } =
      await readUsageOverFallback(SINGLE_WINDOW_CORPUS);

    assert.equal(
      hydrations.length,
      expectedHydrationRoundTrips(SINGLE_WINDOW_CORPUS)
    );
    assert.equal(hydrations[0]?.ids?.length, SINGLE_WINDOW_CORPUS);
    assert.equal(usage.totalSessions, SINGLE_WINDOW_CORPUS);

    // Named explicitly: the two corpora disagree on the trip count, so no
    // constant budget satisfies both rows and this suite cannot degrade into one.
    assert.notEqual(
      expectedHydrationRoundTrips(SINGLE_WINDOW_CORPUS),
      expectedHydrationRoundTrips(MULTI_WINDOW_CORPUS)
    );
  });
});
