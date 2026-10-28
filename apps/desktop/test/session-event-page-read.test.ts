/**
 * @file session-event-page-read.test.ts
 * @description ISS-9857: the SQLite keyset page of a session's raw events past
 * the detail read's bounded prefix, driven through the composed
 * `db.syncSource.loadSessionEventPage` on a real store so the SQL, the row
 * mapping and the cursor codec are all exercised as the IPC handler sees them.
 *
 * The fixture is five rows where two share a `created_at` and their ids sort
 * against insertion order, so the `(created_at, id)` tiebreak is what decides
 * where a page ends and the next begins — a `created_at`-only keyset would
 * either repeat or skip the pair.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decodeSessionEventCursor,
  encodeSessionEventCursor,
} from "@repo/api/src/types/agent-session-event-cursor";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const SESSION_ID = "page-session";
const SHARED_AT = "2026-07-10T00:00:01.000Z";

/**
 * Insertion order is NOT keyset order: `e-b` and `e-a` share an instant and
 * sort by id (`e-a` before `e-b`), so a page walk that trusted row order or
 * `created_at` alone would serve them in the wrong order or twice.
 */
const EVENT_ROWS = [
  { id: "e-0", at: "2026-07-10T00:00:00.000Z", data: null },
  { id: "e-b", at: SHARED_AT, data: null },
  { id: "e-a", at: SHARED_AT, data: '{"tool":"Bash"}' },
  { id: "e-3", at: "2026-07-10T00:00:03.000Z", data: null },
  { id: "e-4", at: "2026-07-10T00:00:04.000Z", data: null },
] as const;

/**
 * The order the `(created_at ASC, id ASC)` keyset serves the fixture in. The
 * same-instant pair sits at positions 1 and 2, so a limit-2 walk's first page
 * boundary falls BETWEEN them.
 */
const KEYSET_ORDER = ["e-0", "e-a", "e-b", "e-3", "e-4"] as const;

async function withSeededDb(
  body: (
    loadPage: (input: {
      sessionId: string;
      after?: { createdAt: string; externalEventId: string };
      limit: number;
    }) => Promise<AgentSessionEventsPage | null>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss9857-event-page-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, status) VALUES ('${SESSION_ID}','${SESSION_STATUS.INACTIVE}')`
    );
    const values = EVENT_ROWS.map(
      (row) =>
        `('${row.id}', '${SESSION_ID}', 'PostToolUse', 'Bash', 'summary ${row.id}', ${
          row.data === null ? "NULL" : `'${row.data}'`
        }, '${row.at}')`
    ).join(", ");
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, summary, data, created_at)
       VALUES ${values}`
    );
    // Invoked as a member on every call: in production `syncSource` is the
    // db-host Proxy, which dispatches on the property access itself. A source
    // without the member is the composition regression the first test pins.
    await body(async (input) => {
      if (!db.syncSource.loadSessionEventPage) {
        throw new Error(
          "the SQLite source does not compose loadSessionEventPage"
        );
      }
      return (await db.syncSource.loadSessionEventPage(input)) ?? null;
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The served ids, or `null` for a null page so a deepEqual names the miss. */
function ids(page: AgentSessionEventsPage | null): string[] | null {
  return page?.events.map((event) => event.externalEventId) ?? null;
}

test("ISS-9857: a limit-2 walk serves the keyset order in three pages and drops nextCursor at the end", () =>
  withSeededDb(async (loadPage) => {
    const first = await loadPage({ sessionId: SESSION_ID, limit: 2 });
    assert.ok(first, "the composed source answers a page for a known session");
    assert.deepEqual(ids(first), KEYSET_ORDER.slice(0, 2));
    assert.ok(first?.nextCursor, "a page with rows past it mints a cursor");
    // The probe row is never served: a page carries at most `limit` rows.
    assert.equal(first.events.length, 2);

    // Replaying the cursor verbatim continues STRICTLY after the last served
    // `(created_at, id)`. The pair sharing an instant straddles this boundary,
    // so the id tiebreak is what makes page two start on `e-b`: a
    // `created_at >` keyset alone would skip it, a `created_at >=` one would
    // repeat `e-a`.
    const firstCursor = decodeSessionEventCursor(first.nextCursor);
    assert.deepEqual(firstCursor, {
      createdAt: SHARED_AT,
      externalEventId: "e-a",
    });
    const second = await loadPage({
      sessionId: SESSION_ID,
      after: firstCursor,
      limit: 2,
    });
    assert.deepEqual(ids(second), KEYSET_ORDER.slice(2, 4));
    assert.equal(second?.events[0]?.createdAt, SHARED_AT);
    assert.ok(second?.nextCursor, "one row remains past page two");
    assert.equal(second.events.length, 2);

    const secondCursor = decodeSessionEventCursor(second.nextCursor);
    assert.ok(secondCursor);
    const third = await loadPage({
      sessionId: SESSION_ID,
      after: secondCursor,
      limit: 2,
    });
    assert.deepEqual(ids(third), KEYSET_ORDER.slice(4));
    // ABSENCE is the only encoding of "last page" — never a null or an empty
    // string a reader would have to interpret.
    assert.equal(
      Object.hasOwn(third ?? {}, "nextCursor"),
      false,
      "the last page omits nextCursor"
    );
  }));

test("ISS-9857: a page row is mapped like a detail row, with data parsed to a value", () =>
  withSeededDb(async (loadPage) => {
    const page = await loadPage({ sessionId: SESSION_ID, limit: 5 });
    assert.ok(page);
    const [plain, withData] = page.events;
    assert.equal(withData?.externalEventId, "e-a");
    assert.deepEqual(plain, {
      externalEventId: "e-0",
      agentExternalId: null,
      eventType: "PostToolUse",
      toolName: "Bash",
      summary: "summary e-0",
      data: null,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    assert.deepEqual(withData?.data, { tool: "Bash" });
    // Exactly the whole stream fits, so no probe row came back and no cursor
    // is minted — the client sees a complete read on its first click.
    assert.equal(page.events.length, 5);
    assert.equal(Object.hasOwn(page, "nextCursor"), false);
  }));

test("ISS-9857: an unknown session id answers null, not an empty page", () =>
  withSeededDb(async (loadPage) => {
    const page = await loadPage({ sessionId: "no-such-session", limit: 2 });
    // The same fail-closed answer the detail read gives; an empty page here
    // would let a mistyped id read as a session with no events.
    assert.equal(page, null);
  }));

test("ISS-9857: a cursor past the last row answers an empty page with no nextCursor", () =>
  withSeededDb(async (loadPage) => {
    const page = await loadPage({
      sessionId: SESSION_ID,
      after: { createdAt: "2026-07-10T00:00:04.000Z", externalEventId: "e-4" },
      limit: 2,
    });
    assert.deepEqual(page, { events: [] });
  }));

test("ISS-9857: the served cursor round-trips through the shared codec", () =>
  withSeededDb(async (loadPage) => {
    const page = await loadPage({ sessionId: SESSION_ID, limit: 1 });
    assert.ok(page?.nextCursor);
    // The page's cursor IS the codec's encoding of its last served row, so a
    // client replaying it verbatim and a producer re-minting it agree.
    assert.equal(
      page.nextCursor,
      encodeSessionEventCursor({
        createdAt: "2026-07-10T00:00:00.000Z",
        externalEventId: "e-0",
      })
    );
  }));
