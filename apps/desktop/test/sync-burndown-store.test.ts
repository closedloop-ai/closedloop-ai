/**
 * @file sync-burndown-store.test.ts
 * @description ISS-5387 — the burn-down's aggregate reads must reconcile with
 * the stores they claim to measure, against REAL SQLite rather than a fake.
 *
 * The headline case is the scoping trap. `agent_component_invocation_sync_outbox`
 * holds rows under two different kinds of `source_key`: the unscoped TEMPLATE key
 * the lane clones from, and the target-scoped DELIVERY key it actually drains. On
 * one live install 3,490 of 3,508 `pending` rows sat under the template key. A
 * burn-down that counts by status reports a multi-thousand-item cloud backlog
 * that does not exist.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import type {
  DesktopPrisma,
  DesktopPrismaReadClient,
  DesktopPrismaReader,
} from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSyncBurndownReaders } from "../src/main/database/sync-burndown-store.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import {
  burndownQuery,
  COMPONENT_SOURCE_KEY,
  type DbRun,
  DELIVERY_SOURCE_KEY,
  SAMPLE_NOW,
  SESSION_SOURCE_KEY,
} from "./support/sync-burndown-fixtures.js";

async function seedSessionOutboxRow(
  db: DbRun,
  input: {
    id: string;
    status: string;
    createdAt: string;
    /** ISS-5973: a future deadline makes the row DEFERRED rather than ready. */
    nextAttemptAt?: string | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO agent_session_sync_outbox
       (source_key, external_session_id, status, sync_class, attempt_count,
        next_attempt_at, last_error, pending_since, created_at, updated_at)
     VALUES (?, ?, ?, 'backfill', 0, ?, NULL, ?, ?, ?)`,
    SESSION_SOURCE_KEY,
    input.id,
    input.status,
    input.nextAttemptAt ?? null,
    input.createdAt,
    input.createdAt,
    input.createdAt
  );
}

async function seedInvocationOutboxRow(
  db: DbRun,
  input: {
    sourceKey: string;
    sessionId: string;
    partIndex: number;
    status: string;
    payload: string;
    createdAt: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO agent_component_invocation_sync_outbox
       (source_key, external_session_id, external_generation_id, part_index,
        part_count, part_hash, source_updated_at, data_revision, source_sequence,
        payload, status, attempt_count, next_attempt_at, last_error,
        pending_since, created_at, updated_at)
     VALUES (?, ?, ?, ?, 4, ?, ?, 1, 1, ?, ?, 0, NULL, NULL, ?, ?, ?)`,
    input.sourceKey,
    input.sessionId,
    `${input.sessionId}-gen`,
    input.partIndex,
    `${"a".repeat(63)}${input.partIndex}`,
    input.createdAt,
    input.payload,
    input.status,
    input.createdAt,
    input.createdAt,
    input.createdAt
  );
}

async function seedTranscriptRow(
  db: DbRun,
  input: {
    sessionId: string;
    fileKey: string;
    status: string;
    lastSize: number;
    syncedByteOffset: number;
    updatedAt: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO transcript_sync_state
       (external_session_id, file_key, source_harness, source_path,
        source_path_hash, last_mtime_ms, last_size, synced_byte_offset,
        synced_sha256, stored_etag, synced_compute_target_id, status,
        sync_class, retry_count, missing_source_count, next_attempt_at,
        last_error, created_at, updated_at)
     VALUES (?, ?, 'claude', ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, 'live', 0, 0,
             NULL, NULL, ?, ?)`,
    input.sessionId,
    input.fileKey,
    `/synthetic/${input.sessionId}/${input.fileKey}`,
    `hash-${input.sessionId}-${input.fileKey}`,
    input.lastSize,
    input.syncedByteOffset,
    input.status,
    input.updatedAt,
    input.updatedAt
  );
}

async function seedComponentRow(
  db: DbRun,
  input: { id: string; lastSeenAt: string }
): Promise<void> {
  await db.run(
    `INSERT INTO agent_components
       (id, component_kind, external_id, resolved_state, first_seen_at, last_seen_at)
     VALUES (?, 'skill', ?, 'resolved', ?, ?)`,
    input.id,
    `ext-${input.id}`,
    input.lastSeenAt,
    input.lastSeenAt
  );
}

test("ISS-5387: template-key rows are NOT counted as a delivery backlog", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-scope-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      // The live shape, scaled down: many pending rows under the UNSCOPED
      // template key, a handful under the target-scoped delivery key.
      const templateRowCount = 25;
      for (let index = 0; index < templateRowCount; index += 1) {
        await seedInvocationOutboxRow(db, {
          sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          sessionId: `tmpl-${index}`,
          partIndex: 0,
          status: OutboxStatus.Pending,
          payload: '{"x":1}',
          createdAt: "2026-08-01T00:00:00.000Z",
        });
      }
      const deliveryRowCount = 3;
      for (let index = 0; index < deliveryRowCount; index += 1) {
        await seedInvocationOutboxRow(db, {
          sourceKey: DELIVERY_SOURCE_KEY,
          sessionId: "delivery-session",
          partIndex: index,
          status: OutboxStatus.Pending,
          payload: '{"payload":"0123456789"}',
          createdAt: "2026-08-06T11:00:00.000Z",
        });
      }

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      // Counted independently: only the delivery-key rows are outstanding work.
      assert.equal(
        sample.invocationOutbox.pending,
        deliveryRowCount,
        `the burn-down must report the ${deliveryRowCount} delivery-key rows, not the ${templateRowCount + deliveryRowCount} rows the table holds`
      );
      assert.equal(sample.invocationOutbox.pendingParts, deliveryRowCount);
      assert.equal(
        sample.invocationOutbox.pendingSessions,
        1,
        "three parts of one session are one session, not three"
      );
      assert.equal(
        sample.invocationOutbox.pendingPayloadBytes,
        deliveryRowCount * '{"payload":"0123456789"}'.length,
        "bytes must sum only the delivery-key payloads"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5387: outbox depths, dead-letters, and oldest-pending reconcile with the rows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-reconcile-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      const pendingSessions = [
        { id: "s-old", createdAt: "2026-08-04T00:00:00.000Z" },
        { id: "s-mid", createdAt: "2026-08-05T00:00:00.000Z" },
        { id: "s-new", createdAt: "2026-08-06T00:00:00.000Z" },
      ];
      for (const row of pendingSessions) {
        await seedSessionOutboxRow(db, {
          id: row.id,
          status: OutboxStatus.Pending,
          createdAt: row.createdAt,
        });
      }
      await seedSessionOutboxRow(db, {
        id: "s-abandoned",
        status: OutboxStatus.DeadLettered,
        createdAt: "2026-08-03T00:00:00.000Z",
      });
      // A row under a DIFFERENT source key must never be counted: one account
      // may not inherit another's queue depth.
      await db.run(
        `INSERT INTO agent_session_sync_outbox
           (source_key, external_session_id, status, sync_class, attempt_count,
            next_attempt_at, last_error, created_at, updated_at)
         VALUES ('agent_sessions:other-target', 's-other', ?, 'backfill', 0,
                 NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        OutboxStatus.Pending
      );

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(sample.sessionOutbox.pending, pendingSessions.length);
      assert.equal(sample.sessionOutbox.deadLettered, 1);
      assert.equal(
        sample.sessionOutbox.oldestPendingSinceIso,
        "2026-08-04T00:00:00.000Z",
        "oldest-pending must be the oldest PENDING row, not the older dead-lettered one"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5973: ready-pending counts only rows past their backoff deadline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5973-ready-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      // Never deferred — `next_attempt_at` NULL is ready by definition, and is
      // the exact shape of the 2,928 rows the incident was measured on.
      await seedSessionOutboxRow(db, {
        id: "s-never-deferred",
        status: OutboxStatus.Pending,
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      // Deferred, but the deadline has already elapsed: eligible again.
      await seedSessionOutboxRow(db, {
        id: "s-deadline-elapsed",
        status: OutboxStatus.Pending,
        createdAt: "2026-08-04T00:00:00.000Z",
        nextAttemptAt: "2026-08-06T11:59:59.000Z",
      });
      // Still inside its backoff window — the `protocol_unavailable` shape.
      await seedSessionOutboxRow(db, {
        id: "s-deferred",
        status: OutboxStatus.Pending,
        createdAt: "2026-08-04T00:00:00.000Z",
        nextAttemptAt: "2026-08-06T12:05:00.000Z",
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(
        sample.sessionOutbox.pending,
        3,
        "a deferred row is still owed — depth must not shrink because of a backoff"
      );
      assert.equal(
        sample.sessionOutbox.readyPending,
        2,
        "eligible-now must exclude the row whose deadline has not arrived"
      );

      // Roll the sample's clock past the last deadline: the same rows, all ready.
      const later = await readSyncBurndown(
        burndownQuery("2026-08-06T12:06:00.000Z")
      );
      assert.equal(
        later.sessionOutbox.readyPending,
        3,
        "once every deadline has elapsed the whole backlog is eligible"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5387: transcript bytes-remaining counts only in-flight rows, and settled rows owe nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-transcript-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      await seedTranscriptRow(db, {
        sessionId: "t1",
        fileKey: "a.jsonl",
        status: TranscriptSyncStatus.Queued,
        lastSize: 1000,
        syncedByteOffset: 400,
        updatedAt: "2026-08-06T09:00:00.000Z",
      });
      await seedTranscriptRow(db, {
        sessionId: "t2",
        fileKey: "b.jsonl",
        status: TranscriptSyncStatus.Failed,
        lastSize: 500,
        syncedByteOffset: 100,
        updatedAt: "2026-08-06T08:00:00.000Z",
      });
      // Settled: fully uploaded. It is not outstanding work and owes no bytes.
      await seedTranscriptRow(db, {
        sessionId: "t3",
        fileKey: "c.jsonl",
        status: TranscriptSyncStatus.Idle,
        lastSize: 9_999_999,
        syncedByteOffset: 9_999_999,
        updatedAt: "2026-08-06T07:00:00.000Z",
      });
      // Abandoned: the source file is gone. Counted separately, NEVER as synced.
      await seedTranscriptRow(db, {
        sessionId: "t4",
        fileKey: "d.jsonl",
        status: TranscriptSyncStatus.Dead,
        lastSize: 2000,
        syncedByteOffset: 0,
        updatedAt: "2026-08-06T06:00:00.000Z",
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(sample.transcript.inFlightFiles, 2);
      assert.equal(sample.transcript.deadFiles, 1);
      assert.equal(
        sample.transcript.bytesRemaining,
        1000 - 400 + (500 - 100),
        "only the queued + failed remainders; the settled 9.99MB row owes zero"
      );
      assert.equal(
        sample.transcript.oldestInFlightUpdatedAtIso,
        "2026-08-06T08:00:00.000Z",
        "the oldest IN-FLIGHT row, not the older settled or dead rows"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5387: the durable cursor is reported per source key, and an absent cursor stays absent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-cursor-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      // The value observed on the live install whose cursor froze for three days.
      await db.run(
        `INSERT INTO sync_state
           (source_key, observed_top_updated_at, observed_ids_at_top_updated_at,
            dead_lettered_ids, data_revision, updated_at)
         VALUES (?, '2026-08-03T20:56:53.196Z', '[]', '[]', 65,
                 '2026-08-03T20:57:50.000Z')`,
        COMPONENT_SOURCE_KEY
      );

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      const componentCursor = sample.cursorsBySourceKey[COMPONENT_SOURCE_KEY];
      assert.ok(componentCursor, "the component cursor row is reported");
      assert.equal(
        componentCursor.observedTopUpdatedAt,
        "2026-08-03T20:56:53.196Z"
      );
      assert.equal(componentCursor.updatedAt, "2026-08-03T20:57:50.000Z");
      assert.equal(componentCursor.dataRevision, 65);
      assert.equal(
        sample.cursorsBySourceKey[SESSION_SOURCE_KEY],
        undefined,
        "a lane that never persisted a cursor must report absence, not a fabricated position"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5387: with no compute target the burn-down reports no identity rather than an empty queue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-noidentity-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      await seedSessionOutboxRow(db, {
        id: "s1",
        status: OutboxStatus.Pending,
        createdAt: "2026-08-06T00:00:00.000Z",
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown({
        sessionSourceKey: null,
        invocationSourceKey: null,
        invocationTemplateSourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        componentSourceKey: null,
        transcriptComputeTargetId: null,
        identity: null,
        nowIso: SAMPLE_NOW,
      });

      assert.equal(sample.sessionOutbox.pending, 0);
      assert.equal(sample.invocationOutbox.pending, 0);
      assert.equal(
        sample.componentInventory.rowsRemaining,
        null,
        "with no target the sweep's remainder is UNKNOWN, never a reassuring zero"
      );
      assert.deepEqual(
        Object.keys(sample.cursorsBySourceKey),
        [],
        "no identity means no cursor to report"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5387: an unclassifiable status is counted, not silently dropped to zero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-unknown-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      // A row written by another build. Folding it into neither bucket AND
      // dropping it made the lane read as an empty, caught-up queue.
      await seedSessionOutboxRow(db, {
        id: "skewed",
        status: "in_flight_v2",
        createdAt: "2026-08-06T00:00:00.000Z",
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(sample.sessionOutbox.pending, 0);
      assert.equal(sample.sessionOutbox.deadLettered, 0);
      assert.equal(
        sample.sessionOutbox.unmeasuredRows,
        1,
        "an unreadable status is carried as unaccounted, not rounded away"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7246: a withheld row is counted on its own, never as owed and never as unaccounted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7246-withheld-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-19T12:00:00.000Z",
    });
    try {
      await seedSessionOutboxRow(db, {
        id: "phantom",
        status: OutboxStatus.Withheld,
        createdAt: "2026-08-19T00:00:00.000Z",
      });
      await seedSessionOutboxRow(db, {
        id: "owed",
        status: OutboxStatus.Pending,
        createdAt: "2026-08-19T01:00:00.000Z",
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(
        sample.sessionOutbox.pending,
        1,
        "a withheld row is not owed — only the pending one holds the lane open"
      );
      assert.equal(sample.sessionOutbox.readyPending, 1);
      assert.equal(sample.sessionOutbox.withheld, 1);
      assert.equal(sample.sessionOutbox.deadLettered, 0);
      assert.equal(
        sample.sessionOutbox.unmeasuredRows,
        0,
        "this build classifies `withheld` exactly, so it must not land in the unaccounted bucket"
      );
      assert.equal(
        sample.sessionOutbox.oldestPendingSinceIso,
        "2026-08-19T01:00:00.000Z",
        "the oldest-pending age comes from owed work only — an older withheld row must not age the lane"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5387: the inventory sweep reports rows past its cursor, not a bare null", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-inventory-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      await seedComponentRow(db, {
        id: "c1",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
      });
      await seedComponentRow(db, {
        id: "c2",
        lastSeenAt: "2026-08-02T00:00:00.000Z",
      });
      await seedComponentRow(db, {
        id: "c3",
        lastSeenAt: "2026-08-03T00:00:00.000Z",
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");

      const beforeAnySync = await readSyncBurndown(burndownQuery());
      assert.equal(
        beforeAnySync.componentInventory.rowsRemaining,
        3,
        "with no persisted cursor the whole local inventory is still owed"
      );

      // Advance the durable cursor past the first two rows.
      await db.run(
        `INSERT INTO sync_state
           (source_key, observed_top_updated_at, observed_ids_at_top_updated_at,
            dead_lettered_ids, data_revision, updated_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
        COMPONENT_SOURCE_KEY,
        "2026-08-02T00:00:00.000Z",
        JSON.stringify(["c2"]),
        JSON.stringify(["c9"]),
        "2026-08-06T11:00:00.000Z"
      );

      const afterSync = await readSyncBurndown(burndownQuery());
      assert.equal(
        afterSync.componentInventory.rowsRemaining,
        1,
        "only rows past the keyset are still owed"
      );
      assert.equal(
        afterSync.componentInventory.deadLetteredCount,
        1,
        "abandoned ids come from the DURABLE sync_state list"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-11327: the inventory remainder counts with the SAME predicate the lane drains with", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss11327-parity-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      // The fixture premise: this row's stored text sorts BELOW the cursor while its
      // INSTANT (14:00Z) is above it, so a byte-wise remainder count misses it and a
      // ranked one does not. Asserted rather than assumed.
      const cursorPosition = "2026-08-02T10:30:00.000Z";
      const owedOffsetSpelling = "2026-08-02T09:00:00-05:00";
      assert.ok(
        owedOffsetSpelling < cursorPosition,
        "fixture must keep the owed row BELOW the cursor in byte order"
      );
      assert.ok(
        Date.parse(owedOffsetSpelling) > Date.parse(cursorPosition),
        "fixture must keep the owed row's INSTANT above the cursor"
      );

      await seedComponentRow(db, {
        id: "c-drained",
        lastSeenAt: cursorPosition,
      });
      await seedComponentRow(db, {
        id: "c-owed",
        lastSeenAt: owedOffsetSpelling,
      });

      await db.run(
        `INSERT INTO sync_state
           (source_key, observed_top_updated_at, observed_ids_at_top_updated_at,
            dead_lettered_ids, data_revision, updated_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
        COMPONENT_SOURCE_KEY,
        cursorPosition,
        JSON.stringify(["c-drained"]),
        JSON.stringify([]),
        "2026-08-06T11:00:00.000Z"
      );

      // What the LANE itself still owes from that exact persisted position, read
      // through the very method the lane is wired to rather than a copy of its SQL.
      const listComponentCursorRows = db.syncSource.listComponentCursorRows;
      assert.ok(
        listComponentCursorRows,
        "the sync source exposes the lane's cursor read"
      );
      const laneOwes = await listComponentCursorRows(
        cursorPosition,
        "c-drained",
        50
      );
      assert.deepEqual(
        laneOwes.map((row) => row.id),
        ["c-owed"],
        "the lane must still owe the offset-spelled row"
      );

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(
        sample.componentInventory.rowsRemaining,
        laneOwes.length,
        "the remainder must equal what the lane's own keyset read still returns; a byte-wise count here reports 0 and the lane reads as caught up while it still owes a row"
      );
      assert.equal(sample.componentInventory.rowsRemaining, 1);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7096: parked-partition rows are counted separately and never as pending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7096-parked-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      await seedSessionOutboxRow(db, {
        id: "s-owed",
        status: OutboxStatus.Pending,
        createdAt: "2026-08-05T00:00:00.000Z",
      });
      // Two rows parked under this lane's parked partitions (two different
      // owning orgs), plus one PARKED-but-dead-lettered row that must count
      // toward neither bucket.
      for (const [key, id, status] of [
        ["agent_sessions:parked:org-a", "s-parked-a", OutboxStatus.Pending],
        ["agent_sessions:parked:org-b", "s-parked-b", OutboxStatus.Pending],
        [
          "agent_sessions:parked:org-a",
          "s-parked-dead",
          OutboxStatus.DeadLettered,
        ],
      ] as const) {
        await db.run(
          `INSERT INTO agent_session_sync_outbox
             (source_key, external_session_id, status, sync_class, attempt_count,
              next_attempt_at, last_error, created_at, updated_at)
           VALUES (?, ?, ?, 'backfill', 0,
                   NULL, NULL, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
          key,
          id,
          status
        );
      }

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(sample.sessionOutbox.pending, 1, "parked is never pending");
      assert.equal(sample.sessionOutbox.parkedPending, 2);
      assert.equal(sample.sessionOutbox.deadLettered, 0);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7980: non-array cursor id JSON currently reads as empty lists and zero dead letters", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7980-cursor-json-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      await db.run(
        `INSERT INTO sync_state
         (source_key, observed_top_updated_at, observed_ids_at_top_updated_at,
            dead_lettered_ids, data_revision, updated_at)
         VALUES (?, NULL, '"not-json"', '{"id":"dead"}', 1, ?)`,
        SESSION_SOURCE_KEY,
        SAMPLE_NOW
      );
      await db.run(
        `INSERT INTO sync_state
         (source_key, observed_top_updated_at, observed_ids_at_top_updated_at,
            dead_lettered_ids, data_revision, updated_at)
         VALUES (?, NULL, '{"id":"cursor"}', '"not-json"', 1, ?)`,
        COMPONENT_SOURCE_KEY,
        SAMPLE_NOW
      );

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.deepEqual(
        sample.cursorsBySourceKey[SESSION_SOURCE_KEY]
          ?.observedIdsAtTopUpdatedAt,
        [],
        "a parsed non-array string is currently treated as an empty cursor id list"
      );
      assert.deepEqual(
        sample.cursorsBySourceKey[SESSION_SOURCE_KEY]?.deadLetteredIds,
        [],
        "a parsed non-array object is currently treated as no dead letters"
      );
      assert.deepEqual(
        sample.cursorsBySourceKey[COMPONENT_SOURCE_KEY]
          ?.observedIdsAtTopUpdatedAt,
        [],
        "a parsed non-array object is currently treated as an empty cursor id list"
      );
      assert.equal(
        sample.componentInventory.deadLetteredCount,
        0,
        "a parsed non-array string currently becomes a confident zero"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7980: syntactically invalid cursor JSON rejects before the fallback parser", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7980-invalid-json-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      await db.run(
        `INSERT INTO sync_state
         (source_key, observed_top_updated_at, observed_ids_at_top_updated_at,
            dead_lettered_ids, data_revision, updated_at)
         VALUES (?, NULL, 'not-json', '[]', 1, ?)`,
        SESSION_SOURCE_KEY,
        SAMPLE_NOW
      );

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      await assert.rejects(
        readSyncBurndown(burndownQuery()),
        { name: "SyntaxError" },
        "Prisma rejects invalid JSON before parseIdArray can return an empty list"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7980: invocation payload burden currently uses SQLite character length", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7980-unicode-burden-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      const payload = "é🚀";
      await seedInvocationOutboxRow(db, {
        sourceKey: DELIVERY_SOURCE_KEY,
        sessionId: "unicode-payload",
        partIndex: 0,
        status: OutboxStatus.Pending,
        payload,
        createdAt: SAMPLE_NOW,
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(sample.invocationOutbox.pendingPayloadBytes, 2);
      assert.notEqual(
        sample.invocationOutbox.pendingPayloadBytes,
        Buffer.byteLength(payload, "utf8"),
        "the current burden is Unicode code points, not encoded wire bytes"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7980: public burn-down reads preserve current aggregate coercion", async () => {
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
  const sample = await createSyncBurndownReaders(
    scriptedBurndownPrisma([
      {
        status: OutboxStatus.Pending,
        n: 3.75,
        ready: 1.75,
        oldest: SAMPLE_NOW,
      },
      {
        status: OutboxStatus.DeadLettered,
        n: -1,
        ready: null,
        oldest: null,
      },
      {
        status: OutboxStatus.Withheld,
        n: Number.POSITIVE_INFINITY,
        ready: null,
        oldest: null,
      },
      {
        status: "future_status",
        n: unsafeInteger,
        ready: null,
        oldest: null,
      },
    ])
  ).readSyncBurndown({
    ...burndownQuery(),
    invocationSourceKey: null,
    componentSourceKey: null,
  });

  assert.equal(sample.sessionOutbox.pending, 3);
  assert.equal(sample.sessionOutbox.readyPending, 1);
  assert.equal(sample.sessionOutbox.deadLettered, 0);
  assert.equal(sample.sessionOutbox.withheld, 0);
  assert.equal(
    sample.sessionOutbox.unmeasuredRows,
    unsafeInteger,
    "the current coercion accepts an unsafe finite integer unchanged"
  );
});

function scriptedBurndownPrisma(
  sessionGroups: readonly Record<string, unknown>[]
): DesktopPrisma {
  const scriptedRows = (sql: string): unknown[] => {
    if (
      sql.includes("FROM agent_session_sync_outbox") &&
      sql.includes("GROUP BY status")
    ) {
      return [...sessionGroups];
    }
    if (sql.includes("FROM agent_session_sync_outbox")) {
      return [{ n: 0 }];
    }
    if (
      sql.includes("FROM transcript_sync_state") &&
      sql.includes("GROUP BY status")
    ) {
      return [];
    }
    if (sql.includes("FROM transcript_sync_state")) {
      return [{ bytes: 0 }];
    }
    if (sql.includes("FROM sync_state")) {
      return [];
    }
    // ISS-8768: two new reads reach this scripted reader on the null-delivery-key
    // path — the never-promoted existence probe, and (only when that reports the
    // machine never promoted) the pending-template probe.
    if (
      sql.includes("FROM agent_component_invocation_sync_cursors") &&
      sql.includes("source_key = $1") &&
      !sql.includes("template")
    ) {
      return [];
    }
    if (sql.includes("FROM agent_component_invocation_sync_cursors template")) {
      return [];
    }
    throw new Error(`unexpected burn-down query: ${sql}`);
  };
  let reader: DesktopPrismaReadClient;
  reader = {
    $queryRawUnsafe: (sql: string) => Promise.resolve(scriptedRows(sql)),
    $transaction: <T>(
      run: (tx: DesktopPrismaReader) => Promise<T>
    ): Promise<T> => run(reader),
    transcriptSyncState: {
      count: () => Promise.resolve(0),
    },
  } as unknown as DesktopPrismaReadClient;
  return {
    read: <T>(
      run: (client: DesktopPrismaReadClient) => Promise<T>
    ): Promise<T> => run(reader),
  } as unknown as DesktopPrisma;
}
