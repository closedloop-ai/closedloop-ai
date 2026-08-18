import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AUTONOMY_FORMULA_VERSION } from "@repo/lib/session-trace/autonomy";
import {
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { autonomyFormulaCursorIsStale } from "../src/main/database/sync-cursor-state.js";

// FEA-3781 (PLN-1545 T9): the autonomy score is computed at SYNC-PAYLOAD BUILD
// time and is not stored locally, so replacing the formula moves no row and
// never touches `sessions.updated_at`. The durable keyset cursor would walk
// straight past the whole historical corpus and the cloud would keep serving the
// old score forever — the fix would look like it did nothing.
//
// The mechanism is a formula-version stamp on the cursor: a cursor written under
// a superseded formula loads with its watermark cleared, which puts the next
// sync tick on the first-run path (a full re-walk that durably seeds the outbox
// and re-persists a stamped cursor). These tests pin that it fires exactly once,
// only for the session lane, and not at all when the stamp is current.

const CURRENT_STATE = {
  observedTopUpdatedAt: "2026-06-08T12:05:00.000Z",
  observedIdsAtTopUpdatedAt: ["a", "b"],
  deadLetteredIds: ["dead-1"],
};

async function withDatabase(
  run: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "autonomy-backfill-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a cursor persisted under the current formula resumes normally", async () => {
  await withDatabase(async (db) => {
    const sourceKey = buildAgentSessionSyncSourceKey("org:user:target");
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);

    // `advanceSyncState` stamps the current formula version, so the very next
    // load must NOT reset — otherwise the re-walk would repeat on every boot.
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey),
      CURRENT_STATE
    );
  });
});

test("a cursor stamped under a superseded formula loads with its watermark cleared", async () => {
  await withDatabase(async (db) => {
    const sourceKey = buildAgentSessionSyncSourceKey("org:user:target");
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);
    // Simulate a client that last synced under the previous formula. A NULL
    // column (a cursor written before migration 0040) is the real-world shape;
    // an explicit older number covers a future bump.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sync_state SET autonomy_formula_version = NULL WHERE source_key = ?",
        sourceKey
      )
    );

    const loaded = await db.syncSource.loadSyncState?.(sourceKey);

    // A null watermark is what puts the service on the full-backfill path; the
    // row itself is NOT deleted, so nothing else about the lane is disturbed.
    assert.equal(loaded?.observedTopUpdatedAt, null);
    assert.deepEqual(loaded?.observedIdsAtTopUpdatedAt, []);
    // Dead letters are re-pended on disk by the reset (next test), so none are
    // still set aside by the time the cursor is handed back.
    assert.deepEqual(loaded?.deadLetteredIds, []);
  });
});

test("the formula reset durably re-pends dead-lettered rows so a crash cannot strand them", async () => {
  await withDatabase(async (db) => {
    const sourceKey = buildAgentSessionSyncSourceKey("org:user:target");
    await db.syncSource.enqueueOutboxEntries?.(sourceKey, [
      { externalSessionId: "stranded", syncClass: "backfill" },
      { externalSessionId: "healthy", syncClass: "backfill" },
    ]);
    await db.syncSource.markOutboxDeadLettered?.(
      sourceKey,
      "stranded",
      "oversized",
      3
    );
    assert.deepEqual(await db.syncSource.loadPendingOutboxIds?.(sourceKey), [
      "healthy",
    ]);
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sync_state SET autonomy_formula_version = NULL WHERE source_key = ?",
        sourceKey
      )
    );

    await db.syncSource.loadSyncState?.(sourceKey);

    // Before this, `stranded` was reachable ONLY through the in-memory backfill
    // walk: its outbox row stayed dead_lettered, the cleared watermark meant the
    // service never seeded it as a cursor dead-letter, and a crash after the new
    // cursor was stamped left it invisible to every recovery path — its cloud
    // autonomy pinned to the old formula forever.
    assert.deepEqual(
      (await db.syncSource.loadPendingOutboxIds?.(sourceKey))?.sort(),
      ["healthy", "stranded"]
    );
    // The retry budget restarts too, mirroring reEnqueueRecoveredDeadLetter.
    const retryState =
      await db.syncSource.loadPendingOutboxRetryState?.(sourceKey);
    assert.equal(
      retryState?.some((entry) => entry.id === "stranded"),
      false
    );

    // Simulate the crash: the re-walk stamped a fresh cursor but never drained.
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);
    // Next boot no longer re-walks, and the row is still recoverable.
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey),
      CURRENT_STATE
    );
    assert.equal(
      (await db.syncSource.loadPendingOutboxIds?.(sourceKey))?.includes(
        "stranded"
      ),
      true
    );
  });
});

test("the re-walk fires once: the next persist re-stamps and the cursor resumes", async () => {
  await withDatabase(async (db) => {
    const sourceKey = buildAgentSessionSyncSourceKey("org:user:target");
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sync_state SET autonomy_formula_version = NULL WHERE source_key = ?",
        sourceKey
      )
    );
    assert.equal(
      (await db.syncSource.loadSyncState?.(sourceKey))?.observedTopUpdatedAt,
      null
    );

    // The re-walk completes and persists a fresh cursor, which stamps the
    // current version. A restart after that must resume, not re-walk again.
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);

    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey),
      CURRENT_STATE
    );
  });
});

test("a stale stamp on a non-session lane does NOT reset that lane's cursor", async () => {
  await withDatabase(async (db) => {
    // `sync_state` is shared by three lanes under different source-kind
    // prefixes. Only the session lane carries an autonomy score, so resetting
    // the component-inventory lane would re-upload unrelated data for nothing.
    const componentKey = buildAgentComponentSyncSourceKey("org:user:target");
    await db.syncSource.advanceSyncState?.(componentKey, CURRENT_STATE);
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sync_state SET autonomy_formula_version = NULL WHERE source_key = ?",
        componentKey
      )
    );

    assert.deepEqual(
      await db.syncSource.loadSyncState?.(componentKey),
      CURRENT_STATE
    );
  });
});

test("autonomyFormulaCursorIsStale discriminates by lane and version", () => {
  const sessionKey = buildAgentSessionSyncSourceKey("org:user:target");
  const componentKey = buildAgentComponentSyncSourceKey("org:user:target");

  assert.equal(autonomyFormulaCursorIsStale(sessionKey, null), true);
  assert.equal(
    autonomyFormulaCursorIsStale(sessionKey, AUTONOMY_FORMULA_VERSION - 1),
    true
  );
  assert.equal(
    autonomyFormulaCursorIsStale(sessionKey, AUTONOMY_FORMULA_VERSION),
    false
  );
  assert.equal(autonomyFormulaCursorIsStale(componentKey, null), false);
  // A session-lane prefix must match on the full `kind:` segment, not merely as
  // a substring of some other lane's key.
  assert.equal(
    autonomyFormulaCursorIsStale("agent_sessions_other:target", null),
    false
  );
});
