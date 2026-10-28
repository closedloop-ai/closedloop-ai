/**
 * @file session-created-at-rebuild-resync.test.ts
 * @description ISS-12251: a DATA_REVISION rebuild that fills or lowers only
 * `sessions.created_at` leaves `updated_at` alone, writes the row's outbox entry
 * in the row's own transaction, and still reports the row as owing a sync, so
 * it is re-sent carrying `createdAt` — also when the pass is interrupted before
 * its after-pass hand-off. Drives the real SQLite store, the real rebuild, the
 * real rebuild-to-outbox hand-off and the real sync lane with a fake transport.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import type { DataRevisionRebuildSummary } from "../src/main/collectors/engine/data-revision-rebuild-summary.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { runDataRevisionSyncEnqueueAndFeed } from "../src/main/dashboard/data-revision-sync-enqueue.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { drainSentSessions } from "./created-at-sync-drain.js";
import {
  fakeCollector,
  makePopulatedSession,
} from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openTestDb>>;
type StoredRow = { created_at: string | null; updated_at: string };

const COMPUTE_TARGET_ID = "target-iss12251-rebuild-resync";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET_ID);
const STALE_REVISION = effectiveDataRevision() - 1;
const IMPORT_ENDED_AT = "2026-06-07T10:05:00.000Z";
/** The watermark the earlier build already advanced past every row. */
const STALE_WATERMARK = "2026-06-07T11:00:00.000Z";
const REBUILD_CLOCK = "2026-06-07T12:00:00.000Z";
const FILE_CREATED_AT = "2026-06-01T09:00:00.000Z";
const LATER_CREATED_AT = "2026-06-05T09:00:00.000Z";
const FILLED = "ses-created-at-filled";
const LOWERED = "ses-created-at-lowered";
const UNCHANGED = "ses-created-at-unchanged";

function parsed(sessionId: string): NormalizedSession {
  return makePopulatedSession({
    sessionId,
    endedAt: IMPORT_ENDED_AT,
    fileCreatedAt: Date.parse(FILE_CREATED_AT),
  });
}

/**
 * Import each session, then make it look like a row an earlier build left: a
 * stale revision, the watermark it was last synced at, and the given
 * `created_at`. A session-lane cursor at the current revision is already past
 * every row.
 */
async function withPriorBuildRows(
  storedCreatedAt: Record<string, string | null>,
  run: (db: Db) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss12251-rebuild-"));
  const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
  try {
    const ids = Object.keys(storedCreatedAt).toSorted();
    for (const id of ids) {
      await db.importer.importSession(parsed(id), "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2, created_at = $3 WHERE id = $4",
        STALE_REVISION,
        STALE_WATERMARK,
        storedCreatedAt[id],
        id
      );
    }
    await db.syncSource.advanceSyncState?.(SOURCE_KEY, {
      observedTopUpdatedAt: STALE_WATERMARK,
      observedIdsAtTopUpdatedAt: ids,
      deadLetteredIds: [],
    });
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The rebuild, then the post-boot hand-off of its changed set to the outbox. */
async function rebuildAndEnqueue(
  db: Db,
  ids: readonly string[]
): Promise<DataRevisionRebuildSummary> {
  const collector = fakeCollector("claude", {
    sources: ids.map((id) => `/fake/${id}.jsonl`),
    parse: (source) =>
      Promise.resolve([parsed(path.basename(source, ".jsonl"))]),
    sessionIdForSource: (source) => path.basename(source, ".jsonl"),
  });
  const summary = await runDataRevisionRebuild({ collectors: [collector], db });
  await runDataRevisionSyncEnqueueAndFeed({
    changedSessionIds: summary.changedSessionIds,
    capturedComputeTargetId: COMPUTE_TARGET_ID,
    enqueueOutboxEntries: db.syncSource.enqueueOutboxEntries,
    resolveLiveComputeTargetId: () => COMPUTE_TARGET_ID,
    injectSyncBackfillIds: undefined,
    shouldContinue: () => true,
    log: () => {
      // discarded: no case asserts on hand-off log output
    },
  });
  return summary;
}

function drain(db: Db): Promise<SyncedAgentSession[]> {
  return drainSentSessions(db.syncSource, COMPUTE_TARGET_ID);
}

function createdAtById(
  sent: readonly SyncedAgentSession[]
): Record<string, string | undefined> {
  return Object.fromEntries(
    sent.map((session) => [session.externalSessionId, session.createdAt])
  );
}

async function readRow(db: Db, id: string): Promise<StoredRow | undefined> {
  const rows = await db.prisma.client.$queryRawUnsafe<StoredRow[]>(
    "SELECT created_at, updated_at FROM sessions WHERE id = $1",
    id
  );
  return rows[0];
}

describe("ISS-12251: a rebuild's created_at-only change reaches the outbox", () => {
  test("a filled or lowered created_at enqueues the row once and the upload carries it, with updated_at unmoved", async () => {
    await withPriorBuildRows(
      { [FILLED]: null, [LOWERED]: LATER_CREATED_AT },
      async (db) => {
        assert.deepEqual(
          await drain(db),
          [],
          "nothing is owed before the rebuild"
        );

        const summary = await rebuildAndEnqueue(db, [FILLED, LOWERED]);

        assert.deepEqual(summary.changedSessionIds.toSorted(), [
          FILLED,
          LOWERED,
        ]);
        assert.deepEqual(
          (await db.syncSource.loadPendingOutboxIds?.(SOURCE_KEY))?.toSorted(),
          [FILLED, LOWERED]
        );
        for (const id of [FILLED, LOWERED]) {
          assert.deepEqual(await readRow(db, id), {
            created_at: FILE_CREATED_AT,
            updated_at: STALE_WATERMARK,
          });
        }

        const sent = await drain(db);

        assert.equal(sent.length, 2);
        assert.deepEqual(createdAtById(sent), {
          [FILLED]: FILE_CREATED_AT,
          [LOWERED]: FILE_CREATED_AT,
        });
        assert.deepEqual(await drain(db), [], "the enqueue re-sends once");
      }
    );
  });

  test("a rebuild that moves neither created_at nor content enqueues nothing", async () => {
    await withPriorBuildRows({ [UNCHANGED]: FILE_CREATED_AT }, async (db) => {
      const summary = await rebuildAndEnqueue(db, [UNCHANGED]);

      assert.equal(summary.rebuilt, 1, "the row was re-derived");
      assert.deepEqual(summary.changedSessionIds, []);
      assert.deepEqual(
        await db.syncSource.loadPendingOutboxIds?.(SOURCE_KEY),
        []
      );
      assert.deepEqual(await readRow(db, UNCHANGED), {
        created_at: FILE_CREATED_AT,
        updated_at: STALE_WATERMARK,
      });
      assert.deepEqual(await drain(db), []);
    });
  });

  test("the row's own transaction leaves its outbox row, so a pass interrupted before the hand-off still delivers createdAt", async () => {
    await withPriorBuildRows({ [FILLED]: null }, async (db) => {
      const result = await db.rebuildSessionFromParse(parsed(FILLED), "claude");

      assert.deepEqual(result, {
        rebuilt: true,
        activeRace: false,
        needsResync: true,
      });
      assert.deepEqual(
        await db.syncSource.loadPendingOutboxIds?.(SOURCE_KEY),
        [FILLED],
        "committed with the row, before any after-pass enqueue"
      );
      assert.deepEqual(await readRow(db, FILLED), {
        created_at: FILE_CREATED_AT,
        updated_at: STALE_WATERMARK,
      });

      assert.deepEqual(createdAtById(await drain(db)), {
        [FILLED]: FILE_CREATED_AT,
      });
      assert.deepEqual(await drain(db), []);
    });
  });
});
