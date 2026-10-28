import assert from "node:assert/strict";
import { DISPLAYED_STATUS_PARITY_CASES } from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  parityCaseActivityAt,
  parityCaseEndedAt,
  recentActivityAt,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-4556 / ISS-4559: the desktop Local lane's Status-facet and displayed-status
 * contract.
 *
 * Split out of the grandfathered `shared-agent-sessions-api.test.ts` (shrink-only)
 * alongside the production split into `shared-agent-session-status.ts`, so the
 * status vocabulary is covered where it now lives.
 */
describe("shared agent sessions status facet", () => {
  test("normalizes desktop-local status aliases for shared status filters", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("error-session"),
        cursor("running-session"),
        cursor("awaiting-running-session"),
        cursor("awaiting-ended-session"),
        cursor("completed-session"),
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
          lastActivityAt: recentActivityAt(),
        }),
        // FEA-3149: a non-terminal, awaiting-input row whose `endedAt` is set
        // must NOT surface as Waiting (matches the cloud facet/projection).
        //
        // ISS-8485: with a FRESH anchor, so "not Waiting" is asserted as the
        // positive claim "Active" below. Without one the row inherited the
        // fixture's fixed 2026-01-01 date and displayed Stale, and its absence
        // from both facets read the same whether the ended guard worked, was
        // deleted, or the staleness fold swallowed it — three different
        // outcomes, one passing assertion.
        "awaiting-ended-session": session({
          id: "awaiting-ended-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: "2026-01-01T02:00:00.000Z",
          lastActivityAt: recentActivityAt(),
        }),
        "running-session": session({
          id: "running-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
          // ISS-5366: without a fresh anchor the fixture's fixed 2026-01-01
          // start date is far past the display cutoff, so the Active facet
          // correctly drops this row as Stale and the assertion below would be
          // measuring staleness rather than the awaiting-input partition.
          lastActivityAt: recentActivityAt(),
        }),
      },
    });

    // ISS-5592: `failed` is no longer manufactured from a stored `error`, so a
    // `failed` REQUEST is an unrecognized value and matches nothing. The shared
    // UI sends the canonical `error`, which now matches the row directly.
    const failed = await getSharedAgentSessions(source, { status: "failed" });
    const error = await getSharedAgentSessions(source, { status: "error" });
    const active = await getSharedAgentSessions(source, { status: "active" });
    const waiting = await getSharedAgentSessions(source, { status: "waiting" });

    assert.deepEqual(
      failed.items.map((item) => item.id),
      []
    );
    assert.deepEqual(
      error.items.map((item) => [item.id, item.status]),
      [["error-session", "error"]]
    );
    // ISS-10741: `awaiting-running-session` used to leave the Active facet for
    // Waiting; it now stays, and the filter still claims it (ISS-9939).
    //
    // ISS-10364 (operator ruling 2026-09-23): EXPECTATION CHANGED further —
    // the Waiting BADGE this used to pin alongside the facet is retired, so
    // the row's `status` now reads plain `active` too, same as its neighbors.
    assert.deepEqual(
      active.items.map((item) => [item.id, item.status]),
      [
        ["running-session", "active"],
        ["awaiting-running-session", "active"],
        ["awaiting-ended-session", "active"],
      ]
    );
    // ISS-9939 / ISS-10629 (operator ruling, 2026-09-18): EXPECTATION CHANGED,
    // and it is the ISS-4559 contract being deliberately withdrawn rather than a
    // weakened assertion. `waiting` is no longer a FILTER value on either
    // surface — the WAITING arm is gone and the request falls to the
    // stored-status equality, which no row here satisfies. Kept as the
    // counterfactual for the new behaviour rather than deleted, because a
    // re-added arm would silently restore the old answer.
    //
    // The row is still SERVED as `waiting` (asserted in the parity case below)
    // and is gathered by ACTIVE, asserted above — ISS-10741 closed the no-facet
    // gap this note used to record, so an empty `waiting` request is the
    // retirement and not a hole.
    assert.deepEqual(
      waiting.items.map((item) => item.id),
      []
    );
  });

  test("displayed-status parity: row status, sort group, and facet agree (ISS-4556 / ISS-4559)", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("awaiting-running-session"),
        cursor("awaiting-ended-session"),
        cursor("running-session"),
      ],
      sessions: {
        "awaiting-running-session": session({
          id: "awaiting-running-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: null,
          lastActivityAt: recentActivityAt(),
        }),
        // ISS-4559: ended + awaiting + raw-active. Displays Active, so the
        // ACTIVE facet must return it; before the fix NEITHER facet did.
        "awaiting-ended-session": session({
          id: "awaiting-ended-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: "2026-01-01T02:00:00.000Z",
          // ISS-4556: a fresh anchor, for the reason the sibling fixtures
          // already carry one. This case is about the ended + awaiting
          // dimension; without an anchor it inherits the fixture's fixed
          // 2026-01-01 date, and the projection now honestly folds a
          // long-silent `active` row to Stale — which would make this assert
          // staleness instead of the thing it exists to pin. The ended +
          // awaiting + STALE combination is covered by the shared oracle.
          lastActivityAt: recentActivityAt(),
        }),
        "running-session": session({
          id: "running-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
          // ISS-5366: a genuinely-Active fixture has to say when it was last
          // active, or the display cutoff drops it as Stale.
          lastActivityAt: recentActivityAt(),
        }),
      },
    });

    const all = await getSharedAgentSessions(source, {});
    const active = await getSharedAgentSessions(source, { status: "active" });
    const waiting = await getSharedAgentSessions(source, {
      status: "waiting",
    });

    // ISS-4556: the row's `status` cell is the DISPLAYED status.
    //
    // ISS-10364 (operator ruling 2026-09-23): EXPECTATION CHANGED — the
    // Waiting badge the awaiting, not-yet-ended row used to read is retired,
    // so it now reads plain Active, same as the ended row beside it.
    assert.deepEqual(
      all.items.map((item) => [item.id, item.status]).sort(),
      [
        ["awaiting-ended-session", "active"],
        ["awaiting-running-session", "active"],
        ["running-session", "active"],
      ].sort()
    );

    // ...and each row is returned by the facet its STORED status names —
    // ISS-10741, which is why the displayed-Waiting row joins this list.
    assert.deepEqual(active.items.map((item) => item.id).sort(), [
      "awaiting-ended-session",
      "awaiting-running-session",
      "running-session",
    ]);
    // ISS-10629: the displayed-Waiting row is no longer gathered by a Waiting
    // facet, because there is none. The `all` assertion above still pins that
    // its CELL reads Waiting, so the badge half of ISS-4556 is untouched; what
    // this row now pins is that the badge and the filter have been allowed to
    // part company, by ruling.
    assert.deepEqual(
      waiting.items.map((item) => item.id),
      []
    );

    // ISS-9939 / ISS-10262: the Status SORT no longer groups by the DISPLAYED
    // projection — it sorts on the PERSISTED lifecycle status, and all three
    // fixtures store the same raw `active`, so the sort ties on all of them
    // and the stable order is the INCOMING (cursorRows) order:
    // awaiting-running-session, awaiting-ended-session, running-session.
    //
    // ISS-10364 (operator ruling 2026-09-23): EXPECTATION CHANGED on the
    // rendered `status` field itself — the displayed projection this used to
    // pin (`waiting` leading the other two) is retired, so every row now
    // renders plain Active regardless of sort position.
    const sorted = await getSharedAgentSessions(source, {
      sortBy: "status",
      sortDir: "asc",
    });
    assert.deepEqual(
      sorted.items.map((item) => item.status),
      ["active", "active", "active"]
    );
  });

  test("displayed-status parity matches the shared cross-surface oracle (ISS-4556 / ISS-4559)", async () => {
    // The SAME table `apps/api`'s `displayed-status-parity.test.ts` asserts the
    // cloud projection and facet predicate against. Two implementations checked
    // against ONE fixture: if either surface drifts, its suite reddens. Asserting
    // each against its own local constant is what let FEA-4301's derivations
    // separate in the first place.
    for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
      const parityActivityAt = parityCaseActivityAt(parityCase);
      const source = createFakeSource({
        cursorRows: [cursor("parity-session")],
        sessions: {
          "parity-session": session({
            id: "parity-session",
            status: parityCase.rawStatus,
            awaitingInputSince: parityCase.awaitingInput
              ? "2026-01-01T01:30:00.000Z"
              : null,
            endedAt: parityCaseEndedAt(parityCase),
            endsWithError: null,
            // ISS-4556: staleness is one of the oracle's dimensions, because
            // ACTIVE carries `NOT staleAnchor` and STALE carries an
            // awaiting-input clause — so the two only partition when both
            // subtract the same population, and pinning every row fresh made
            // this suite unable to see the case where they do not.
            lastActivityAt: parityActivityAt,
          }),
        },
      });

      const all = await getSharedAgentSessions(source, {});
      assert.deepEqual(
        all.items.map((item) => item.status),
        [parityCase.displayedStatus],
        `displayed status: ${parityCase.name}`
      );

      // ISS-10629 removed the WAITING/STALE/UNKNOWN rows of this sweep with the
      // arms they asserted; ISS-10741 removed the oracle columns behind them.
      for (const [facet, expected] of [
        [SESSION_STATUS.ACTIVE, parityCase.matchedByActiveFacet],
        // The two TERMINAL facets, asked directly rather than only through
        // the raw-status question below: ISS-11239 rules that neither returns
        // a row storing `active`, whatever end it carries.
        [SESSION_STATUS.INACTIVE, parityCase.matchedByInactiveFacet],
        [SESSION_STATUS.ERROR, parityCase.matchedByErrorFacet],
        // ISS-4556: the facet named by the row's own stored status, which is
        // the only one that reaches the INACTIVE branch and the raw-status
        // fallback.
        [parityCase.rawStatus, parityCase.matchedByRawStatusFacet],
      ] as const) {
        const filtered = await getSharedAgentSessions(source, {
          status: facet,
        });
        assert.equal(
          filtered.items.length === 1,
          expected,
          `${facet} facet: ${parityCase.name}`
        );
      }
    }
  });
});
