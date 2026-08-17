import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import { setDisplayedStatusParityResolver } from "../src/main/session/displayed-status-parity-gate.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  recentActivityAt,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * Goal stage 1 — the Status facet on the SQL cursor page, pinned at the PUBLIC
 * entry point (`getSharedAgentSessions`).
 *
 * WHY HERE AND NOT WITH THE OTHER STATUS TESTS (wongk, PR #4835). The SQLite
 * coverage calls `listSessionCursorPage` directly, and the existing public
 * status suites all assert ITEMS, which the capped full-corpus hydration
 * fallback produces just as correctly as the cursor page does. So every one of
 * them stays green if the admission predicate goes back to rejecting a status
 * selection — and full-corpus hydration on every list poll, the thing this
 * change exists to remove, silently returns. These tests assert the ROUTE the
 * read took, which is the only thing that fails when it regresses.
 */
describe("shared agent sessions status facet on the cursor page", () => {
  function activeAndInactiveSource() {
    return createFakeSource({
      cursorRows: [cursor("live-session"), cursor("ended-session")],
      sessions: {
        "live-session": session({
          id: "live-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
          lastActivityAt: recentActivityAt(),
        }),
        "ended-session": session({
          id: "ended-session",
          status: "inactive",
          awaitingInputSince: null,
          endedAt: "2026-01-01T02:00:00.000Z",
        }),
      },
    });
  }

  test("a status-filtered list read is served by the SQL cursor page, not full-corpus hydration", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = activeAndInactiveSource();

    const active = await getSharedAgentSessions(source, {
      statuses: [SESSION_STATUS.ACTIVE],
      sortBy: SessionListCursorSortKey.LastActivity,
    });

    assert.deepEqual(
      active.items.map((item) => item.id),
      ["live-session"]
    );
    // The route, not just the rows. `listAllSessionCursorRows` IS the capped
    // full-corpus fallback: if the admission predicate starts rejecting a status
    // selection again, the read still returns the right item and only this
    // assertion goes red.
    const kinds = source.calls.map((call) => call.kind);
    assert.ok(
      kinds.includes("listSessionCursorPage"),
      "a status-filtered read must page in SQL"
    );
    assert.ok(
      !kinds.includes("listAllSessionCursorRows"),
      "a status-filtered read must not hydrate the whole corpus"
    );
    // The facet actually reached the SQL request, rather than the page being
    // taken with the status quietly dropped (which would return the same single
    // row here only because the fixture is small).
    const pageCall = source.calls.find(
      (call) => call.kind === "listSessionCursorPage"
    );
    assert.deepEqual(pageCall?.cursorPageRequest?.statuses, [
      SESSION_STATUS.ACTIVE,
    ]);
  });

  test("the single back-compat `status` param rides the cursor page too", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = activeAndInactiveSource();

    const active = await getSharedAgentSessions(source, {
      status: SESSION_STATUS.ACTIVE,
      sortBy: SessionListCursorSortKey.LastActivity,
    });

    assert.deepEqual(
      active.items.map((item) => item.id),
      ["live-session"]
    );
    const pageCall = source.calls.find(
      (call) => call.kind === "listSessionCursorPage"
    );
    assert.deepEqual(pageCall?.cursorPageRequest?.statuses, [
      SESSION_STATUS.ACTIVE,
    ]);
  });

  test("with the displayed-status parity gate ON, a status read keeps the hydrated fallback", async () => {
    // wongk, PR #4835: `listSessionCursorPage` is a `syncSource.*` op forwarded
    // to the DB-host CHILD (FEA-2038), which never registers a parity resolver
    // and so builds the predicate with the fail-closed `false` — while the
    // hydrated matcher in MAIN reads the real, enabled gate. The two stop being
    // twins, and an ended row still carrying `awaitingInputSince` displays as
    // Active but vanishes from the SQL page. Until the pinned decision travels
    // with the request, a status read under the gate must not take this path.
    setDisplayedStatusParityResolver(() => true);
    try {
      const source = activeAndInactiveSource();

      // The sort MUST be the production one: every other admission condition has
      // to be satisfied, so the parity gate is the only reason this falls back.
      await getSharedAgentSessions(source, {
        statuses: [SESSION_STATUS.ACTIVE],
        sortBy: SessionListCursorSortKey.LastActivity,
      });

      const kinds = source.calls.map((call) => call.kind);
      assert.ok(
        !kinds.includes("listSessionCursorPage"),
        "the SQL status page must stay off while the parity gate is on"
      );
      assert.ok(
        kinds.includes("listAllSessionCursorRows"),
        "the read must fall back to the hydrated matcher"
      );
    } finally {
      setDisplayedStatusParityResolver(() => false);
    }
  });

  test("an unfiltered read still pages in SQL while the parity gate is ON", async () => {
    // The carve-out above must be scoped to a STATUS selection. If it widened to
    // every read, the gate would silently put the whole list back on full-corpus
    // hydration — a much bigger regression than the one it prevents.
    setDisplayedStatusParityResolver(() => true);
    try {
      const source = activeAndInactiveSource();

      await getSharedAgentSessions(source, {
        sortBy: SessionListCursorSortKey.LastActivity,
      });

      const kinds = source.calls.map((call) => call.kind);
      assert.ok(
        kinds.includes("listSessionCursorPage"),
        "an unfiltered read must still page in SQL under the gate"
      );
    } finally {
      setDisplayedStatusParityResolver(() => false);
    }
  });

  test("a row that leaves the facet between selection and hydration is dropped from the page", async () => {
    // wongk, PR #4835: selection (`listSessionCursorPage`) and hydration
    // (`loadSyncedSessions`) are separate db-host invokes. Status is the one
    // selected dimension that changes on its own while the user is looking at
    // the list, so model exactly that: SQL selects the row as Active, and by the
    // time it hydrates the session has ended.
    setDisplayedStatusParityResolver(() => false);
    const base = createFakeSource({
      cursorRows: [cursor("transitioning-session"), cursor("live-session")],
      sessions: {
        "transitioning-session": session({
          id: "transitioning-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
          lastActivityAt: recentActivityAt(),
        }),
        "live-session": session({
          id: "live-session",
          status: SESSION_STATUS.ACTIVE,
          awaitingInputSince: null,
          endedAt: null,
          lastActivityAt: recentActivityAt(),
        }),
      },
    });
    const source: typeof base = {
      ...base,
      async loadSyncedSessions(ids, cache, options) {
        const loaded = await base.loadSyncedSessions(ids, cache, options);
        return loaded.map((item) =>
          item.externalSessionId === "transitioning-session"
            ? session({
                id: "transitioning-session",
                status: "inactive",
                awaitingInputSince: null,
                endedAt: new Date().toISOString(),
              })
            : item
        );
      },
    };

    const active = await getSharedAgentSessions(source, {
      statuses: [SESSION_STATUS.ACTIVE],
      sortBy: SessionListCursorSortKey.LastActivity,
    });

    // Without the post-hydration recheck the response carries the ended row
    // under an Active filter, and `mapListItem` renders it with its NEW status —
    // an "Inactive" row inside an Active-filtered list.
    assert.deepEqual(
      active.items.map((item) => item.id),
      ["live-session"]
    );
    assert.ok(
      !active.items.some((item) => item.status === SESSION_STATUS.INACTIVE),
      "no row may render a status the active filter excludes"
    );
  });
});
