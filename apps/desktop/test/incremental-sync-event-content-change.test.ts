/**
 * @file incremental-sync-event-content-change.test.ts
 * @description ISS-8757 (whitlockk on #6383): an event-row CONTENT change must advance
 * `sessions.updated_at` — the FEA-1962 incremental-sync cursor signal — exactly as
 * a POPULATION change already does.
 *
 * The gap ISS-8699 left: it bracketed `importPhaseEvents` with the stored event
 * ROW COUNT, which answers "were rows appended or removed" and nothing else. The
 * reachable equal-cardinality case is a tool call whose `tool_result` lands on a
 * LATER parse: `importToolEventData` then writes `isError` / `resultTimestamp` /
 * `detail.tool_response` into `events.data`, but `deterministicEventId` is keyed
 * on the tool_USE timestamp, so the row keeps its id and the count is unchanged.
 * Tool uses are absent from the `sessions.metadata` blob, so `sessionDataChanged`
 * misses it too — the import reported `skipped: true`, `updated_at` never moved,
 * and `listUpdatedSessionCursorRows` never re-selected the session.
 *
 * WHAT THESE TESTS DO AND DO NOT ESTABLISH. They prove the LOCAL half only: the
 * bracket sees an equal-cardinality content change, the watermark advances, and
 * the cursor re-selects. They deliberately do not claim the tool result reaches
 * the cloud, because it does not — FEA-2718 removed `summary`/`data` from the
 * drain (`omitEventData`), from `sanitizeSessionForSync` (which rebuilds each
 * event from five fields) and from the ingest schema, and `AgentSessionEvent` has
 * no column for them. The re-upload this bump triggers carries a byte-identical
 * event payload; turn/tool detail reaches the cloud via the FEA-2717 transcript
 * archive instead. ISS-8876 holds that open question. What the bracket does buy
 * on the wire is the five columns that ARE synced (`id`, `agent_id`,
 * `event_type`, `tool_name`, `created_at`), where an equal-cardinality rewrite
 * now moves the watermark and a row count could not.
 *
 * These tests drive the REAL ingest path (`db.importer.importSession`) against a
 * live SQLite store and read the selection back through the REAL cursor scan.
 * The tool use is a plain `Read` — not a delegation — so it mints no subagent and
 * no component invocation, and its `output` carries no PR/issue/branch ref, so
 * neither `linksChanged` nor `invocationSetChanged` can supply the bump. That
 * isolation is what makes the event-content detector the ONLY thing under test.
 *
 * Equal cardinality is asserted explicitly in both directions: the enrichment must
 * leave the event-row count untouched, which is what separates this from the
 * ISS-8699 append case that a row count already catches.
 *
 * The clock is a distinct literal per import, which is what makes the idempotency
 * assertions non-vacuous: a repeat import must leave `updated_at` pinned to the
 * ENRICHMENT's timestamp, so an unconditional "bump to now" fails just as loudly
 * as the missing bump does.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss8757-live-session";
/** Inside RECENT_ACTIVITY_MS of every clock below, so the row stays live throughout. */
const LIVE_FILE_MTIME_MS = Date.parse("2026-06-07T11:59:00.000Z");
const FIRST_IMPORT_AT = "2026-06-07T12:00:00.000Z";
const REIMPORT_AT = "2026-06-07T12:01:00.000Z";
const ENRICHED_IMPORT_AT = "2026-06-07T12:02:00.000Z";
const REPEAT_ENRICHED_IMPORT_AT = "2026-06-07T12:03:00.000Z";
/**
 * Since #8910 (ISS-10713) the landed tool_result also gives its invocation a
 * measured duration, so the enriching import commits two signals for this
 * session in one pass: the event write publishes the row at the clock, then the
 * changed invocation set advances it to the next millisecond
 * (`sessionSyncWatermarkTarget`'s intra-pass strict-progress rule).
 */
const ENRICHED_WATERMARK = "2026-06-07T12:02:00.001Z";
/** The tool_use's own transcript instant — the sole input to its event id. */
const TOOL_USE_AT = "2026-06-07T10:01:00.000Z";
/** The tool_result's instant, which lands on a LATER parse and is NOT an id input. */
const TOOL_RESULT_AT = "2026-06-07T10:01:04.000Z";
/** Deliberately ref-free prose: an artifact ref here would supply the bump instead. */
const TOOL_OUTPUT = "read 3 lines";
const SAME_LENGTH_TOOL_OUTPUT = "read 4 lines";

/**
 * A live session holding ONE completed-in-transcript-order tool call whose result
 * has not been observed yet — the state of a transcript read mid-tool.
 */
function sessionWithPendingToolResult(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    fileModifiedAt: LIVE_FILE_MTIME_MS,
    toolUses: [
      {
        name: "Read",
        timestamp: TOOL_USE_AT,
        id: "toolu_iss8757",
        input: { file_path: "/workspace/test/example.ts" },
      },
    ],
  });
}

/**
 * The SAME tool call after its `tool_result` was parsed. Only the completion
 * fields differ, so the row's deterministic id — (session, type, tool_USE ts,
 * tool name, discriminator) — and the event population are both unchanged.
 */
function withObservedToolResult(
  session: NormalizedSession,
  output = TOOL_OUTPUT
): NormalizedSession {
  return {
    ...session,
    toolUses: [
      {
        ...session.toolUses![0],
        output,
        resultTimestamp: TOOL_RESULT_AT,
        isError: false,
      },
    ],
  };
}

type Db = SqliteAgentDatabase;

/**
 * The row's stored sync watermark. Returns the literal `"<absent>"` rather than
 * asserting, so a missing row fails the CALLER's timestamp comparison (inside
 * the test) with the session id in the message.
 */
async function updatedAtOf(db: Db, sessionId: string): Promise<string> {
  const rows = await db.syncSource.listAllSessionCursorRows();
  const row = rows.find((candidate) => candidate.id === sessionId);
  return row?.updated_at ?? `<absent: ${sessionId}>`;
}

/**
 * The ids the production incremental scan would hand the sync lane when it
 * resumes from `watermark` having already delivered `observed`.
 */
async function selectedSince(
  db: Db,
  watermark: string,
  observed: readonly string[]
): Promise<string[]> {
  const rows = await db.syncSource.listUpdatedSessionCursorRows(watermark, [
    ...observed,
  ]);
  return rows.map((row) => row.id);
}

/**
 * The stored `events.data` of the one imported tool row, as raw text. Returns a
 * `"<n Read rows>"` literal rather than asserting when the fixture did not
 * produce exactly one, so the mismatch fails the CALLER's comparison — the same
 * sentinel shape {@link updatedAtOf} uses for a missing row.
 */
async function toolEventData(db: Db, sessionId: string): Promise<string> {
  const rows = await db.events.getBySession(sessionId);
  const toolRows = rows.filter((row) => row.toolName === "Read");
  if (toolRows.length !== 1) {
    return `<${toolRows.length} Read rows, expected 1>`;
  }
  return toolRows[0].data ?? "";
}

async function eventCount(db: Db, sessionId: string): Promise<number> {
  return (await db.events.getBySession(sessionId)).length;
}

async function withDb(
  run: (db: Db, setClock: (at: string) => void) => Promise<void>,
  rowDigestSupportProbe?: () => Promise<boolean>
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8757-"));
  let clock = FIRST_IMPORT_AT;
  // The shared opener, not a hand-rolled one: its teardown adds the ISS-5100
  // foreign-key check and the ISS-5101 swallowed-import-failure assertion, so a
  // tolerated group that silently failed mid-import fails this test too.
  const db = await openTestDb(dir, {
    now: () => clock,
    ...(rowDigestSupportProbe ? { rowDigestSupportProbe } : {}),
  });
  try {
    await run(db, (at: string) => {
      clock = at;
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-8757: a tool result landing on a later parse advances the sync cursor", async () => {
  await withDb(async (db, setClock) => {
    const pending = sessionWithPendingToolResult();
    assert.equal(
      (await db.importer.importSession(pending, Harness.Claude)).skipped,
      false
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), FIRST_IMPORT_AT);
    assert.equal(
      (await db.sessions.getById(SESSION_ID))?.status,
      SESSION_STATUS.ACTIVE,
      "precondition: the row must be ALREADY LIVE, not reactivated by the enrichment"
    );
    const eventsBefore = await eventCount(db, SESSION_ID);
    const dataBefore = await toolEventData(db, SESSION_ID);
    assert.equal(
      dataBefore.includes("toolu_iss8757"),
      true,
      "precondition: the ONE Read tool row was actually written and read back"
    );
    assert.equal(
      dataBefore.includes("tool_response"),
      false,
      "precondition: the pending tool call carries no result detail yet"
    );

    // The cursor has now delivered this session at FIRST_IMPORT_AT.
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [],
      "nothing is owed to the cloud before the result lands"
    );

    setClock(ENRICHED_IMPORT_AT);
    const enriched = await db.importer.importSession(
      withObservedToolResult(pending),
      Harness.Claude
    );

    // The defining property of this ticket, asserted before the outcome: the
    // population did not move, so a row COUNT cannot see this change at all.
    assert.equal(
      await eventCount(db, SESSION_ID),
      eventsBefore,
      "precondition: the enrichment is EQUAL-CARDINALITY — no row was added or removed"
    );
    const dataAfter = await toolEventData(db, SESSION_ID);
    assert.notEqual(
      dataAfter,
      dataBefore,
      "precondition: the row's synced `data` genuinely changed on disk"
    );
    assert.equal(
      dataAfter.includes(TOOL_RESULT_AT),
      true,
      "the enriched row must carry the tool_result timestamp"
    );

    assert.equal(
      enriched.skipped,
      false,
      "a durable change to a synced event column is not a skip"
    );
    assert.equal(
      enriched.reactivated,
      false,
      "the row was already live — this must not travel the reactivation path"
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), ENRICHED_WATERMARK);
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session after the result lands"
    );
  });
});

test("ISS-8757: an unchanged re-import is still a no-op and does not re-arm the cursor", async () => {
  await withDb(async (db, setClock) => {
    const pending = sessionWithPendingToolResult();
    await db.importer.importSession(pending, Harness.Claude);

    setClock(REIMPORT_AT);
    const reimported = await db.importer.importSession(pending, Harness.Claude);
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

    setClock(ENRICHED_IMPORT_AT);
    const enrichedInput = withObservedToolResult(pending);
    await db.importer.importSession(enrichedInput, Harness.Claude);
    const afterEnrichment = await updatedAtOf(db, SESSION_ID);
    assert.equal(afterEnrichment, ENRICHED_WATERMARK);
    const eventsAfterEnrichment = await eventCount(db, SESSION_ID);
    const dataAfterEnrichment = await toolEventData(db, SESSION_ID);
    assert.equal(
      dataAfterEnrichment.includes(TOOL_RESULT_AT),
      true,
      "precondition: the enriched row was read back, so the equality below is not vacuous"
    );

    // The same enriched input again, on a LATER clock. Nothing durable changed,
    // so nothing may move: a content signal that reports "changed" on every pass
    // — the mirror defect of the gap this ticket closes — stamps
    // REPEAT_ENRICHED_IMPORT_AT here and fails.
    setClock(REPEAT_ENRICHED_IMPORT_AT);
    const repeated = await db.importer.importSession(
      enrichedInput,
      Harness.Claude
    );

    assert.equal(repeated.skipped, true, "the repeat writes nothing durable");
    assert.equal(
      await eventCount(db, SESSION_ID),
      eventsAfterEnrichment,
      "the repeat must not duplicate the enriched event"
    );
    assert.equal(
      await toolEventData(db, SESSION_ID),
      dataAfterEnrichment,
      "the repeat must re-derive byte-identical `data`"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      afterEnrichment,
      "the watermark must stay pinned to the enrichment, not advance to the repeat's clock"
    );
    assert.deepEqual(
      await selectedSince(db, afterEnrichment, [SESSION_ID]),
      [],
      "a settled session must not be re-selected — that is the update loop"
    );
  });
});

test("ISS-8876: portable fallback detects an equal-length event substitution", async () => {
  await withDb(
    async (db, setClock) => {
      const pending = sessionWithPendingToolResult();
      await db.importer.importSession(
        withObservedToolResult(pending),
        Harness.Claude
      );
      const eventsBefore = await eventCount(db, SESSION_ID);
      const dataBefore = await toolEventData(db, SESSION_ID);
      assert.equal(dataBefore.includes(TOOL_OUTPUT), true);

      setClock(ENRICHED_IMPORT_AT);
      const changed = await db.importer.importSession(
        withObservedToolResult(pending, SAME_LENGTH_TOOL_OUTPUT),
        Harness.Claude
      );
      const dataAfter = await toolEventData(db, SESSION_ID);

      assert.equal(await eventCount(db, SESSION_ID), eventsBefore);
      assert.equal(dataAfter.length, dataBefore.length);
      assert.notEqual(dataAfter, dataBefore);
      assert.equal(dataAfter.includes(SAME_LENGTH_TOOL_OUTPUT), true);
      assert.equal(changed.skipped, false);
      assert.equal(await updatedAtOf(db, SESSION_ID), ENRICHED_IMPORT_AT);
      assert.deepEqual(await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]), [
        SESSION_ID,
      ]);
    },
    async () => false
  );
});
