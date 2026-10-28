/**
 * @file incremental-sync-event-only-append.test.ts
 * @description ISS-8699: an ALREADY-LIVE session that gains only event rows must
 * advance `sessions.updated_at`, the FEA-1962 incremental-sync cursor signal.
 *
 * The gap (recorded but deliberately not fixed by ISS-5182 v8): event rows are
 * not part of the synced metadata blob, so an event-only append leaves
 * `sessionDataChanged` false; and reactivation is gated on `recentlyActive &&
 * !isLive`, so a session that is already live never sets `reactivated` either.
 * With no other change detector covering events, the import reported
 * `skipped: true`, `updated_at` never moved, and
 * `listUpdatedSessionCursorRows` — the production incremental scan — never
 * re-selected the session, so the appended activity stayed on the machine.
 *
 * These tests drive the REAL ingest path (`db.importer.importSession`) against a
 * live SQLite store and read the selection back through the REAL cursor scan.
 * `turnDurations` is the append: it produces `TurnDuration` event rows and
 * touches neither the metadata blob nor artifact links nor component
 * invocations, so it isolates the event-only case.
 *
 * The clock is a distinct literal per import, which is what makes the
 * idempotency assertions non-vacuous: a repeat import must leave `updated_at`
 * pinned to the APPEND's timestamp, so an unconditional "bump to now" fails just
 * as loudly as the missing bump does.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";
import {
  selectedSince,
  updatedAtOf,
} from "./session-sync-cursor-test-utils.js";

const SESSION_ID = "iss8699-live-session";
/** Inside RECENT_ACTIVITY_MS of every clock below, so the row stays live throughout. */
const LIVE_FILE_MTIME_MS = Date.parse("2026-06-07T11:59:00.000Z");
const FIRST_IMPORT_AT = "2026-06-07T12:00:00.000Z";
const REIMPORT_AT = "2026-06-07T12:01:00.000Z";
const APPEND_IMPORT_AT = "2026-06-07T12:02:00.000Z";
const REPEAT_APPEND_IMPORT_AT = "2026-06-07T12:03:00.000Z";
/** The appended turn's own timestamp; it adds one `TurnDuration` event row. */
const APPENDED_TURN_AT = "2026-06-07T10:02:00.000Z";

function liveSession(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    fileModifiedAt: LIVE_FILE_MTIME_MS,
  });
}

function withAppendedTurn(session: NormalizedSession): NormalizedSession {
  return {
    ...session,
    turnDurations: [{ durationMs: 4200, timestamp: APPENDED_TURN_AT }],
  };
}

type Db = SqliteAgentDatabase;

async function withDb(
  run: (db: Db, setClock: (at: string) => void) => Promise<void>
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8699-"));
  let clock = FIRST_IMPORT_AT;
  // The shared opener, not a hand-rolled one: its teardown adds the ISS-5100
  // foreign-key check and the ISS-5101 swallowed-import-failure assertion, so a
  // tolerated group that silently failed mid-import fails this test too.
  const db = await openTestDb(dir, { now: () => clock });
  try {
    await run(db, (at: string) => {
      clock = at;
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-8699: an event-only append to a live session advances the sync cursor", async () => {
  await withDb(async (db, setClock) => {
    const base = liveSession();
    assert.equal(
      (await db.importer.importSession(base, "claude")).skipped,
      false
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), FIRST_IMPORT_AT);
    assert.equal(
      (await db.sessions.getById(SESSION_ID))?.status,
      SESSION_STATUS.ACTIVE,
      "precondition: the row must be ALREADY LIVE, not reactivated by the append"
    );
    const eventsBefore = (await db.events.getBySession(SESSION_ID)).length;

    // The cursor has now delivered this session at FIRST_IMPORT_AT.
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [],
      "nothing is owed to the cloud before the append"
    );

    setClock(APPEND_IMPORT_AT);
    const appended = await db.importer.importSession(
      withAppendedTurn(base),
      "claude"
    );

    assert.equal(
      appended.skipped,
      false,
      "a durably-appended event is not a skip"
    );
    assert.equal(
      appended.reactivated,
      false,
      "the row was already live — this must not travel the reactivation path"
    );
    assert.equal(
      (await db.events.getBySession(SESSION_ID)).length,
      eventsBefore + 1,
      "the append must actually persist an event row"
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), APPEND_IMPORT_AT);
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session after the append"
    );
  });
});

test("ISS-8699: repeating the appended input is a no-op and does not re-arm the cursor", async () => {
  await withDb(async (db, setClock) => {
    const base = liveSession();
    await db.importer.importSession(base, "claude");

    setClock(REIMPORT_AT);
    const reimported = await db.importer.importSession(base, "claude");
    assert.equal(
      reimported.skipped,
      true,
      "byte-identical re-import is a skip"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      FIRST_IMPORT_AT,
      "an unchanged re-import must not move the watermark to the new clock"
    );

    setClock(APPEND_IMPORT_AT);
    const extended = withAppendedTurn(base);
    await db.importer.importSession(extended, "claude");
    const afterAppend = await updatedAtOf(db, SESSION_ID);
    assert.equal(afterAppend, APPEND_IMPORT_AT);
    const eventsAfterAppend = (await db.events.getBySession(SESSION_ID)).length;

    // The same appended input again, on a LATER clock: nothing durable changed,
    // so nothing may move. A bump keyed on anything other than a real event
    // delta would stamp REPEAT_APPEND_IMPORT_AT here and fail.
    setClock(REPEAT_APPEND_IMPORT_AT);
    const repeated = await db.importer.importSession(extended, "claude");

    assert.equal(repeated.skipped, true, "the repeat writes nothing durable");
    assert.equal(
      (await db.events.getBySession(SESSION_ID)).length,
      eventsAfterAppend,
      "the repeat must not duplicate the appended event"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      afterAppend,
      "the watermark must stay pinned to the append, not advance to the repeat's clock"
    );
    assert.deepEqual(
      await selectedSince(db, afterAppend, [SESSION_ID]),
      [],
      "a settled session must not be re-selected — that is the update loop"
    );
  });
});
