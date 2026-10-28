import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  Harness,
  type NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { appendTokenEvents } from "../src/main/database/token-event-contract.js";
import { makeSession } from "./normalized-session-test-utils.js";

/**
 * ISS-7448. `token_events.created_at` is TEXT outside `HEALED_COLUMNS`, so one
 * session's rows can carry several spellings of the same instant — written by
 * older builds or a direct write, since every current producer routes through
 * `toIso`. Each fixture below is ONE SESSION whose stored spellings put BYTE
 * order at odds with TIME order: `Z` (0x5A) sorts above `.` (0x2E), so a
 * whole-second stamp out-sorts every sub-second sibling of the same instant,
 * and an offset form out-sorts by its wall-clock digits. A single-spelling
 * fixture passes while the defect is live.
 */

const NOW = "2026-08-02T07:00:00.000Z";
const SESSION_STARTED_AT = "2026-08-02T06:58:00.000Z";
const MODEL = "claude-opus-4-5";

/** 06:59:00Z spelled three ways — canonical, whole-second, +05:00 offset. */
const CANONICAL_AT = "2026-08-02T06:59:00.000Z";
const WHOLE_SECOND_AT = "2026-08-02T06:59:00Z";
const OFFSET_AT = "2026-08-02T11:59:00+05:00";
/** Half a second LATER than all three, and byte-wise below every one of them. */
const NEXT_EVENT_AT = "2026-08-02T06:59:00.500Z";

/**
 * The basic-format offset SQLite cannot parse, so the SSOT declines it and the
 * stored side dissents. Byte-wise it out-sorts both canonical stamps below.
 */
const UNCANONICALIZABLE_AT = "2026-06-25T10:00:00.000+0530";
const EARLIER_CANONICAL_AT = "2026-06-22T10:00:00.000Z";
const BETWEEN_CANONICAL_AT = "2026-06-23T10:00:00.000Z";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

test("appends an event newer than every stored spelling of the high-water instant", async () => {
  await withSessionDb(async (db, sessionId) => {
    // The noncanonical rows carry NO transport id. That is the only stored
    // population canonical mode admits — see the guard test below for why.
    await insertStoredTokenEvent(db, sessionId, CANONICAL_AT, "stored-a");
    await insertStoredTokenEvent(db, sessionId, WHOLE_SECOND_AT, null);
    await insertStoredTokenEvent(db, sessionId, OFFSET_AT, null);

    const record = tokenRecord(NEXT_EVENT_AT);
    const appended = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [record])
    );

    assert.equal(appended.length, 1);
    // Byte order, which is exactly what disagrees with time order here.
    assert.deepEqual(await readCreatedAt(db, sessionId), [
      CANONICAL_AT,
      NEXT_EVENT_AT,
      WHOLE_SECOND_AT,
      OFFSET_AT,
    ]);
  });
});

test("skips a legacy row re-presented in a canonical spelling", async () => {
  await withSessionDb(async (db, sessionId) => {
    await insertStoredTokenEvent(db, sessionId, WHOLE_SECOND_AT, null);

    const appended = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [tokenRecord(CANONICAL_AT)])
    );

    assert.deepEqual(appended, []);
    assert.deepEqual(await readCreatedAt(db, sessionId), [WHOLE_SECOND_AT]);
    assert.deepEqual(await readTransportIds(db, sessionId), [null]);
  });
});

test("skips a legacy row re-presented in its own stored spelling", async () => {
  await withSessionDb(async (db, sessionId) => {
    await insertStoredTokenEvent(db, sessionId, WHOLE_SECOND_AT, null);

    const appended = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [tokenRecord(WHOLE_SECOND_AT)])
    );

    assert.deepEqual(appended, []);
    assert.deepEqual(await readCreatedAt(db, sessionId), [WHOLE_SECOND_AT]);
    assert.deepEqual(await readTransportIds(db, sessionId), [null]);
  });
});

test("inserts a distinct event at the high-water instant a legacy row occupies", async () => {
  await withSessionDb(async (db, sessionId) => {
    await insertStoredTokenEvent(db, sessionId, WHOLE_SECOND_AT, null);

    // Same corrected instant as the legacy row, different usage — a genuinely
    // new event, so the `===` branch must content-compare and NOT consume the
    // legacy identity. The positive control for the two skip cases above: it is
    // what separates "matched on content" from "silently dropped as stale".
    const appended = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [
        { ...tokenRecord(CANONICAL_AT), input: 99 },
      ])
    );

    assert.equal(appended.length, 1);
    assert.deepEqual(await readCreatedAt(db, sessionId), [
      CANONICAL_AT,
      WHOLE_SECOND_AT,
    ]);
  });
});

test("keeps the stored form when one stored row cannot be canonicalized", async () => {
  await withSessionDb(async (db, sessionId) => {
    await insertStoredTokenEvent(db, sessionId, EARLIER_CANONICAL_AT, "keep-a");
    await insertStoredTokenEvent(db, sessionId, UNCANONICALIZABLE_AT, "keep-b");

    // Byte-wise `MAX` is the un-canonicalizable row, which out-sorts the record,
    // so the shipped behavior drops it. Dropping the dissenting operand instead
    // would collapse the mark three days backward onto EARLIER_CANONICAL_AT and
    // admit this record — the ISS-5497 half of the rule the guard exists for.
    const appended = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [tokenRecord(BETWEEN_CANONICAL_AT)])
    );

    assert.deepEqual(appended, []);
    assert.deepEqual(await readCreatedAt(db, sessionId), [
      EARLIER_CANONICAL_AT,
      UNCANONICALIZABLE_AT,
    ]);
  });
});

test("keeps the stored form when one record in the batch is not canonical", async () => {
  await withSessionDb(async (db, sessionId) => {
    // The stored side is the first case's — admitted on its own — so the
    // non-canonical RECORD below is the only thing that can decide the mode.
    await insertStoredTokenEvent(db, sessionId, CANONICAL_AT, "stored-a");
    await insertStoredTokenEvent(db, sessionId, WHOLE_SECOND_AT, null);
    await insertStoredTokenEvent(db, sessionId, OFFSET_AT, null);

    // The first case's fixture and its record, plus one non-canonical sibling.
    // The mode is decided per CALL, so the sibling drops the whole batch onto
    // the stored form and the record the first case proves is inserted is not.
    const appended = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [
        tokenRecord(NEXT_EVENT_AT),
        tokenRecord(WHOLE_SECOND_AT),
      ])
    );

    assert.deepEqual(appended, []);
    assert.deepEqual(await readCreatedAt(db, sessionId), [
      CANONICAL_AT,
      WHOLE_SECOND_AT,
      OFFSET_AT,
    ]);
  });
});

test("does not duplicate a generated-id row re-presented in a canonical spelling", async () => {
  await withSessionDb(async (db, sessionId) => {
    // A build before ISS-6738 wrote this event through the production path, so
    // its GENERATED transport id hashes the whole-second spelling AND the array
    // occurrence — which is not a column, so nothing can re-derive that id from
    // the row. Today's build re-presents the same event canonically, hashing a
    // DIFFERENT id that the partial unique index cannot match to the old row.
    // Healing the mark would move this record onto the insert path and store it
    // twice, so the stored side must decline canonical mode.
    const stored = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [tokenRecord(WHOLE_SECOND_AT)])
    );
    assert.equal(stored.length, 1);

    const replayed = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [tokenRecord(CANONICAL_AT)])
    );

    assert.deepEqual(replayed, []);
    assert.deepEqual(await readCreatedAt(db, sessionId), [WHOLE_SECOND_AT]);
  });
});

function tokenRecord(timestamp: string): NormalizedTokenRecord {
  return {
    timestamp,
    model: MODEL,
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

async function withSessionDb(
  run: (db: Db, sessionId: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-event-hwm-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  const sessionId = "token-event-hwm-session";
  try {
    await db.importer.importSession(
      makeSession({
        sessionId,
        model: MODEL,
        startedAt: SESSION_STARTED_AT,
        tokensByModel: {},
        tokenSeries: [],
      }),
      Harness.Claude
    );
    await run(db, sessionId);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function insertStoredTokenEvent(
  db: Db,
  sessionId: string,
  createdAt: string,
  transportId: string | null
): Promise<number> {
  const record = tokenRecord(createdAt);
  return db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      sessionId,
      transportId,
      record.model,
      createdAt,
      record.input,
      record.output,
      record.cacheRead,
      record.cacheWrite
    )
  );
}

function readCreatedAt(db: Db, sessionId: string): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ created_at: string }[]>(
      `SELECT created_at FROM token_events
        WHERE session_id = $1 ORDER BY created_at ASC`,
      sessionId
    )
    .then((rows) => rows.map((row) => row.created_at));
}

function readTransportIds(
  db: Db,
  sessionId: string
): Promise<(string | null)[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ transport_id: string | null }[]>(
      `SELECT transport_id FROM token_events
        WHERE session_id = $1 ORDER BY created_at ASC`,
      sessionId
    )
    .then((rows) => rows.map((row) => row.transport_id));
}
