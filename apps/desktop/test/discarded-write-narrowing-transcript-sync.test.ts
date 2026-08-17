/**
 * @file discarded-write-narrowing-transcript-sync.test.ts
 * @description ISS-6321 (batch 5/6) — the six discarded `transcriptSyncState`
 * updates in `database/transcript-sync-store.ts`, run against a real libSQL
 * store. Split from the other database sites so neither suite approaches the
 * file-size ceiling.
 *
 * Every one keeps its `update` and takes
 * `select: { externalSessionId: true, fileKey: true }` — `TranscriptSyncState`
 * is keyed on the compound `@@id([externalSessionId, fileKey])` and has NO `id`
 * column, so two cells replace 21.
 *
 * NONE becomes `updateMany`, and this file is the clearest case in the batch
 * for why. The store ALREADY draws that line itself: `recordBatchSettled` and
 * `requeueUnsettledBatch` use `updateMany` with an in-code comment calling it
 * "zero-row-safe … NOT a P2025 throw that would abort the autocommit mid-batch",
 * while these six single-row settles deliberately keep `update`. Converting
 * them would erase a distinction the file states in prose.
 *
 * It is also the lane `apps/desktop/src/main/sync/AGENTS.md` governs, where
 * stranded local data is named the worst failure mode. `markDead` and
 * `recordFailure` ARE the dead-letter and retry-budget decisions; a silent
 * `{count: 0}` there would report a transcript as settled that no retry will
 * ever pick up again.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTranscriptSyncStore,
  type TranscriptSyncStore,
} from "../src/main/database/transcript-sync-store.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import {
  assertNarrowedTo,
  isP2025,
  type RecordedPrisma,
  recordDesktopWrites,
} from "./discarded-write-narrowing-utils.js";
import { observeInput, T0 } from "./helpers/transcript-sync-store-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const SESSION = "sess-1";
const FILE_KEY = "main";
const T1 = "2026-07-09T01:00:00.000Z";
/**
 * `TranscriptSyncState` is `@@id([externalSessionId, fileKey])` — no `id`.
 *
 * Deliberately restated here rather than importing the production
 * `TRANSCRIPT_ROW_SELECT`: importing it would make every assertion below compare
 * the constant against itself, so changing the production select to the WRONG
 * key would still pass. The expectation has to be an independent statement of
 * the schema's primary key for the test to be able to fail.
 */
const BY_IDENTITY = { externalSessionId: true, fileKey: true } as const;

type Harness = {
  store: TranscriptSyncStore;
  recorded: RecordedPrisma;
  statusOf: () => Promise<string | undefined>;
  close: () => Promise<void>;
};

/** Open a store over a recording prisma, with the canonical row already observed. */
async function withSeededStore(): Promise<Harness> {
  const opened = await openTestPrisma();
  const recorded = recordDesktopWrites(opened.prisma);
  const store = createTranscriptSyncStore(recorded.prisma);
  await store.observe(observeInput({ syncClass: "live" }));
  recorded.reset();
  return {
    store,
    recorded,
    statusOf: async () => {
      const result = await opened.db.query<{ status: string }>(
        "SELECT status FROM transcript_sync_state WHERE external_session_id = $1",
        [SESSION]
      );
      return result.rows[0]?.status;
    },
    close: opened.close,
  };
}

/** A store with NO row observed — every settle below targets a missing row. */
async function withEmptyStore(): Promise<{
  store: TranscriptSyncStore;
  close: () => Promise<void>;
}> {
  const opened = await openTestPrisma();
  return {
    store: createTranscriptSyncStore(opened.prisma),
    close: opened.close,
  };
}

const uploadedInput = {
  externalSessionId: SESSION,
  fileKey: FILE_KEY,
  syncedByteOffset: 500,
  syncedSha256: "sha-1",
  storedEtag: "etag-1",
  syncedComputeTargetId: null,
  caughtUp: true,
  now: T1,
};

const failureInput = {
  externalSessionId: SESSION,
  fileKey: FILE_KEY,
  retryCount: 1,
  missingSourceCount: 0,
  dead: false,
  nextAttemptAt: T1,
  lastError: "boom",
  now: T1,
};

/** The six settles, each driven through its real store method. */
const SETTLES: ReadonlyArray<{
  name: string;
  line: number;
  run: (store: TranscriptSyncStore) => Promise<void>;
  expectStatus: string;
}> = [
  {
    name: "markUploading",
    line: 752,
    run: (s) => s.markUploading(SESSION, FILE_KEY, T1),
    expectStatus: TranscriptSyncStatus.Uploading,
  },
  {
    name: "markDead",
    line: 765,
    run: (s) => s.markDead(SESSION, FILE_KEY, "gave up", T1),
    expectStatus: TranscriptSyncStatus.Dead,
  },
  {
    name: "markIdle",
    line: 783,
    run: (s) => s.markIdle(SESSION, FILE_KEY, T1),
    expectStatus: TranscriptSyncStatus.Idle,
  },
  {
    name: "markCloudUploaded",
    line: 801,
    run: (s) => s.markCloudUploaded(SESSION, FILE_KEY, T1, null),
    expectStatus: TranscriptSyncStatus.Idle,
  },
  {
    name: "recordUploaded",
    line: 815,
    run: (s) => s.recordUploaded(uploadedInput),
    expectStatus: TranscriptSyncStatus.Idle,
  },
  {
    name: "recordFailure",
    line: 823,
    run: (s) => s.recordFailure(failureInput),
    expectStatus: TranscriptSyncStatus.Failed,
  },
];

for (const settle of SETTLES) {
  test(`PARITY: ${settle.name} (${settle.line}) settles the observed row`, async () => {
    const { store, statusOf, close } = await withSeededStore();
    try {
      await settle.run(store);
      assert.equal(
        await statusOf(),
        settle.expectStatus,
        `${settle.name} must persist its settled status`
      );
    } finally {
      await close();
    }
  });

  /**
   * The refusal, proven per site: with no row present the settle still REJECTS
   * with P2025 rather than resolving. `updateMany` would resolve `{count: 0}`
   * here and the caller — a drain worker deciding retry vs dead-letter — would
   * treat an untouched transcript as successfully settled.
   */
  test(`PARITY: ${settle.name} (${settle.line}) still rejects P2025 when the row is absent`, async () => {
    const { store, close } = await withEmptyStore();
    try {
      await assert.rejects(
        () => settle.run(store),
        (error: unknown) => {
          assert.ok(
            isP2025(error),
            `expected P2025, got ${JSON.stringify(error)}`
          );
          return true;
        }
      );
    } finally {
      await close();
    }
  });

  test(`NARROWING: ${settle.name} (${settle.line}) RETURNINGs only the compound identity`, async () => {
    const { store, recorded, close } = await withSeededStore();
    try {
      await settle.run(store);
      assertNarrowedTo(
        recorded.only("transcriptSyncState", "update"),
        BY_IDENTITY,
        settle.name
      );
    } finally {
      await close();
    }
  });
}

/**
 * The distinction this batch must not collapse, asserted directly: the BATCH
 * settle path is `updateMany` and is zero-row-safe BY DESIGN, while the
 * single-row settles above throw. Both behaviours must survive the narrowing.
 */
test("PARITY: recordBatchSettled stays zero-row-safe while single settles throw", async () => {
  const { store, close } = await withEmptyStore();
  try {
    await store.recordBatchSettled([
      { kind: "idle", externalSessionId: SESSION, fileKey: FILE_KEY, now: T0 },
    ]);
  } finally {
    await close();
  }
});
