import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  Harness,
  type NormalizedTokenRecord,
} from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { appendTokenEvents } from "../src/main/database/token-event-contract.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-02T07:00:00.000Z";
const EVENT_AT = "2026-08-02T06:59:00.000Z";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

test("legacy migration-window identity survives live append and boot replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-legacy-identity-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  const sessionId = "legacy-identity-session";
  const record = legacyTokenRecord();
  const session = makeSession({
    sessionId,
    model: record.model,
    startedAt: "2026-08-02T06:58:00.000Z",
    tokensByModel: {
      [record.model]: {
        input: record.input * 2,
        output: record.output * 2,
        cacheRead: record.cacheRead * 2,
        cacheWrite: record.cacheWrite * 2,
      },
    },
    tokenSeries: [
      { ...record, transportId: "new-producer-transport-id" },
      { ...record },
    ],
  });
  try {
    await db.importer.importSession(
      makeSession({
        ...session,
        tokensByModel: {},
        tokenSeries: [],
      }),
      Harness.Claude
    );
    await insertLegacyTokenEvent(db, sessionId, record);

    const [legacySync] = await db.syncSource.loadSyncedSessions(
      [sessionId],
      emptyAttributionCache()
    );
    const legacyExternalEventId = legacySync?.tokenEvents?.[0]?.externalEventId;
    assert.ok(legacyExternalEventId);

    const appended = await db.prisma.write((tx) =>
      appendTokenEvents(tx, sessionId, [record])
    );
    assert.deepEqual(appended, []);
    assert.equal((await readTokenEventTransportIds(db, sessionId)).length, 1);

    await db.importer.importSession(session, Harness.Claude);
    const firstIds = await readTokenEventTransportIds(db, sessionId);
    assert.equal(firstIds.length, 2);
    assert.ok(firstIds.includes(legacyExternalEventId));
    assert.equal(firstIds.includes("new-producer-transport-id"), false);
    assert.ok(firstIds.some((id) => id?.startsWith("token-event-")));

    await db.importer.importSession(session, Harness.Claude);
    assert.deepEqual(await readTokenEventTransportIds(db, sessionId), firstIds);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function insertLegacyTokenEvent(
  db: Db,
  sessionId: string,
  record: NormalizedTokenRecord
): Promise<number> {
  return db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      sessionId,
      record.model,
      record.timestamp,
      record.input,
      record.output,
      record.cacheRead,
      record.cacheWrite
    )
  );
}

function readTokenEventTransportIds(
  db: Db,
  sessionId: string
): Promise<(string | null)[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ transport_id: string | null }[]>(
      `SELECT transport_id
         FROM token_events
        WHERE session_id = $1
        ORDER BY transport_id ASC`,
      sessionId
    )
    .then((rows) => rows.map((row) => row.transport_id));
}

function legacyTokenRecord(): NormalizedTokenRecord {
  return {
    timestamp: EVENT_AT,
    model: "claude-opus-4-5",
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
  };
}
