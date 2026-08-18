import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import { setDisplayedStatusParityResolver } from "../src/main/session/displayed-status-parity-gate.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import { getSharedAgentSessionsPageData } from "../src/main/session/shared-agent-sessions-page-data.js";
import {
  createFakeSource,
  cursor,
  session,
  usageAggregate,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * Goal stage 1b — an UNSORTED sessions list read rides the SQL cursor page.
 *
 * WHY THE ROUTE AND NOT JUST THE ROWS (same reasoning as the stage-1 status
 * suite next door): the capped full-corpus hydration fallback returns the
 * correct items too, so an items-only assertion stays green if the admission
 * predicate goes back to rejecting a sortless read — and whole-corpus hydration
 * on every list poll, the allocation this change exists to remove, silently
 * returns. Measured on a clone of the real 2.1 GB desktop snapshot (2,962
 * sessions), that one fallback call peaked at +447 MB of JS heap, against the
 * goal's 50 MB per-op ceiling. These tests assert the route, the sort key that
 * makes the route legal, and the hydration WIDTH — the three things that fail
 * when it regresses.
 */
describe("an unsorted sessions list read pages in SQL", () => {
  function threeSessionSource() {
    return createFakeSource({
      cursorRows: [cursor("newest"), cursor("middle"), cursor("oldest")],
      sessions: {
        newest: session({ id: "newest" }),
        middle: session({ id: "middle" }),
        oldest: session({ id: "oldest" }),
      },
    });
  }

  test("a request with no sortBy is served by the cursor page, not full-corpus hydration", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = threeSessionSource();

    const result = await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
    });

    assert.deepEqual(
      result.items.map((item) => item.id),
      ["newest", "middle"]
    );
    const kinds = source.calls.map((call) => call.kind);
    assert.ok(
      kinds.includes("listSessionCursorPage"),
      "an unsorted read must page in SQL"
    );
    assert.ok(
      !kinds.includes("listAllSessionCursorRows"),
      "an unsorted read must not resolve the whole corpus"
    );
  });

  test("the cursor request asks for the natural `updated` order, descending", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = threeSessionSource();

    await getSharedAgentSessions(source, { quality: "all", limit: 2 });

    const pageCall = source.calls.find(
      (call) => call.kind === "listSessionCursorPage"
    );
    // `listAllSessionCursorRows` orders `updated_at DESC, id DESC`, and
    // `sortSyncedSessions` leaves a sortless working set in exactly that
    // incoming order — so this is the order the read was already served in, now
    // named so the SQL page can reproduce it. `sortDir` is pinned desc rather
    // than taken from the request, which carries no sort column to direct.
    assert.equal(
      pageCall?.cursorPageRequest?.sortBy,
      SessionListCursorSortKey.Updated
    );
    assert.equal(pageCall?.cursorPageRequest?.sortDir, "desc");
  });

  test("an explicit sortDir on a sortless request does not flip the cursor order", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = threeSessionSource();

    await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
      sortDir: "asc",
    });

    const pageCall = source.calls.find(
      (call) => call.kind === "listSessionCursorPage"
    );
    // The hydrated fallback ignores `sortDir` when there is no `sortBy`
    // (`sortSyncedSessions` returns its input untouched), so honoring it here
    // would be a behavior change smuggled in with a memory fix.
    assert.equal(pageCall?.cursorPageRequest?.sortDir, "desc");
  });

  test("only the visible page is hydrated, never the whole corpus", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = threeSessionSource();

    await getSharedAgentSessions(source, { quality: "all", limit: 2 });

    const hydrations = source.calls.filter(
      (call) => call.kind === "loadSyncedSessions"
    );
    assert.equal(hydrations.length, 1);
    // The WIDTH is the whole point: the fallback hydrated every matching id (up
    // to MAX_WORKING_SET_SESSIONS = 5000) to produce a 2-row page.
    assert.deepEqual(hydrations[0]?.ids, ["newest", "middle"]);
  });

  test("a sortless read carrying a Status facet still pages in SQL, with the facet", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = threeSessionSource();

    // The combination this change newly makes reachable: goal stage 1 put the
    // Status facet on the cursor page but every read that took it named an
    // explicit sort, so "no sort AND a facet" is a route that did not exist
    // before. A facet admitted but not forwarded is a filter silently dropped
    // on screen, which is why the request field is asserted and not just the
    // route.
    await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
      statuses: [SESSION_STATUS.INACTIVE],
    });

    const pageCall = source.calls.find(
      (call) => call.kind === "listSessionCursorPage"
    );
    assert.equal(
      pageCall?.cursorPageRequest?.sortBy,
      SessionListCursorSortKey.Updated
    );
    assert.deepEqual(pageCall?.cursorPageRequest?.statuses, [
      SESSION_STATUS.INACTIVE,
    ]);
    assert.ok(
      !source.calls.some((call) => call.kind === "listAllSessionCursorRows"),
      "a sortless facet read must not fall back to the whole corpus"
    );
  });

  test("a sortless read forwards its window and search into the same page request", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = threeSessionSource();

    await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
      startDate: "2025-12-01T00:00:00.000Z",
      endDate: "2026-02-01T00:00:00.000Z",
      search: "newest",
    });

    const pageCall = source.calls.find(
      (call) => call.kind === "listSessionCursorPage"
    );
    assert.equal(
      pageCall?.cursorPageRequest?.startDate?.toISOString(),
      "2025-12-01T00:00:00.000Z"
    );
    assert.equal(
      pageCall?.cursorPageRequest?.endDate?.toISOString(),
      "2026-02-01T00:00:00.000Z"
    );
    assert.equal(pageCall?.cursorPageRequest?.search, "newest");
  });

  test("an unfiltered paginated read loads only the requested page", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = createFakeSource({
      cursorRows: [
        cursor("session-a"),
        cursor("session-b"),
        cursor("session-c"),
        cursor("session-d"),
      ],
      sessions: {
        "session-a": session({ id: "session-a" }),
        "session-b": session({ id: "session-b" }),
        "session-c": session({ id: "session-c" }),
        "session-d": session({ id: "session-d" }),
      },
    });

    // Moved here from `shared-agent-sessions-api.test.ts` (shrink-only
    // grandfathered) because this change is what re-pointed it: the same
    // request used to slice a whole-corpus id enumeration and now takes the SQL
    // cursor page, which is this suite's subject.
    const response = await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
      offset: 1,
    });

    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listSessionCursorPage", "loadSyncedSessions"]
    );
    assert.deepEqual(source.calls[1]?.ids, ["session-b", "session-c"]);
    assert.equal(response.total, 4);
    assert.deepEqual(
      response.items.map((item) => item.id),
      ["session-b", "session-c"]
    );
  });

  test("a sort the cursor SQL has no column for still takes the hydrated fallback", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = threeSessionSource();

    await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
      sortBy: "cost",
    });

    const kinds = source.calls.map((call) => call.kind);
    assert.ok(
      !kinds.includes("listSessionCursorPage"),
      "a non-cursor sort column has no SQL page to ride"
    );
    assert.ok(
      kinds.includes("listAllSessionCursorRows"),
      "a non-cursor sort column keeps the hydrated fallback that can apply it"
    );
  });

  test("the combined pageData read — the soak harness's own probe shape — pages in SQL", async () => {
    setDisplayedStatusParityResolver(() => false);
    const source = createFakeSource({
      cursorRows: [cursor("newest"), cursor("middle"), cursor("oldest")],
      sessions: {
        newest: session({ id: "newest" }),
        middle: session({ id: "middle" }),
        oldest: session({ id: "oldest" }),
      },
      // The combined read runs the list AND usage halves. The sqlite source the
      // desktop actually runs exposes `aggregateUsage`, so the usage half is a
      // grouped SQL rollup (measured at +2–5 MB heap on the real 2.1 GB
      // snapshot) — without it here the fake would fall to the usage HYDRATE
      // path and this test would be asserting the wrong source shape.
      aggregateUsage: () =>
        Promise.resolve(usageAggregate({ totalSessions: 3 })),
    });

    // `agentSessionsApi.pageData({ quality: "all" })` is verbatim what the
    // sync-reliability soak runner polls, and the read whose 26% timeout rate is
    // a goal stage 1 acceptance number.
    const result = await getSharedAgentSessionsPageData(source, {
      quality: "all",
      limit: 2,
    });

    assert.deepEqual(
      result.list.items.map((item) => item.id),
      ["newest", "middle"]
    );
    assert.ok(
      !source.calls.some((call) => call.kind === "listAllSessionCursorRows"),
      "the combined page-data read must not resolve the whole corpus either"
    );
  });
});
