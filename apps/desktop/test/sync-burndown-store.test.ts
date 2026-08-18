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
import { test } from "node:test";
import { AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { TraceCommentSyncStatus } from "../src/shared/trace-comment-sync-status-contract.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";

const COMPUTE_TARGET_ID = "ct-1";
const SESSION_SOURCE_KEY = "agent_sessions:ct-1";
const DELIVERY_SOURCE_KEY = `${AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY}:ct-1`;
const COMPONENT_SOURCE_KEY = "agent_components:v3:ct-1";
/**
 * ISS-5973: the instant every sample is taken at. Pinned rather than read from
 * the wall clock, because `readyPending` is a deadline COMPARISON and a test
 * that straddles the boundary by real time is a flake waiting to happen.
 */
const SAMPLE_NOW = "2026-08-06T12:00:00.000Z";

type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

function burndownQuery(nowIso: string = SAMPLE_NOW) {
  return {
    sessionSourceKey: SESSION_SOURCE_KEY,
    invocationSourceKey: DELIVERY_SOURCE_KEY,
    invocationTemplateSourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    componentSourceKey: COMPONENT_SOURCE_KEY,
    transcriptComputeTargetId: COMPUTE_TARGET_ID,
    nowIso,
  };
}

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
        next_attempt_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, 'backfill', 0, ?, NULL, ?, ?)`,
    SESSION_SOURCE_KEY,
    input.id,
    input.status,
    input.nextAttemptAt ?? null,
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
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 4, ?, ?, 1, 1, ?, ?, 0, NULL, NULL, ?, ?)`,
    input.sourceKey,
    input.sessionId,
    `${input.sessionId}-gen`,
    input.partIndex,
    `${"a".repeat(63)}${input.partIndex}`,
    input.createdAt,
    input.payload,
    input.status,
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

async function seedTraceCommentRow(
  db: DbRun,
  input: {
    id: string;
    syncStatus: string;
    createdAt: string;
    replies?: readonly { id: string; syncStatus: string }[];
  }
): Promise<void> {
  await db.run(
    `INSERT INTO trace_comments
       (id, thread_id, target_type, target_id, artifact_id, surface, status,
        anchor, body, author_id, mentions, replies, comment_kind, sync_status,
        created_at, updated_at)
     VALUES (?, ?, 'session', 'target-1', 'artifact-1', 'timeline', 'OPEN',
             '{}', 'body', 'desktop-local', '[]', ?, 'comment', ?, ?, ?)`,
    input.id,
    `thread-${input.id}`,
    JSON.stringify(input.replies ?? []),
    input.syncStatus,
    input.createdAt,
    input.createdAt
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
        sample.sessionOutbox.oldestPendingEnqueuedAtIso,
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

test("ISS-5387: pending trace comments are counted as work owed to the cloud", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5387-comments-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-06T12:00:00.000Z",
    });
    try {
      await seedTraceCommentRow(db, {
        id: "tc1",
        syncStatus: TraceCommentSyncStatus.LocalPending,
        createdAt: "2026-08-05T09:00:00.000Z",
      });
      await seedTraceCommentRow(db, {
        id: "tc2",
        syncStatus: TraceCommentSyncStatus.SyncFailedUpdate,
        createdAt: "2026-08-05T10:00:00.000Z",
      });
      await seedTraceCommentRow(db, {
        id: "tc3",
        syncStatus: TraceCommentSyncStatus.Synced,
        createdAt: "2026-08-05T11:00:00.000Z",
      });
      await seedTraceCommentRow(db, {
        id: "tc4",
        syncStatus: TraceCommentSyncStatus.Synced,
        createdAt: "2026-08-05T12:00:00.000Z",
        replies: [{ id: "r1", syncStatus: "local_pending_reply" }],
      });

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(burndownQuery());

      assert.equal(sample.traceComments.pendingComments, 2);
      assert.equal(
        sample.traceComments.pendingReplyComments,
        1,
        "a synced comment carrying an undelivered REPLY still owes the cloud"
      );
      assert.equal(
        sample.traceComments.oldestPendingCreatedAtIso,
        "2026-08-05T09:00:00.000Z"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
