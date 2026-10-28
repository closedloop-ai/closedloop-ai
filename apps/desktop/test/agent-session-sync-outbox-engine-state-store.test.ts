/**
 * @file agent-session-sync-outbox-engine-state-store.test.ts
 * @description ISS-8617 store coverage for the session outbox engine columns:
 * volatile attempts, row-attributable permanent attempts, and the recovery
 * ladder must stay distinct across retry, dead-letter, and recovery writes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  sqliteRependDeadLetteredForFormulaRewalk,
  sqliteRependSessionDeadLetters,
} from "../src/main/database/sync-outbox-store.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";

const SOURCE_KEY = "agent_sessions:target-outbox-engine-state";

async function withDb(
  body: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8617-outbox-engine-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-18T00:00:00.000Z",
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

test("ISS-8617: session engine state stores permanent attempts and recovery ladder distinctly", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      {
        externalSessionId: "engine-state",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);

    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "engine-state",
      1,
      "2026-07-18T00:05:00.000Z",
      SyncReason.IngestionFailed,
      null,
      4
    );

    assert.deepEqual(
      await src.loadPendingSessionOutboxEngineState?.(SOURCE_KEY),
      [
        {
          id: "engine-state",
          attemptCount: 1,
          permanentAttemptCount: 4,
          deadLetterRecoveryCount: 0,
          ackOmittedCycleCount: 0,
          nextAttemptAt: "2026-07-18T00:05:00.000Z",
          lastError: SyncReason.IngestionFailed,
          laneStalledSince: null,
        },
      ]
    );

    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "engine-state",
      2,
      "2026-07-18T00:10:00.000Z",
      SyncReason.RateLimited,
      "2026-07-18T00:06:00.000Z",
      null
    );
    assert.deepEqual(
      await src.loadPendingSessionOutboxEngineState?.(SOURCE_KEY),
      [
        {
          id: "engine-state",
          attemptCount: 2,
          permanentAttemptCount: 4,
          deadLetterRecoveryCount: 0,
          ackOmittedCycleCount: 0,
          nextAttemptAt: "2026-07-18T00:10:00.000Z",
          lastError: SyncReason.RateLimited,
          laneStalledSince: "2026-07-18T00:06:00.000Z",
        },
      ],
      "an environmental retry preserves the row-attributable durable budget"
    );

    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "engine-state",
      SyncReason.IngestionFailed,
      5,
      5,
      2
    );
    let row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "engine-state",
        },
      },
    });
    assert.equal(row?.status, OutboxStatus.DeadLettered);
    assert.equal(row?.attemptCount, 5);
    assert.equal(row?.permanentAttemptCount, 5);
    assert.equal(row?.deadLetterRecoveryCount, 2);
    assert.deepEqual(
      await src.loadPendingSessionOutboxEngineState?.(SOURCE_KEY),
      [
        {
          id: "engine-state",
          status: OutboxStatus.DeadLettered,
          attemptCount: 0,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 2,
          ackOmittedCycleCount: 0,
          nextAttemptAt: null,
          lastError: null,
          laneStalledSince: null,
        },
      ],
      "dead-lettered rows restore only the durable recovery ladder"
    );

    assert.equal(
      await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "engine-state"),
      true
    );
    row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "engine-state",
        },
      },
    });
    assert.equal(row?.status, OutboxStatus.Pending);
    assert.equal(
      row?.attemptCount,
      0,
      "volatile retry budget resets on recovery"
    );
    assert.equal(
      row?.permanentAttemptCount,
      0,
      "permanent retry budget resets on recovery"
    );
    assert.equal(row?.deadLetterRecoveryCount, 2);

    assert.deepEqual(
      await src.loadPendingSessionOutboxEngineState?.(SOURCE_KEY),
      [
        {
          id: "engine-state",
          attemptCount: 0,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 2,
          ackOmittedCycleCount: 0,
          nextAttemptAt: null,
          lastError: null,
          laneStalledSince: null,
        },
      ]
    );
  });
});

test("ISS-8617: bulk session dead-letter redrives preserve the recovery ladder", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      {
        externalSessionId: "selected-redrive",
        syncClass: AgentSessionSyncMode.Backfill,
      },
      {
        externalSessionId: "formula-redrive",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "selected-redrive",
      SyncReason.AckOmitted,
      5,
      5,
      3
    );
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "formula-redrive",
      SyncReason.IngestionFailed,
      5,
      5,
      4
    );

    await sqliteRependSessionDeadLetters(db.prisma, SOURCE_KEY, [
      "selected-redrive",
    ]);
    await sqliteRependDeadLetteredForFormulaRewalk(db.prisma, SOURCE_KEY);

    const rows = await db.prisma.client.agentSessionSyncOutbox.findMany({
      where: { sourceKey: SOURCE_KEY },
      orderBy: { externalSessionId: "asc" },
    });
    assert.deepEqual(
      rows.map((row) => ({
        id: row.externalSessionId,
        status: row.status,
        attemptCount: row.attemptCount,
        permanentAttemptCount: row.permanentAttemptCount,
        deadLetterRecoveryCount: row.deadLetterRecoveryCount,
      })),
      [
        {
          id: "formula-redrive",
          status: OutboxStatus.Pending,
          attemptCount: 0,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 4,
        },
        {
          id: "selected-redrive",
          status: OutboxStatus.Pending,
          attemptCount: 0,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 3,
        },
      ]
    );
  });
});
