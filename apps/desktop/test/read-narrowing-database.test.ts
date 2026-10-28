/**
 * @file read-narrowing-database.test.ts
 * @description ISS-6326 (reads 4/4) — the unselected reads under
 * `main/database/` that this batch could reach.
 *
 * Everything runs against a REAL libSQL database (the production migration
 * runner), not a Prisma double, so `select` is applied by the database itself
 * and a column the query did not ask for is genuinely ABSENT from the row the
 * mapper receives. Two halves, because one alone is not enough:
 *
 * PARITY — what the CONSUMER produces from the row (a `TranscriptFingerprint`, a
 * `PersistedSyncState`), never the row's own key
 * count, which would only pin the bug. These are characterization cases: they
 * were written first and passed on unmodified `origin/main`. Be precise about
 * what they can catch — an unselected read returns a SUPERSET and the mappers
 * name their fields, so parity cases go red on a `select` narrowed TOO FAR and
 * stay green on one that is absent or too wide.
 *
 * NARROWING — the half parity cannot state. These record the real delegate call
 * through `recordDesktopCalls` and assert the `select` argument, the way the
 * ISS-6321 write batch does with `assertNarrowedTo`; without them, reverting
 * this whole change would leave the file green. Their expected key sets are
 * written out here rather than imported from the production constants, because
 * an assertion that imports the value under test compares it against itself.
 *
 * The nullable columns in every fixture are seeded NON-NULL on purpose. A
 * nullable column left null makes its own narrowing unfalsifiable: `undefined`
 * (dropped from the projection) and `null` (selected, genuinely empty) collapse
 * into the same assertion.
 *
 * The last case is not coverage of a change at all — it is the executable
 * evidence for the sites this batch deliberately left WIDE.
 */
import assert from "node:assert/strict";
import { AUTONOMY_FORMULA_VERSION } from "@repo/lib/session-trace/autonomy";
import { test } from "vitest";
import { AGENT_SESSION_SYNC_SOURCE_KIND } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  AGENT_SESSION_SYNC_INTEGRITY_VERSION,
  sqliteLoadSyncState,
} from "../src/main/database/sync-cursor-state.js";
import { createTranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../src/shared/transcript-sync-status-contract.js";
import {
  type RecordedWrite,
  recordDesktopCalls,
  WIDE_READ_METHODS,
} from "./discarded-write-narrowing-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-08-16T00:00:00.000Z";
const LATER = "2026-08-16T01:00:00.000Z";

type OpenedDb = Awaited<ReturnType<typeof openTestPrisma>>["db"];

/**
 * Seed one `transcript_sync_state` row with every nullable column populated and
 * every value distinct, so dropping ANY column from the read shows up as a
 * changed fingerprint field rather than as an indistinguishable null.
 */
function seedTranscriptRow(
  db: OpenedDb,
  overrides: Partial<Record<string, unknown>> = {}
): Promise<unknown> {
  const row = {
    external_session_id: "sess-1",
    file_key: "main",
    source_harness: "claude",
    source_path: "/home/u/.claude/projects/p/sess-1.jsonl",
    source_path_hash: "hash-sess-1",
    last_mtime_ms: 1_700_000_000_123,
    last_size: 4096,
    synced_byte_offset: 2048,
    synced_sha256: "sha256-of-the-synced-prefix",
    stored_etag: "etag-abc",
    synced_compute_target_id: "compute-target-1",
    status: TranscriptSyncStatus.Failed,
    sync_class: TranscriptSyncClass.Live,
    retry_count: 4,
    missing_source_count: 2,
    next_attempt_at: LATER,
    last_error: "upload rejected: 503",
    cloud_uploaded_at: NOW,
    cloud_uploaded_compute_target_id: "compute-target-2",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  return db.query(
    `INSERT INTO transcript_sync_state (${columns.join(", ")}) VALUES (${placeholders})`,
    Object.values(row)
  );
}

test("ISS-6326: the transcript fingerprint read carries every mapped column off a fully populated row", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedTranscriptRow(db);
    const store = createTranscriptSyncStore(prisma);

    const fingerprint = await store.get("sess-1", "main");

    // The consumer's whole observable output, field by field. Every one of these
    // is a column the read must return; drop it from the `select` and the mapper
    // yields `undefined` here.
    assert.deepEqual(fingerprint, {
      externalSessionId: "sess-1",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/home/u/.claude/projects/p/sess-1.jsonl",
      sourcePathHash: "hash-sess-1",
      lastMtimeMs: 1_700_000_000_123,
      lastSize: 4096,
      syncedByteOffset: 2048,
      syncedSha256: "sha256-of-the-synced-prefix",
      storedEtag: "etag-abc",
      syncedComputeTargetId: "compute-target-1",
      status: TranscriptSyncStatus.Failed,
      syncClass: TranscriptSyncClass.Live,
      retryCount: 4,
      missingSourceCount: 2,
      nextAttemptAt: LATER,
      lastError: "upload rejected: 503",
      laneStalledSince: null,
    });
  } finally {
    await close();
  }
});

/**
 * `listReady` is a distinct shape from `get`: its rows cross
 * `interleaveBackfillReady` before the mapper, and that pincer merge dedupes on
 * `externalSessionId` + `fileKey`. If either identity column were dropped from
 * the read, every row would collapse to the same `undefined:undefined` key and
 * the batch would silently shrink to one row.
 */
test("ISS-6326: the ready-batch read keeps row identity and class through the backfill pincer", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    // Two live rows and one backfill row. The mix matters: `toFingerprint`
    // falls back to `Backfill` for an unreadable class, so a fixture of only
    // backfill rows would let a dropped `syncClass` column pass unnoticed.
    const seeds = [
      { id: "sess-live-new", syncClass: TranscriptSyncClass.Live, mtime: 300 },
      { id: "sess-live-old", syncClass: TranscriptSyncClass.Live, mtime: 200 },
      {
        id: "sess-backfill",
        syncClass: TranscriptSyncClass.Backfill,
        mtime: 100,
      },
    ];
    for (const seed of seeds) {
      await seedTranscriptRow(db, {
        external_session_id: seed.id,
        source_path_hash: `hash-${seed.id}`,
        status: TranscriptSyncStatus.Queued,
        sync_class: seed.syncClass,
        next_attempt_at: null,
        last_mtime_ms: 1_700_000_000_000 + seed.mtime,
      });
    }
    const store = createTranscriptSyncStore(prisma);

    const ready = await store.listReady(LATER, 3, null);

    assert.deepEqual(
      ready.map((row) => row.externalSessionId),
      ["sess-live-new", "sess-live-old", "sess-backfill"],
      "each row keeps its own identity rather than deduping onto one key"
    );
    assert.deepEqual(
      ready.map((row) => row.syncClass),
      [
        TranscriptSyncClass.Live,
        TranscriptSyncClass.Live,
        TranscriptSyncClass.Backfill,
      ],
      "sync_class is read, not supplied by the unknown-value fallback"
    );
  } finally {
    await close();
  }
});

/**
 * `observe` reads the existing row to DECIDE the next one. That read has its own
 * consumer — `planObservation` — and the backoff state it carries forward is
 * invisible to `tsc` if a column goes missing: `retryCount` would restart at 0,
 * `lastError` and `nextAttemptAt` would clear, and a failing file would be
 * retried immediately, forever.
 */
test("ISS-6326: an unchanged re-observe carries the existing backoff state forward", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedTranscriptRow(db);
    const store = createTranscriptSyncStore(prisma);

    const observed = await store.observe({
      externalSessionId: "sess-1",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/home/u/.claude/projects/p/sess-1.jsonl",
      sourcePathHash: "hash-sess-1",
      mtimeMs: 1_700_000_000_123,
      size: 4096,
      syncClass: TranscriptSyncClass.Live,
      now: LATER,
    });

    assert.equal(observed.retryCount, 4, "the retry ladder is not restarted");
    assert.equal(observed.missingSourceCount, 2);
    assert.equal(
      observed.nextAttemptAt,
      LATER,
      "the backoff deadline survives"
    );
    assert.equal(observed.lastError, "upload rejected: 503");
    assert.equal(
      observed.status,
      TranscriptSyncStatus.Failed,
      "an unchanged file keeps its terminal status instead of re-queuing"
    );
  } finally {
    await close();
  }
});

function seedSyncState(
  db: OpenedDb,
  overrides: Partial<Record<string, unknown>> = {}
): Promise<unknown> {
  const row = {
    source_key: `${AGENT_SESSION_SYNC_SOURCE_KIND}:local`,
    observed_top_updated_at: NOW,
    observed_ids_at_top_updated_at: JSON.stringify(["sess-a", "sess-b"]),
    dead_lettered_ids: JSON.stringify(["sess-dead"]),
    data_revision: 7,
    autonomy_formula_version: AUTONOMY_FORMULA_VERSION,
    sync_integrity_version: AGENT_SESSION_SYNC_INTEGRITY_VERSION,
    updated_at: NOW,
    ...overrides,
  };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  return db.query(
    `INSERT INTO sync_state (${columns.join(", ")}) VALUES (${placeholders})`,
    Object.values(row)
  );
}

/**
 * The sharpest case in this batch. Both version stamps are compared with
 * `storedVersion !== CURRENT`, so a column dropped from the read reads back as
 * `undefined`, compares unequal, and the lane declares itself stale — clearing
 * the watermark and re-walking the entire local corpus on EVERY boot, forever.
 * `tsc` cannot see it: the comparison accepts any value.
 */
test("ISS-6326: a current-revision cursor loads its watermark instead of declaring a re-walk", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedSyncState(db);
    // ISS-11427: the load keeps a cursor dead-letter only while its outbox row
    // is still `dead_lettered`, so the set-aside id needs the row it implies.
    await db.query(
      `INSERT INTO agent_session_sync_outbox (source_key, external_session_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [
        `${AGENT_SESSION_SYNC_SOURCE_KIND}:local`,
        "sess-dead",
        OutboxStatus.DeadLettered,
        NOW,
      ]
    );

    const loaded = await sqliteLoadSyncState(
      prisma,
      `${AGENT_SESSION_SYNC_SOURCE_KIND}:local`
    );

    assert.deepEqual(loaded, {
      observedTopUpdatedAt: NOW,
      observedIdsAtTopUpdatedAt: ["sess-a", "sess-b"],
      deadLetteredIds: ["sess-dead"],
    });
  } finally {
    await close();
  }
});

/**
 * There is deliberately NO case here for the re-walk side of that branch. The
 * `requiresFullRewalk` return is a hard-coded literal, so it is identical
 * whether the stamps were read correctly or narrowed away entirely — a
 * stale-stamp case cannot fail under the mutation this file exists to catch,
 * and it would duplicate `sync-autonomy-formula-backfill.test.ts` and
 * `sync-integrity-backfill.test.ts`, which own that branch. The case above is
 * the falsifiable one: a dropped stamp column reads back `undefined`, compares
 * unequal, and turns the loaded watermark into a re-walk.
 */

const EXPECTED_FINGERPRINT_COLUMNS = [
  "externalSessionId",
  "fileKey",
  // ISS-7097: the drain reads the lane-wide stall's start instant to apply the
  // wall-clock ceiling. Its sibling `uploadingSince` is deliberately NOT here —
  // only the reclaim's own `updateMany` predicate reads the lease, so widening
  // the projection for it would buy nothing.
  "laneStalledSince",
  "lastError",
  "lastMtimeMs",
  "lastSize",
  "missingSourceCount",
  "nextAttemptAt",
  "retryCount",
  "sourceHarness",
  "sourcePath",
  "sourcePathHash",
  "status",
  "storedEtag",
  "syncClass",
  "syncedByteOffset",
  "syncedComputeTargetId",
  "syncedSha256",
];

/**
 * ISS-9884: the observe read alone also asks for the terminal-skip pair. Its
 * planner decides from them whether an observation may clear a paused row's
 * compute-target scope, and narrowing them away would read both as `undefined`
 * — "no attributed pause" — so a target switch on an unchanged file would
 * clear the scope and re-queue the row under the new account.
 */
const EXPECTED_OBSERVE_COLUMNS = [
  ...EXPECTED_FINGERPRINT_COLUMNS,
  "terminalSkipComputeTargetId",
  "terminalSkipReason",
].sort();

/**
 * `sourceKey`, `dataRevision`, and `updatedAt` are absent on purpose.
 *
 * The four lane-run columns are CONSUMED (they resume a run across a relaunch);
 * this short key's cursor row IS its lane-run row, so the read asserted here carries both.
 */
const EXPECTED_SYNC_STATE_COLUMNS = [
  "autonomyFormulaVersion",
  "deadLetterAttempts",
  "deadLetteredIds",
  "laneGaveUpAt",
  "laneGaveUpReason",
  "laneGaveUpSource",
  "laneStalledSince",
  "observedIdsAtTopUpdatedAt",
  "observedTopUpdatedAt",
  "syncIntegrityVersion",
];

function selectedColumns(call: RecordedWrite): string[] {
  const select = call.args.select;
  if (select === undefined || select === null || typeof select !== "object") {
    throw new Error(
      `${call.model}.${call.method} has no \`select\` — it reads every column`
    );
  }
  return Object.keys(select).sort();
}

/**
 * The narrowing half for `transcript_sync_state`. Drives all five converted
 * sites through their production entry points and asserts each recorded read
 * carried the projection — the assertion the parity cases above cannot make.
 * The observe read is held to its own list, the projection plus the pair.
 */
test("ISS-6326: every transcript fingerprint read asks the store for the projection", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedTranscriptRow(db, {
      status: TranscriptSyncStatus.Queued,
      next_attempt_at: null,
    });
    const recorded = recordDesktopCalls(prisma, WIDE_READ_METHODS);
    const store = createTranscriptSyncStore(recorded.prisma);

    await store.get("sess-1", "main");
    await store.listRecent(10);
    await store.listReady(LATER, 10, null);
    await store.observe({
      externalSessionId: "sess-1",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/home/u/.claude/projects/p/sess-1.jsonl",
      sourcePathHash: "hash-sess-1",
      mtimeMs: 1_700_000_000_123,
      size: 4096,
      syncClass: TranscriptSyncClass.Live,
      now: LATER,
    });

    const reads = recorded.calls.filter(
      (call) => call.model === "transcriptSyncState"
    );
    assert.equal(
      reads.length,
      6,
      "get + listRecent + listReady (live, newest, oldest) + observe"
    );
    const observeRead = reads.at(-1);
    assert.ok(observeRead, "observe is the last recorded read");
    for (const read of reads.slice(0, -1)) {
      assert.deepEqual(
        selectedColumns(read),
        EXPECTED_FINGERPRINT_COLUMNS,
        `${read.model}.${read.method} must read only the fingerprint projection`
      );
    }
    assert.deepEqual(
      selectedColumns(observeRead),
      EXPECTED_OBSERVE_COLUMNS,
      "observe must read the fingerprint projection plus the terminal-skip pair"
    );
  } finally {
    await close();
  }
});

/** The narrowing half for `sync_state`. */
test("ISS-6326: the cursor load asks the store for the projection", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedSyncState(db);
    const recorded = recordDesktopCalls(prisma, WIDE_READ_METHODS);

    await sqliteLoadSyncState(
      recorded.prisma,
      `${AGENT_SESSION_SYNC_SOURCE_KIND}:local`
    );

    assert.deepEqual(
      selectedColumns(recorded.only("syncState", "findUnique")),
      EXPECTED_SYNC_STATE_COLUMNS
    );
  } finally {
    await close();
  }
});
