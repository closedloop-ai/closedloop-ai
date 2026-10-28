/**
 * ISS-7246: contract tests for the `withheld` outbox lifecycle, exercised
 * against a real libSQL database through `openSqliteAgentDatabase` +
 * `createSqliteSessionSyncSource` (`db.syncSource`), like its sibling
 * `agent-session-sync-outbox-store.test.ts`.
 *
 * `withheld` is what an idle ("phantom") session's row becomes instead of
 * staying `pending`: nothing substantive to send, so nothing is owed and the
 * idle-tick reconciliation must not re-arm it. The two guards this file pins are
 * the ones that make that safe in both directions — a withhold can never
 * downgrade a `dead_lettered` row, and a re-pend can never resurrect one.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";

const SOURCE_KEY = "agent_sessions:target-withheld";

async function withDb(
  body: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7246-withheld-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-19T00:00:00.000Z",
    });
    try {
      await body(db);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readRow(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  externalSessionId: string
) {
  return db.prisma.client.agentSessionSyncOutbox.findUnique({
    where: {
      sourceKey_externalSessionId: {
        sourceKey: SOURCE_KEY,
        externalSessionId,
      },
    },
  });
}

test("ISS-7246: a withheld row leaves the pending set but keeps its outbox row", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.markOutboxWithheld,
      "sqlite source exposes markOutboxWithheld"
    );

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "phantom", syncClass: "backfill" },
      { externalSessionId: "real", syncClass: "backfill" },
    ]);
    await src.markOutboxWithheld?.(SOURCE_KEY, ["phantom"]);

    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      ["real"],
      "the idle-tick reconciliation can no longer see the withheld id"
    );
    const row = await readRow(db, "phantom");
    assert.equal(row?.status, OutboxStatus.Withheld);
    // The row must SURVIVE: the retention sweep's undelivered probe asks only
    // whether a row exists, in any status, so deleting it would newly expose the
    // session to a purge.
    assert.ok(row, "the row is kept, not deleted");
    assert.equal(
      row?.attemptCount,
      0,
      "a withheld row carries no burned budget"
    );
    assert.equal(row?.nextAttemptAt, null);
    assert.equal(row?.lastError, null);
  });
});

test("ISS-7246: withholding never downgrades a dead-lettered row, and is a no-op on an absent one", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "abandoned", syncClass: "backfill" },
    ]);
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "abandoned",
      "validation_failed",
      3
    );

    await src.markOutboxWithheld?.(SOURCE_KEY, ["abandoned", "never-existed"]);

    const row = await readRow(db, "abandoned");
    assert.equal(
      row?.status,
      OutboxStatus.DeadLettered,
      "a dead-letter stays a dead-letter — withholding it would drop it out of the recovery lifecycle"
    );
    assert.equal(row?.attemptCount, 3, "its burned budget is untouched");
    assert.equal(
      await readRow(db, "never-existed"),
      null,
      "withholding an absent id creates no phantom row"
    );
  });
});

test("ISS-7246: a re-enqueue alone does NOT un-withhold a row — the explicit re-pend does", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.rePendWithheldOutbox,
      "sqlite source exposes rePendWithheldOutbox"
    );

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "phantom", syncClass: "backfill" },
    ]);
    await src.markOutboxWithheld?.(SOURCE_KEY, ["phantom"]);

    // The enqueue upsert deliberately never touches `status` (so it cannot
    // resurrect a dead-letter). That is exactly why the withhold needs its own
    // re-pend: without one, a session that later becomes substantive would be
    // stranded withheld forever.
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "phantom", syncClass: "incremental" },
    ]);
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      [],
      "a bare re-enqueue leaves the row withheld"
    );

    await src.rePendWithheldOutbox?.(SOURCE_KEY, ["phantom"]);
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      ["phantom"],
      "the explicit re-pend returns it to the pending set"
    );
    const row = await readRow(db, "phantom");
    assert.equal(row?.status, OutboxStatus.Pending);
    assert.equal(
      row?.attemptCount,
      0,
      "the retry budget restarts from scratch"
    );
    assert.equal(row?.nextAttemptAt, null);
  });
});

test("ISS-7246: the re-pend only flips withheld rows — never a dead-letter, never an in-flight retry", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "abandoned", syncClass: "backfill" },
      { externalSessionId: "in-flight", syncClass: "backfill" },
    ]);
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "abandoned",
      "validation_failed",
      3
    );
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "in-flight",
      2,
      "2026-08-19T00:10:00.000Z",
      "ingestion_failed",
      null
    );

    await src.rePendWithheldOutbox?.(SOURCE_KEY, ["abandoned", "in-flight"]);

    const abandoned = await readRow(db, "abandoned");
    assert.equal(
      abandoned?.status,
      OutboxStatus.DeadLettered,
      "the re-pend cannot resurrect a dead-letter"
    );
    const inFlight = await readRow(db, "in-flight");
    assert.equal(
      inFlight?.attemptCount,
      2,
      "an already-pending row keeps its in-flight retry budget"
    );
    assert.equal(
      inFlight?.nextAttemptAt,
      "2026-08-19T00:10:00.000Z",
      "and its scheduled deadline"
    );
  });
});
