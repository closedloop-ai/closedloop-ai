import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  recentActivityAt,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * The desktop-local Status FACET matcher — `matchesStatusFilter` in
 * `src/main/session/session-status-filter-match.ts` — exercised through the
 * shared list read.
 *
 * Split out of `shared-agent-sessions-api.test.ts` (ISS-5366), which is on the
 * shrink-only grandfather list, for the same reason the matcher itself was
 * split out of `shared-agent-sessions-api.ts`: the status vocabulary is its own
 * responsibility, and it is the half of the ISS-5366 Active/Stale partition that
 * has to stay in lockstep with the cloud `buildStatusFacetPredicate` and with
 * the SQL `buildUsageStatusPredicate`. Giving it its own file means the coverage
 * can GROW with the vocabulary instead of being rationed by a line budget.
 */
describe("desktop-local status filter matching", () => {
  // ISS-5592: this was "normalizes desktop-local status aliases", and there are
  // no aliases left to normalize — `canonicalSharedStatus` case-folds and
  // nothing else. What it guards now is the other half of that statement: the
  // canonical values match DIRECTLY, and a retired spelling resolves nothing
  // rather than being routed somewhere. Renamed to say so, and each removed
  // alias is asserted below as a request that selects no rows, so re-adding one
  // reddens this rather than passing silently.
  test("matches canonical status values directly, and retired spellings not at all", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("error-session"),
        cursor("running-session"),
        cursor("awaiting-running-session"),
        cursor("awaiting-ended-session"),
        cursor("completed-session"),
        cursor("stale-session"),
      ],
      sessions: {
        "completed-session": session({
          id: "completed-session",
          status: "completed",
          awaitingInputSince: null,
        }),
        "error-session": session({
          id: "error-session",
          status: "error",
          awaitingInputSince: null,
        }),
        "awaiting-running-session": session({
          id: "awaiting-running-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: null,
        }),
        // FEA-3149: a non-terminal, awaiting-input row whose `endedAt` is set
        // must NOT surface as Waiting (matches the cloud facet/projection).
        "awaiting-ended-session": session({
          id: "awaiting-ended-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: "2026-01-01T02:00:00.000Z",
        }),
        // ISS-5366: carries RECENT activity deliberately. Active and Stale now
        // partition the `active`/`running` population against the display
        // staleness cutoff, so a row anchored on the fixtures' fixed 2026-01-01
        // `startedAt` is Stale — correctly — and the Active facet would return
        // nothing. Asserting Active means asserting a genuinely live row.
        "running-session": session({
          id: "running-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
          lastActivityAt: recentActivityAt(),
        }),
        // The other side of that partition: live-looking status, no awaiting
        // input, but silent since the fixtures' fixed 2026-01-01 anchor. Present
        // so the Active assertion below is a real exclusion rather than a corpus
        // that simply had nothing stale in it.
        "stale-session": session({
          id: "stale-session",
          status: "active",
          awaitingInputSince: null,
          endedAt: null,
        }),
      },
    });

    // ISS-5592: `failed` is no longer manufactured from a stored `error`, so a
    // `failed` REQUEST is an unrecognized value and matches nothing. The shared
    // UI sends the canonical `error`, which now matches the row directly.
    const failed = await getSharedAgentSessions(source, { status: "failed" });
    // The other removed alias. `running` used to canonicalize onto `active` on
    // BOTH sides of this comparison, so it selected the whole Active population;
    // it is now an unrecognized request that resolves nothing. Asserted here as
    // well as on the row side (`session-aggregate-status-parity.test.ts`)
    // because the matcher applies the fold symmetrically — dropping it from
    // only the REQUEST side would leave that suite green.
    const running = await getSharedAgentSessions(source, { status: "running" });
    const error = await getSharedAgentSessions(source, { status: "error" });
    const active = await getSharedAgentSessions(source, { status: "active" });
    const stale = await getSharedAgentSessions(source, { status: "stale" });
    const waiting = await getSharedAgentSessions(source, { status: "waiting" });

    assert.deepEqual(
      failed.items.map((item) => item.id),
      []
    );
    assert.deepEqual(
      running.items.map((item) => item.id),
      []
    );
    assert.deepEqual(
      error.items.map((item) => [item.id, item.status]),
      [["error-session", "error"]]
    );
    assert.deepEqual(
      active.items.map((item) => [item.id, item.status]),
      [["running-session", "active"]]
    );
    // ISS-5366: exactly the row Active excluded for staleness — the two facets
    // partition the population, so a row lost by one is found by the other.
    assert.deepEqual(
      stale.items.map((item) => item.id),
      ["stale-session"]
    );
    assert.deepEqual(
      waiting.items.map((item) => [
        item.id,
        item.status,
        item.awaitingInputSince?.toISOString(),
      ]),
      [["awaiting-running-session", "active", "2026-01-01T01:30:00.000Z"]]
    );
  });
});
