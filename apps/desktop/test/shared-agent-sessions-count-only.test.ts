/**
 * @file shared-agent-sessions-count-only.test.ts
 * @description FEA-4142 count-only badge reads, split out of
 * `shared-agent-sessions-api.test.ts` (a shrink-only grandfathered file) by
 * ISS-5443, which added a `dateWindowField` assertion to the count filters here.
 * Self-contained: it drives one entry point against the shared fake source, so
 * it lifts whole and leaves the api suite smaller than it found it.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/main/agent-sync/session-date-window.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
} from "./shared-agent-sessions-test-helpers.js";

// FEA-4142: the count-only badge read answers `total` from a single SQL
// `COUNT(*)` (`countSessions`) instead of enumerating cursors and hydrating the
// corpus. It returns no rows.
describe("getSharedAgentSessions count-only reads (FEA-4142)", () => {
  test("answers the badge count via countSessions without hydrating rows", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
      countSessions: () => 7,
    });

    const response = await getSharedAgentSessions(source, {
      statuses: ["completed"],
      completedAfter: "2026-03-12T00:00:00.000Z",
      limit: 1,
      countOnly: true,
    });

    assert.equal(response.total, 7);
    assert.deepEqual(response.items, []);
    assert.equal(response.idleCount, 0);
    assert.equal(response.viewerScope, "self");
    // Exactly one COUNT — no cursor enumeration, no hydrate.
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["countSessions"]
    );
    // The completion bound is serialized to the ISO string the SQL compares.
    assert.deepEqual(source.calls[0]?.countFilters, {
      dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
      statuses: ["completed"],
      completedAfter: "2026-03-12T00:00:00.000Z",
    });
  });

  test("does not take the COUNT fast path when a search makes the query non-count-expressible", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a")],
      countSessions: () => {
        throw new Error("countSessions should be bypassed");
      },
    });

    const response = await getSharedAgentSessions(source, {
      statuses: ["completed"],
      search: "needle",
      countOnly: true,
    });

    // The contract: the COUNT fast path is refused, because it cannot express a
    // free-text search. Where the read goes INSTEAD is a separate decision —
    // goal stage 1b moved this sortless shape from the whole-corpus enumeration
    // to the SQL cursor page, whose own SQL does implement the search.
    assert.ok(!source.calls.some((call) => call.kind === "countSessions"));
    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listSessionCursorPage", "loadSyncedSessions"]
    );
    assert.equal(response.viewerScope, "self");
  });

  test("ignores the hint (hydrates) when the source has no countSessions delegate", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a"), cursor("session-b")],
    });

    const response = await getSharedAgentSessions(source, {
      statuses: ["completed"],
      completedAfter: "2026-03-12T00:00:00.000Z",
      countOnly: true,
    });

    assert.deepEqual(
      source.calls.map((call) => call.kind),
      ["listAllSessionCursorRows", "loadSyncedSessions"]
    );
    assert.equal(response.viewerScope, "self");
  });
});
