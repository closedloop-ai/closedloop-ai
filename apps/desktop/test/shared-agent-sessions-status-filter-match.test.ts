import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
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
 * responsibility, and it has to stay in lockstep with the SQL
 * `buildUsageStatusPredicate`. It named the cloud `buildStatusFacetPredicate` as
 * a third party to that lockstep until ISS-10629 deleted it; ISS-10741 then put
 * both desktop halves back on cloud's plain stored-status equality for ACTIVE.
 * Giving it its own file means the coverage can GROW with the vocabulary
 * instead of being rationed by a line budget.
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
        // Carries RECENT activity deliberately: the Active assertion below
        // pairs each row with its SERVED status, and on the fixtures' fixed
        // 2026-01-01 anchor this row would badge Stale like its neighbour,
        // leaving no row in the case that badges plain Active.
        "running-session": session({
          id: "running-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
          lastActivityAt: recentActivityAt(),
        }),
        // Live-looking status, no awaiting input, but silent since the
        // fixtures' fixed 2026-01-01 anchor, so it BADGES Stale. Present so the
        // Active assertion below covers a row whose badge is not Active
        // (ISS-10741), which is the inclusion that case exists for.
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
    const inactive = await getSharedAgentSessions(source, {
      status: SESSION_STATUS.INACTIVE,
    });
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
    // ISS-10741: ACTIVE no longer subtracts display state, so all three rows
    // gather here. That MEMBERSHIP is the load-bearing half and still reddens
    // if either subtraction is restored.
    //
    // ISS-10364: EXPECTATION CHANGED on the second column only. The rows are
    // unchanged — one is awaiting input, one has been silent past the old
    // cutoff — but the producers no longer serve a display word for either, so
    // the pairing that used to read "a row BADGING waiting/stale comes back
    // under active" now reads "there is no badge left to disagree with the
    // facet". Restoring either PROJECTION reddens this column.
    //
    // `awaiting-ended-session` stores `active` beside a recorded end, which is
    // not an input to either the facet or the badge.
    assert.deepEqual(
      active.items.map((item) => [item.id, item.status]),
      [
        ["running-session", "active"],
        ["awaiting-running-session", "active"],
        ["awaiting-ended-session", SESSION_STATUS.ACTIVE],
        ["stale-session", "active"],
      ]
    );
    // ISS-9939 / ISS-10629 (operator ruling, 2026-09-18): EXPECTATION CHANGED.
    // `stale` was a FILTER value that gathered exactly the rows Active excluded
    // for staleness, so the two partitioned the `active` population. The ruling
    // retired it: the STALE arm is gone and the request falls to the
    // stored-status equality, which `stale-session` (it stores `active`) does
    // not satisfy. Kept as a counterfactual so a re-added arm reddens here.
    //
    // ISS-10741 closed the no-facet gap this used to name; `stale` as a REQUEST
    // still resolves nothing, which is what this counterfactual pins.
    assert.deepEqual(
      stale.items.map((item) => item.id),
      []
    );
    // `awaiting-ended-session` is NOT here: it stores `active`, and its
    // recorded end buys it no terminal status. `completed-session` is NOT here
    // either: `completed` is a retired spelling that no facet gathers.
    assert.deepEqual(
      inactive.items.map((item) => item.id),
      []
    );
    // ISS-10629: the WAITING twin of the Stale expectation above — retired as a
    // filter value, kept as a counterfactual. The row's SERVED status is still
    // the projected `waiting` (pinned by the `all` read in
    // `shared-agent-sessions-status-facet.test.ts`); it is the FILTER that no
    // longer has a value for it.
    assert.deepEqual(
      waiting.items.map((item) => item.id),
      []
    );
  });

  // ISS-6795: the staleness anchor, on the one input where a bare
  // `lastActivityAt ?? startedAt` and the served instant disagree.
  test("buckets a MALFORMED lastActivityAt the way the row is served", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("malformed-activity-session")],
      sessions: {
        // `SyncedAgentSession.lastActivityAt` is a free-form wire string, so an
        // unparseable value is a NON-NULL one: it satisfies a `??` and then
        // fails to parse. `startedAt` is RECENT deliberately — it is the value a
        // parse-first resolution would fall back to, so a fixture started at the
        // fixtures' fixed 2026-01-01 anchor would read Stale either way and
        // could not tell the two anchors apart.
        "malformed-activity-session": session({
          id: "malformed-activity-session",
          status: SESSION_STATUS.ACTIVE,
          startedAt: recentActivityAt(),
          lastActivityAt: "not-a-date",
          awaitingInputSince: null,
          endedAt: null,
        }),
      },
    });

    const active = await getSharedAgentSessions(source, { status: "active" });
    const stale = await getSharedAgentSessions(source, { status: "stale" });
    const all = await getSharedAgentSessions(source, {});

    // What the row is SERVED with, and therefore what the shared grid folds:
    // `mapListItem` reads the same `servedSessionActivityAt`, whose
    // `parseSessionDate` floors an unparseable string at epoch 0 — which is far
    // past the display cutoff, so the badge reads "Stale". Asserted here so the
    // two facet expectations below are pinned to the rendered value rather than
    // to each other.
    assert.deepEqual(
      all.items.map((item) => item.lastActivityAt?.toISOString()),
      [new Date(0).toISOString()]
    );
    // ISS-10741: EXPECTATION CHANGED. This assertion no longer discriminates the
    // anchor — the row is in Active under either resolution — so the `all`
    // epoch-floor assertion above is the sole carrier of ISS-6795's claim.
    assert.deepEqual(
      active.items.map((item) => item.id),
      ["malformed-activity-session"]
    );
    assert.deepEqual(
      stale.items.map((item) => item.id),
      []
    );
  });
});
