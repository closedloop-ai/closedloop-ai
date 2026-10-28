import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { AgentComponentInvocationSyncRejectReason } from "@repo/api/src/types/agent-component-invocation";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID,
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { INVOCATION_SYNC_CANONICALIZATION_SESSION_ID } from "../src/main/database/invocation-sync-canonicalization-repair.js";
import {
  INVOCATION_ORPHAN_REPAIR_SESSION_LIMIT,
  purgeOrphanedInvocationSyncState,
} from "../src/main/database/invocation-sync-orphan-maintenance.js";
import { loadReadyInvocationSyncOutboxParts } from "../src/main/database/invocation-sync-outbox-parts.js";
import { loadPendingInvocationTemplates } from "../src/main/database/invocation-sync-pending-templates.js";
import { INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID } from "../src/main/database/invocation-sync-validation-redrive.js";
import { sweepExpiredSessions } from "../src/main/database/session-maintenance.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  type Db,
  makeInvocationSyncDir,
  NOW,
  openDb,
  SKILL_CONTENT_V1,
  skillSession,
} from "./helpers/invocation-sync-fixtures.js";

const target = buildAgentComponentInvocationSyncSourceKey("orphan-maintenance");
const otherTarget = buildAgentComponentInvocationSyncSourceKey("other-target");

describe("ISS-12165 invocation orphan maintenance", () => {
  it("purges pending/dead-lettered derived state across targets, preserves valid parents and lane sentinels", async () => {
    await withDb(async (db) => {
      await importAndPromote(db, ["zombie", "live"]);
      await db.syncSource.prepareInvocationSyncTarget?.(
        otherTarget,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10
      );
      await db.run("DELETE FROM sessions WHERE id = ?", "zombie");
      await db.run(
        "UPDATE agent_component_invocation_sync_outbox SET status = ?, last_error = ? WHERE source_key = ? AND external_session_id = ?",
        OutboxStatus.DeadLettered,
        "session_missing_horizon_exhausted",
        otherTarget,
        "zombie"
      );
      await seedSentinels(db);
      await db.run(
        "UPDATE agent_component_invocation_sync_outbox SET last_error = ?, attempt_count = 4 WHERE source_key = ? AND external_session_id = ?",
        AgentComponentInvocationSyncRejectReason.SessionMissing,
        target,
        "live"
      );
      const beforeLive = await syncState(db, "live");
      const beforeSentinels =
        await db.prisma.client.agentComponentInvocationSyncCursor.findMany({
          where: { externalSessionId: { startsWith: "__invocation_sync_" } },
          orderBy: [{ sourceKey: "asc" }, { externalSessionId: "asc" }],
        });
      assert.equal(await purgeOrphanedInvocationSyncState(db.prisma), 1);
      assert.deepEqual(await syncState(db, "zombie"), {
        parts: [],
        cursors: [],
      });
      assert.deepEqual(await syncState(db, "live"), beforeLive);
      assert.deepEqual(
        await db.prisma.client.agentComponentInvocationSyncCursor.findMany({
          where: { externalSessionId: { startsWith: "__invocation_sync_" } },
          orderBy: [{ sourceKey: "asc" }, { externalSessionId: "asc" }],
        }),
        beforeSentinels
      );
      assert.equal(await purgeOrphanedInvocationSyncState(db.prisma), 0);
    });
  });

  it("excludes orphan templates and ready parts even before the repair runs", async () => {
    await withDb(async (db) => {
      await importAndPromote(db, ["zombie", "live"]);
      await db.run("DELETE FROM sessions WHERE id = ?", "zombie");
      const templates = await loadPendingInvocationTemplates(
        db.prisma.client,
        otherTarget,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        "",
        10
      );
      assert.deepEqual(templates, [{ external_session_id: "live" }]);
      const ready = await loadReadyInvocationSyncOutboxParts(
        db.prisma,
        target,
        NOW,
        10
      );
      assert.equal(ready.length, 1);
      assert.equal(ready[0]?.part.externalSessionId, "live");
      assert.ok((await syncState(db, "zombie")).parts.length > 0);
    });
  });

  it("production prepare cleans zombies before promotion, without needing a revision change", async () => {
    await withDb(async (db) => {
      await importAndPromote(db, ["zombie", "live"]);
      await db.run("DELETE FROM sessions WHERE id = ?", "zombie");
      await db.syncSource.prepareInvocationSyncTarget?.(
        target,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10
      );
      assert.deepEqual(await syncState(db, "zombie"), {
        parts: [],
        cursors: [],
      });
      assert.ok((await syncState(db, "live")).parts.length > 0);
    });
  });

  it("zombies cannot consume the FIFO or never-attempted reservation before cleanup", async () => {
    await withDb(async (db) => {
      const zombies = [
        "zombie-retry-a",
        "zombie-retry-b",
        "zombie-new-a",
        "zombie-new-b",
      ];
      await importAndPromote(db, [...zombies, "live-retry", "live-new"]);
      for (const id of zombies) {
        await db.run("DELETE FROM sessions WHERE id = ?", id);
        await db.run(
          "UPDATE agent_component_invocation_sync_outbox SET created_at = ? WHERE external_session_id = ?",
          "2025-01-01T00:00:00.000Z",
          id
        );
      }
      for (const id of ["zombie-retry-a", "zombie-retry-b", "live-retry"]) {
        await db.run(
          "UPDATE agent_component_invocation_sync_outbox SET attempt_count = 4 WHERE external_session_id = ?",
          id
        );
      }
      const ready = await loadReadyInvocationSyncOutboxParts(
        db.prisma,
        target,
        NOW,
        2
      );
      assert.deepEqual(
        ready.map((entry) => entry.part.externalSessionId).sort(),
        ["live-new", "live-retry"]
      );
      assert.ok((await syncState(db, "zombie-new-a")).parts.length > 0);
    });
  });

  it("repairs a cursor-only backlog over bounded passes, including after reopening the store", async () => {
    const dir = await makeInvocationSyncDir("invocation-orphan-restart-");
    let db = await openDb(dir);
    try {
      await db.prisma.write((client) =>
        client.agentComponentInvocationSyncCursor.createMany({
          data: Array.from(
            { length: INVOCATION_ORPHAN_REPAIR_SESSION_LIMIT + 1 },
            (_, index) => ({
              sourceKey: target,
              externalSessionId: `orphan-${String(index).padStart(3, "0")}`,
              externalGenerationId: "generation",
              sourceSequence: 1,
              updatedAt: NOW,
            })
          ),
        })
      );
      assert.equal(
        await purgeOrphanedInvocationSyncState(db.prisma),
        INVOCATION_ORPHAN_REPAIR_SESSION_LIMIT
      );
      await db.close();
      db = await openDb(dir);
      assert.equal(await purgeOrphanedInvocationSyncState(db.prisma), 1);
      assert.equal(await purgeOrphanedInvocationSyncState(db.prisma), 0);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("explicit deletion removes derived queues atomically and refuses active parents", async () => {
    await withDb(async (db) => {
      await importAndPromote(db, ["removed", "active"]);
      await db.run(
        "UPDATE sessions SET status = ? WHERE id = ?",
        SESSION_STATUS.ACTIVE,
        "active"
      );
      const activeBefore = await syncState(db, "active");
      assert.equal(await db.deleteSessionRow("active"), false);
      assert.deepEqual(await syncState(db, "active"), activeBefore);
      await db.run(
        "UPDATE sessions SET status = ? WHERE id = ?",
        SESSION_STATUS.INACTIVE,
        "removed"
      );
      await db.run(
        "CREATE TRIGGER refuse_parent_delete BEFORE DELETE ON sessions WHEN OLD.id = 'removed' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END"
      );
      const removedBefore = await syncState(db, "removed");
      await assert.rejects(db.deleteSessionRow("removed"));
      assert.deepEqual(await syncState(db, "removed"), removedBefore);
      await db.run("DROP TRIGGER refuse_parent_delete");
      assert.equal(await db.deleteSessionRow("removed"), true);
      assert.deepEqual(await syncState(db, "removed"), {
        parts: [],
        cursors: [],
      });
    });
  });

  it("retention purges invocation state in the parent transaction while preserving metadata-owed parents", async () => {
    await withDb(async (db) => {
      await importAndPromote(db, ["expired", "metadata-owed"]);
      for (const id of ["expired", "metadata-owed"]) {
        await db.run(
          "UPDATE sessions SET status = ?, last_activity_at = ? WHERE id = ?",
          SESSION_STATUS.INACTIVE,
          "2025-01-01T00:00:00.000Z",
          id
        );
      }
      await db.run(
        "INSERT INTO agent_session_sync_outbox (source_key, external_session_id, status, sync_class, attempt_count, created_at, updated_at) VALUES (?, ?, ?, 'backfill', 0, ?, ?)",
        target,
        "metadata-owed",
        OutboxStatus.Pending,
        NOW,
        NOW
      );
      const owedBefore = await syncState(db, "metadata-owed");
      assert.deepEqual(await sweepExpiredSessions(db.prisma, NOW), {
        purged: 1,
        deferredUndelivered: 1,
      });
      assert.deepEqual(await syncState(db, "expired"), {
        parts: [],
        cursors: [],
      });
      assert.deepEqual(await syncState(db, "metadata-owed"), owedBefore);
    });
  });
});

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await makeInvocationSyncDir("invocation-orphan-");
  const db = await openDb(dir);
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function importAndPromote(db: Db, ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.importer.importSession(
      skillSession(id, [SKILL_CONTENT_V1]),
      "claude"
    );
  }
  const prepare = db.syncSource.prepareInvocationSyncTarget;
  if (!prepare) {
    throw new Error("the test database must implement invocation promotion");
  }
  await prepare(target, AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY, 10);
}

async function syncState(db: Db, externalSessionId: string) {
  return {
    parts: await db.prisma.client.agentComponentInvocationSyncOutbox.findMany({
      where: { externalSessionId },
      orderBy: [{ sourceKey: "asc" }, { partIndex: "asc" }],
    }),
    cursors: await db.prisma.client.agentComponentInvocationSyncCursor.findMany(
      {
        where: { externalSessionId },
        orderBy: { sourceKey: "asc" },
      }
    ),
  };
}

async function seedSentinels(db: Db): Promise<void> {
  for (const externalSessionId of [
    AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
    AGENT_COMPONENT_INVOCATION_SYNC_BACKFILL_SESSION_ID,
    AGENT_COMPONENT_INVOCATION_SYNC_INTEGRITY_SESSION_ID,
    INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
    INVOCATION_SYNC_VALIDATION_REDRIVE_SESSION_ID,
  ]) {
    await db.prisma.write((client) =>
      client.agentComponentInvocationSyncCursor.upsert({
        where: {
          sourceKey_externalSessionId: {
            sourceKey: otherTarget,
            externalSessionId,
          },
        },
        create: {
          sourceKey: otherTarget,
          externalSessionId,
          externalGenerationId: "sentinel",
          sourceSequence: 77,
          updatedAt: NOW,
        },
        update: { sourceSequence: 77 },
      })
    );
  }
}
