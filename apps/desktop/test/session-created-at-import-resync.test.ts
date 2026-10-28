/**
 * @file session-created-at-import-resync.test.ts
 * @description ISS-12251: an ordinary collector re-import whose only change is
 * a lowered `sessions.created_at` leaves `updated_at` alone, so the incremental
 * cursor never re-selects the row. The created_at write records the re-send as
 * an outbox row on its own transaction, and the real sync lane uploads the
 * session carrying the new `createdAt`. Drives the real importer, the real
 * SQLite store and the real sync lane with a fake transport.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { drainSentSessions } from "./created-at-sync-drain.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openTestDb>>;
type StoredRow = { created_at: string | null; updated_at: string };

const COMPUTE_TARGET_ID = "target-iss12251-import-resync";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET_ID);
const CLOCK = "2026-06-07T12:00:00.000Z";
const ENDED_AT = "2026-06-07T10:05:00.000Z";
const FIRST_CREATED_AT = "2026-06-05T09:00:00.000Z";
const EARLIER_CREATED_AT = "2026-06-01T09:00:00.000Z";
const SESSION_ID = "ses-created-at-import-lowered";

function parsed(fileCreatedAt: string): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    endedAt: ENDED_AT,
    fileCreatedAt: Date.parse(fileCreatedAt),
  });
}

async function withStore(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss12251-import-"));
  const db = await openTestDb(dir, { now: () => CLOCK });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function drain(db: Db): Promise<SyncedAgentSession[]> {
  return drainSentSessions(db.syncSource, COMPUTE_TARGET_ID);
}

async function readRow(db: Db): Promise<StoredRow | undefined> {
  const rows = await db.prisma.client.$queryRawUnsafe<StoredRow[]>(
    "SELECT created_at, updated_at FROM sessions WHERE id = $1",
    SESSION_ID
  );
  return rows[0];
}

async function readOutboxKeys(db: Db): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ source_key: string }[]>(
    "SELECT source_key FROM agent_session_sync_outbox WHERE external_session_id = $1",
    SESSION_ID
  );
  return rows.map((row) => row.source_key);
}

describe("ISS-12251: an ordinary re-import's created_at-only change is uploaded", () => {
  test("from a drained current-revision cursor, a lowered created_at re-sends the session without moving updated_at", async () => {
    await withStore(async (db) => {
      await db.importer.importSession(parsed(FIRST_CREATED_AT), "claude");
      const firstRun = await drain(db);
      assert.deepEqual(
        firstRun.map((session) => session.createdAt),
        [FIRST_CREATED_AT]
      );
      assert.deepEqual(await drain(db), [], "the lane is drained");
      const [cursor] = await db.prisma.client.$queryRawUnsafe<
        { data_revision: number }[]
      >(
        "SELECT data_revision FROM sync_state WHERE source_key = $1",
        SOURCE_KEY
      );
      assert.equal(cursor?.data_revision, effectiveDataRevision());
      const before = await readRow(db);

      await db.importer.importSession(parsed(EARLIER_CREATED_AT), "claude");

      assert.deepEqual(await readRow(db), {
        created_at: EARLIER_CREATED_AT,
        updated_at: before?.updated_at,
      });
      assert.deepEqual(await readOutboxKeys(db), [SOURCE_KEY]);
      const resent = await drain(db);
      assert.deepEqual(
        resent.map((session) => [session.externalSessionId, session.createdAt]),
        [[SESSION_ID, EARLIER_CREATED_AT]]
      );
      assert.deepEqual(await drain(db), [], "the outbox row re-sends once");
      assert.equal((await readRow(db))?.updated_at, before?.updated_at);
    });
  });

  test("the outbox row is keyed under the most recently written session-lane cursor", async () => {
    await withStore(async (db) => {
      await db.importer.importSession(parsed(FIRST_CREATED_AT), "claude");
      await drain(db);
      await db.run(
        `INSERT INTO sync_state (source_key, observed_ids_at_top_updated_at, data_revision, updated_at)
         VALUES ($1, '[]', $2, $3), ($4, '[]', $2, $5)`,
        buildAgentSessionSyncSourceKey("target-retired"),
        effectiveDataRevision(),
        "2000-01-01T00:00:00.000Z",
        buildAgentComponentSyncSourceKey(COMPUTE_TARGET_ID),
        "2999-01-01T00:00:00.000Z"
      );

      await db.importer.importSession(parsed(EARLIER_CREATED_AT), "claude");

      assert.deepEqual(await readOutboxKeys(db), [SOURCE_KEY]);
    });
  });

  test("a store whose session lane never synced writes no outbox row", async () => {
    await withStore(async (db) => {
      await db.importer.importSession(parsed(FIRST_CREATED_AT), "claude");
      await db.importer.importSession(parsed(EARLIER_CREATED_AT), "claude");

      assert.equal((await readRow(db))?.created_at, EARLIER_CREATED_AT);
      assert.deepEqual(await readOutboxKeys(db), []);
    });
  });
});
