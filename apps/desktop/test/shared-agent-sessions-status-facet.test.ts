import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DISPLAYED_STATUS_PARITY_CASES } from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import {
  isDisplayedStatusParityEnabled,
  setDisplayedStatusParityResolver,
  withDisplayedStatusParityScope,
} from "../src/main/session/displayed-status-parity-gate.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  recentActivityAt,
  session,
  staleActivityAt,
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
  test("the parity gate fails CLOSED when its resolver throws", () => {
    // The resolver reads the settings store, which can throw. A list read must
    // degrade to today's behavior rather than collapse, so the catch matters and
    // is asserted through the production entry point the leaves call.
    setDisplayedStatusParityResolver(() => {
      throw new Error("settings store unavailable");
    });
    try {
      assert.equal(isDisplayedStatusParityEnabled(), false);
    } finally {
      setDisplayedStatusParityResolver(() => false);
    }
  });

  test("a scoped read holds ONE gate decision across its awaits", async () => {
    // ISS-4556: the gate's leaves (`mapListItem`, `matchesStatusFilter`, the
    // Status sort key, the SQL count predicate) each read it once per ROW and per
    // comparison, across `await`s. Read live every time, a resolver that changes
    // mid-read — a transient settings-store throw, swallowed to `false` by
    // design, or a Labs toggle flipped while the page loads — split one page
    // across two derivations: rows folded before it carried `waiting`/`stale`,
    // rows after carried raw `active`, and the sort then ranked some 0 and others
    // 1/4 under a single header click.
    //
    // The resolver here FLIPS on its second call, so this fails if any read
    // inside the scope resolves live instead of using the pinned decision.
    let calls = 0;
    setDisplayedStatusParityResolver(() => {
      calls += 1;
      return calls === 1;
    });
    try {
      const [first, second] = await withDisplayedStatusParityScope(async () => {
        const before = isDisplayedStatusParityEnabled();
        await Promise.resolve();
        return [before, isDisplayedStatusParityEnabled()];
      });
      assert.equal(first, true);
      assert.equal(second, true, "the gate must not be re-resolved mid-read");
      assert.equal(calls, 1, "the resolver is consulted once per scoped read");
      // Outside the scope the live resolver applies again, so the scope is a
      // per-read pin and not a process-wide latch.
      assert.equal(isDisplayedStatusParityEnabled(), false);
    } finally {
      setDisplayedStatusParityResolver(() => false);
    }
  });

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
        "awaiting-ended-session": session({
          id: "awaiting-ended-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: "2026-01-01T01:30:00.000Z",
          endedAt: "2026-01-01T02:00:00.000Z",
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
    // ISS-4556 / ISS-4559: the `sessions-displayed-status-parity` gate is OFF by
    // default, so these two assertions pin the PRE-FIX behavior — the defect, not
    // the contract. `awaiting-running-session` is returned by the Waiting facet
    // while its `status` still reads `active` (the ISS-4556 cell/filter
    // disagreement), and `awaiting-ended-session` is returned by neither facet
    // (ISS-4559). The corrected behavior is asserted with the gate ON in the two
    // displayed-status parity tests below.
    assert.deepEqual(
      active.items.map((item) => [item.id, item.status]),
      [["running-session", "active"]]
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

  test("displayed-status parity: row status, sort group, and facet agree (ISS-4556 / ISS-4559)", async () => {
    setDisplayedStatusParityResolver(() => true);
    try {
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

      // ISS-4556: the row's `status` cell is now the DISPLAYED status. The
      // awaiting, not-yet-ended row reads Waiting (matching the cloud list
      // projection); the ended one keeps its raw Active.
      assert.deepEqual(
        all.items.map((item) => [item.id, item.status]).sort(),
        [
          ["awaiting-ended-session", "active"],
          ["awaiting-running-session", "waiting"],
          ["running-session", "active"],
        ].sort()
      );

      // ...and each row is returned by EXACTLY the facet of the status it just
      // displayed — the cell, the filter, and (below) the sort read one value.
      assert.deepEqual(active.items.map((item) => item.id).sort(), [
        "awaiting-ended-session",
        "running-session",
      ]);
      assert.deepEqual(
        waiting.items.map((item) => item.id),
        ["awaiting-running-session"]
      );

      // The Status SORT groups by the same projection, so the displayed-Waiting
      // row sorts after the two displayed-Active rows (rank 0 → 1) rather than
      // among them.
      const sorted = await getSharedAgentSessions(source, {
        sortBy: "status",
        sortDir: "asc",
      });
      assert.deepEqual(
        sorted.items.map((item) => item.status),
        ["active", "active", "waiting"]
      );
    } finally {
      setDisplayedStatusParityResolver(() => false);
    }
  });

  test("displayed-status parity matches the shared cross-surface oracle (ISS-4556 / ISS-4559)", async () => {
    // The SAME table `apps/api`'s `displayed-status-parity.test.ts` asserts the
    // cloud projection and facet predicate against. Two implementations checked
    // against ONE fixture: if either surface drifts, its suite reddens. Asserting
    // each against its own local constant is what let FEA-4301's derivations
    // separate in the first place.
    setDisplayedStatusParityResolver(() => true);
    try {
      for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
        const source = createFakeSource({
          cursorRows: [cursor("parity-session")],
          sessions: {
            "parity-session": session({
              id: "parity-session",
              status: parityCase.rawStatus,
              awaitingInputSince: parityCase.awaitingInput
                ? "2026-01-01T01:30:00.000Z"
                : null,
              endedAt: parityCase.ended ? "2026-01-01T02:00:00.000Z" : null,
              // ISS-4556: staleness is one of the oracle's dimensions, because
              // ACTIVE carries `NOT staleAnchor` and STALE carries an
              // awaiting-input clause — so the two only partition when both
              // subtract the same population, and pinning every row fresh made
              // this suite unable to see the case where they do not.
              lastActivityAt: parityCase.staleAnchor
                ? staleActivityAt()
                : recentActivityAt(),
            }),
          },
        });

        const all = await getSharedAgentSessions(source, {});
        assert.deepEqual(
          all.items.map((item) => item.status),
          [parityCase.displayedStatus],
          `displayed status: ${parityCase.name}`
        );

        for (const [facet, expected] of [
          [SESSION_STATUS.ACTIVE, parityCase.matchedByActiveFacet],
          [DISPLAYED_SESSION_STATUS.WAITING, parityCase.matchedByWaitingFacet],
          [DISPLAYED_SESSION_STATUS.STALE, parityCase.matchedByStaleFacet],
          [DISPLAYED_SESSION_STATUS.UNKNOWN, parityCase.matchedByUnknownFacet],
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
    } finally {
      setDisplayedStatusParityResolver(() => false);
    }
  });
});
