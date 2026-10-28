/**
 * @file ingest-batch-resume-durability.test.ts
 * @description ISS-5161 regression: an interrupted BATCH-harness backfill must
 * resume across a PROCESS restart instead of replaying the whole corpus — but
 * only while the store has not moved underneath it.
 *
 * OpenCode is the only batch harness. `listSources()` returns one sentinel (the
 * whole `opencode.db`) and `parse(sentinel)` loads every session, so the engine's
 * per-file resumability — `cache.markSeenWith` plus the throttled flush, whose
 * own comment says it exists "so a long first-launch backfill resumes after a
 * kill/restart instead of restarting from zero" — is gated on `!collector.batch`
 * and skipped for it by construction. Its only durable marker is the collector's
 * store fingerprint, which `markSourceImported` advances only after the WHOLE
 * corpus imports.
 *
 * ISS-5028's resume cursor fixed the in-process case (a mid-source yield no
 * longer replays the prefix) but lived only in memory, so a quit/crash mid-pass
 * came back with an empty cursor AND an unadvanced fingerprint: the store was
 * re-listed, re-parsed in full, and every already-imported session was replayed
 * before the pass could reach new work. On a machine quit and relaunched daily,
 * a corpus too large to finish in one uninterrupted pass never finishes at all.
 *
 * The two CollectorManager cases below are the proof AND its safety bound: one
 * manager is stopped mid-backfill (the ordinary quit path) and a SECOND manager
 * is constructed on the SAME state dir. When the store is unchanged the second
 * process resumes; when the store CHANGED while the app was closed it replays in
 * full, because this pass's snapshot was captured after the relaunch and so
 * `markSourceImported` has nothing left to refuse.
 *
 * ISS-9839 (whitlockk review) adds the leg those cases cannot see, because they hold
 * the store directly: on a real quit the flush travels through `DbHostClient`,
 * and the app opens that client's ISS-4713 intentional-shutdown window BEFORE it
 * tears down the collectors. The last case drives the flush over a real client
 * with that window open, so "the cursor survived the quit" is asserted against
 * the gate a production quit actually puts in front of it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { BatchResumeCursorStore } from "../src/main/collectors/engine/collector-manager-batch-resume.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { DB_HOST_STORE_OP_PREFIX } from "../src/main/database/db-host/db-host-store-op-registry.js";
import { createIngestBatchResumeCursorStore } from "../src/main/database/ingest-batch-resume-cursor-store.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import { deferred } from "./deferred.js";
import {
  runIngestBatchResumeCursorStoreOp,
  sqliteBatchResumeCursorStore,
} from "./helpers/batch-resume-cursor-fixtures.js";
import {
  fakeFsWatcher,
  noopCooperativeDelay,
} from "./helpers/collector-manager-fixtures.js";
import { fakeCollector, makeSession } from "./normalized-session-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** Sessions in the simulated OpenCode store. */
const BATCH_SESSION_COUNT = 40;
/**
 * Sessions the first process imports before the app is quit. Any value strictly
 * between 0 and BATCH_SESSION_COUNT exercises the resume; a round fraction keeps
 * the arithmetic in the assertions readable.
 */
const IMPORTS_BEFORE_QUIT = 15;
/**
 * The second manager awaits `onBootImportComplete`, which a regression in the
 * resume path can simply never produce, so these cases carry their own timeout
 * rather than leaning on the runner default (apps/desktop test:node determinism
 * rule). Sized to match the sibling CollectorManager suites in this directory.
 */
const TEST_CASE_TIMEOUT_MS = 15_000;

const OPENCODE = "opencode";
const FINGERPRINT_BEFORE_QUIT = "opencode.db:1000:512";
const FINGERPRINT_AFTER_EDIT = "opencode.db:2000:640";

/**
 * The durable medium the two "processes" share. ISS-9839 moved the cursor from a
 * JSON file in the state dir into the `ingest_batch_resume_cursor` SQLite table,
 * so the restart proof runs over ONE real libSQL database that outlives both
 * managers — the same relationship the state dir had to them before. Reading the
 * row directly, rather than through the cursor that wrote it, is a repair of
 * test MECHANICS: the expectations below are unchanged.
 */
type CursorMedium = {
  store: BatchResumeCursorStore;
  /**
   * Source keys in the persisted cursor. Throws when NO cursor was persisted at
   * all, the way reading an absent file did — "the source completed and left an
   * empty cursor" and "nothing was ever written" are different facts.
   */
  keys: () => Promise<string[]>;
  close: () => Promise<void>;
};

async function openCursorMedium(): Promise<CursorMedium> {
  const { db, prisma, close } = await openTestPrisma();
  return {
    store: sqliteBatchResumeCursorStore(prisma),
    keys: async () => {
      const rows = await db.query<{ cursors: string }>(
        'SELECT "cursors" FROM "ingest_batch_resume_cursor"'
      );
      const cursors = rows.rows.at(0)?.cursors;
      if (cursors === undefined) {
        throw new Error("no batch resume cursor row was ever persisted");
      }
      return Object.keys(JSON.parse(cursors) as Record<string, unknown>);
    },
    close,
  };
}

type TwoProcessRun = {
  /** Every session id written, across BOTH processes, in order. */
  importedIds: string[];
  /** Source keys left in the persisted cursor file after the second process. */
  residualCursorKeys: string[];
  /** Sessions the FIRST process wrote before the quit. */
  importsAtQuit: number;
};

/**
 * Drive two real `CollectorManager` instances over ONE state dir: the first is
 * stopped mid-backfill from inside `importSession` (the ordinary quit path), the
 * second is a fresh manager that runs to completion. `fingerprintAfterQuit` is
 * what the store reports on relaunch — the same value means the store did not
 * move while the app was closed.
 */
async function runQuitAndRelaunch(
  dir: string,
  fingerprintAfterQuit: string,
  medium: CursorMedium
): Promise<TwoProcessRun> {
  const store = join(dir, "opencode.db");
  writeFileSync(store, "{}\n");
  const importedIds: string[] = [];
  let fingerprint = FINGERPRINT_BEFORE_QUIT;

  const buildCollector = (): HarnessCollector => {
    const base = fakeCollector(OPENCODE, {
      batch: true,
      sources: [store],
      watchRoots: [dir],
      // Every pass loads the WHOLE corpus — that is what makes a batch source a
      // batch source, and why a resumed pass must fast-forward rather than
      // re-import what an earlier process already committed.
      parse: (source) =>
        Promise.resolve(
          source === store
            ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
                makeSession({ sessionId: `batch-${index}` })
              )
            : []
        ),
    });
    return {
      ...base,
      sourceFingerprint: () => fingerprint,
      markSourceImported: () => true,
    };
  };

  const quit = deferred();
  let firstManager: CollectorManager | null = null;
  // ISS-9839: the quit's flush is an async write-back now, so the "process" is
  // not gone until it settles — exactly what the production quit path awaits.
  let firstStopped: Promise<void> = Promise.resolve();
  firstManager = new CollectorManager({
    importer: {
      importSession: (session) => {
        importedIds.push(session.sessionId);
        if (importedIds.length === IMPORTS_BEFORE_QUIT) {
          // The user quits the app mid-backfill. `stop()` persists the cursor;
          // the import loop then observes `stopped` and unwinds without writing
          // anything further.
          firstStopped = firstManager?.stop() ?? Promise.resolve();
          quit.resolve();
        }
        return { skipped: false, reactivated: false };
      },
    },
    stateDir: dir,
    batchResumeCursorStore: medium.store,
    emit: () => {},
    getCollectionMode: () => "watcher",
    cooperativeDelay: noopCooperativeDelay,
    catchupPollMs: null,
    log: () => {},
    watchDirectory: () => fakeFsWatcher(),
    collectors: [buildCollector()],
  });
  firstManager.start();
  await quit.promise;
  await firstStopped;

  const importsAtQuit = importedIds.length;
  // The app was closed for a while. Whatever happened to the store in that
  // window is already baked into the snapshot the NEXT pass captures.
  fingerprint = fingerprintAfterQuit;

  const bootComplete = deferred();
  const secondManager = new CollectorManager({
    importer: {
      importSession: (session) => {
        importedIds.push(session.sessionId);
        return { skipped: false, reactivated: false };
      },
    },
    stateDir: dir,
    batchResumeCursorStore: medium.store,
    emit: () => {},
    getCollectionMode: () => "watcher",
    cooperativeDelay: noopCooperativeDelay,
    catchupPollMs: null,
    log: () => {},
    onBootImportComplete: () => bootComplete.resolve(),
    watchDirectory: () => fakeFsWatcher(),
    collectors: [buildCollector()],
  });
  secondManager.start();
  await bootComplete.promise;
  await secondManager.stop();

  return {
    importedIds: importedIds.filter((id) => id.startsWith("batch-")),
    residualCursorKeys: await medium.keys(),
    importsAtQuit,
  };
}

test("ISS-5161: a batch backfill interrupted by a quit resumes in the next process instead of replaying the store", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-batch-resume-"));
  const medium = await openCursorMedium();
  try {
    const run = await runQuitAndRelaunch(dir, FINGERPRINT_BEFORE_QUIT, medium);

    assert.equal(
      new Set(run.importedIds).size,
      BATCH_SESSION_COUNT,
      "every session in the store must end up imported across the two processes"
    );
    // Exactly ONE session is re-read: the one in flight when the quit landed.
    // It was durably imported, but `stop()` broke the loop before the cursor
    // recorded it, so the checkpoint is one behind the database — the
    // conservative direction (a session is re-read, never skipped unwritten).
    // The regression signature is far above that: without a DURABLE cursor the
    // second process starts from session zero and writes
    // BATCH_SESSION_COUNT + IMPORTS_BEFORE_QUIT times.
    assert.equal(
      run.importedIds.length,
      BATCH_SESSION_COUNT + 1,
      `the resumed process may replay only the session in flight at the quit: ${run.importedIds.length} writes for ${BATCH_SESSION_COUNT} sessions`
    );
    // The source reached a terminal outcome in process 2, so its cursor is gone
    // — a later retry must re-read every session, or an append that lands after
    // this import would be skipped forever.
    assert.deepEqual(
      run.residualCursorKeys,
      [],
      "a completed source must leave no cursor behind"
    );
  } finally {
    await medium.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-5161: a store edited while the app was closed is replayed in full, never fast-forwarded", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-batch-resume-moved-"));
  const medium = await openCursorMedium();
  try {
    // The safety bound on the fix above. Within one pass, a session edited
    // underneath the cursor is caught by `markSourceImported` refusing to
    // advance a fingerprint that moved. Across a restart that protection is
    // gone — this pass's snapshot is captured AFTER the relaunch, so the edit
    // is already baked into it — and a fast-forward would seal the store with
    // the edited session stale until its mtime/size moves again.
    const run = await runQuitAndRelaunch(dir, FINGERPRINT_AFTER_EDIT, medium);

    assert.equal(
      new Set(run.importedIds).size,
      BATCH_SESSION_COUNT,
      "every session in the store must still end up imported"
    );
    assert.equal(
      run.importedIds.length,
      BATCH_SESSION_COUNT + IMPORTS_BEFORE_QUIT,
      "a moved store must degrade to a full replay, so no edited session is skipped"
    );
    // Specifically: the very first session, the one a stale cursor would skip.
    assert.equal(
      run.importedIds.filter((id) => id === "batch-0").length,
      2,
      "the session a stale cursor would have skipped must be re-imported"
    );
  } finally {
    await medium.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-5161 (review H3): drive THREE processes over one state dir. The first is
 * quit mid-backfill (so the cursor is written), the second's parse REJECTS, and
 * the third runs to completion. The store never moves, so the only thing that
 * could make the third process replay the prefix is the rejection having
 * destroyed the checkpoint.
 */
async function runQuitParseFailureRelaunch(
  dir: string,
  medium: CursorMedium
): Promise<{
  importedIds: string[];
  cursorKeysAfterFailure: string[];
}> {
  const store = join(dir, "opencode.db");
  writeFileSync(store, "{}\n");
  const importedIds: string[] = [];

  const buildCollector = (parseThrows: boolean): HarnessCollector => {
    const base = fakeCollector(OPENCODE, {
      batch: true,
      sources: [store],
      watchRoots: [dir],
      parse: (source) => {
        if (parseThrows) {
          // A locked OpenCode store: SQLITE_BUSY past the busy_timeout, or the
          // `hasSummaryColumns` PRAGMA throwing while someone is mid-write.
          return Promise.reject(new Error("SQLITE_BUSY: database is locked"));
        }
        return Promise.resolve(
          source === store
            ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
                makeSession({ sessionId: `batch-${index}` })
              )
            : []
        );
      },
    });
    return {
      ...base,
      // The store is quiet throughout, so the cursor is never invalidated by a
      // move: any replay here is the rejection's doing and nothing else.
      sourceFingerprint: () => FINGERPRINT_BEFORE_QUIT,
      markSourceImported: () => true,
    };
  };

  const managerOptions = (collector: HarnessCollector) => ({
    stateDir: dir,
    batchResumeCursorStore: medium.store,
    emit: () => {},
    getCollectionMode: () => "watcher" as const,
    cooperativeDelay: noopCooperativeDelay,
    catchupPollMs: null,
    log: () => {},
    watchDirectory: () => fakeFsWatcher(),
    collectors: [collector],
  });
  const recordImport = {
    importSession: (session: { sessionId: string }) => {
      importedIds.push(session.sessionId);
      return { skipped: false, reactivated: false };
    },
  };

  const quit = deferred();
  let firstManager: CollectorManager | null = null;
  let firstStopped: Promise<void> = Promise.resolve();
  firstManager = new CollectorManager({
    ...managerOptions(buildCollector(false)),
    importer: {
      importSession: (session) => {
        importedIds.push(session.sessionId);
        if (importedIds.length === IMPORTS_BEFORE_QUIT) {
          firstStopped = firstManager?.stop() ?? Promise.resolve();
          quit.resolve();
        }
        return { skipped: false, reactivated: false };
      },
    },
  });
  firstManager.start();
  await quit.promise;
  await firstStopped;

  const failedBoot = deferred();
  const failingManager = new CollectorManager({
    ...managerOptions(buildCollector(true)),
    importer: recordImport,
    onBootImportComplete: () => failedBoot.resolve(),
  });
  failingManager.start();
  await failedBoot.promise;
  await failingManager.stop();

  const cursorKeysAfterFailure = await medium.keys();

  const recoveredBoot = deferred();
  const recoveringManager = new CollectorManager({
    ...managerOptions(buildCollector(false)),
    importer: recordImport,
    onBootImportComplete: () => recoveredBoot.resolve(),
  });
  recoveringManager.start();
  await recoveredBoot.promise;
  await recoveringManager.stop();

  return {
    importedIds: importedIds.filter((id) => id.startsWith("batch-")),
    cursorKeysAfterFailure,
  };
}

test("ISS-5161: a parse rejection leaves the persisted cursor intact and the next pass still fast-forwards", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-batch-resume-throw-"));
  const medium = await openCursorMedium();
  try {
    const run = await runQuitParseFailureRelaunch(dir, medium);

    // A throw imported nothing, so the checkpoint still describes exactly what
    // the first process committed and must survive the retry. Dropping it here
    // is what turned one transient SQLITE_BUSY into a full replay from session
    // zero — and, under sustained writes, into a throw/wipe/replay loop.
    assert.deepEqual(
      run.cursorKeysAfterFailure,
      [`${OPENCODE} ${join(dir, "opencode.db")}`],
      "a source left for retry must keep its cursor"
    );
    assert.equal(
      new Set(run.importedIds).size,
      BATCH_SESSION_COUNT,
      "every session in the store must still end up imported"
    );
    // Same bound as the plain quit/relaunch case: only the session in flight at
    // the quit is re-read. The regression signature is BATCH_SESSION_COUNT +
    // IMPORTS_BEFORE_QUIT — the whole prefix replayed after the rejection.
    assert.equal(
      run.importedIds.length,
      BATCH_SESSION_COUNT + 1,
      `the pass after a parse rejection may replay only the session in flight at the quit: ${run.importedIds.length} writes for ${BATCH_SESSION_COUNT} sessions`
    );
  } finally {
    await medium.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-5161 (whitlockk review): an INCOMPLETE import committed only part of its
 * record groups and leaves the source unmarked for retry. Checkpointing it on
 * the resume cursor would make the next process SKIP it, let the clean suffix
 * finish the source, and then let `markSourceImported` seal the fingerprint
 * with the failed record group still missing — silently, until the store moves
 * again.
 *
 * Driven through two real CollectorManagers over one state dir: the first quits
 * mid-backfill AFTER one session imported incomplete, the second runs to
 * completion. The store never moves, so the only thing that can keep the
 * incomplete session out of the second process is a bad checkpoint.
 */
test("ISS-5161: an incomplete session is not checkpointed, so the retry survives a restart", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-5161-incomplete-checkpoint-"));
  const medium = await openCursorMedium();
  const store = join(dir, "opencode.db");
  writeFileSync(store, "{}\n");
  // Imported early enough that the quit below happens well after it, so the
  // session is genuinely a resumed-pass concern rather than the one in flight.
  const incompleteSessionId = "batch-3";

  const buildCollector = (): HarnessCollector => {
    const base = fakeCollector(OPENCODE, {
      batch: true,
      sources: [store],
      watchRoots: [dir],
      parse: (source) =>
        Promise.resolve(
          source === store
            ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
                makeSession({ sessionId: `batch-${index}` })
              )
            : []
        ),
    });
    return {
      ...base,
      sourceFingerprint: () => FINGERPRINT_BEFORE_QUIT,
      markSourceImported: () => true,
    };
  };

  try {
    const firstProcessIds: string[] = [];
    const quit = deferred();
    let firstManager: CollectorManager | null = null;
    let firstStopped: Promise<void> = Promise.resolve();
    firstManager = new CollectorManager({
      importer: {
        importSession: (session) => {
          firstProcessIds.push(session.sessionId);
          if (firstProcessIds.length === IMPORTS_BEFORE_QUIT) {
            firstStopped = firstManager?.stop() ?? Promise.resolve();
            quit.resolve();
          }
          // One tolerated record group failed to commit: the row exists, but the
          // session is NOT durably done and the source is left for retry.
          return {
            skipped: false,
            reactivated: false,
            incomplete: session.sessionId === incompleteSessionId,
          };
        },
      },
      stateDir: dir,
      batchResumeCursorStore: medium.store,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: () => {},
      watchDirectory: () => fakeFsWatcher(),
      collectors: [buildCollector()],
    });
    firstManager.start();
    await quit.promise;
    await firstStopped;

    assert.ok(
      firstProcessIds.includes(incompleteSessionId),
      "the first process must actually reach the incomplete session"
    );

    const secondProcessIds: string[] = [];
    const bootComplete = deferred();
    const secondManager = new CollectorManager({
      importer: {
        importSession: (session) => {
          secondProcessIds.push(session.sessionId);
          return { skipped: false, reactivated: false };
        },
      },
      stateDir: dir,
      batchResumeCursorStore: medium.store,
      emit: () => {},
      getCollectionMode: () => "watcher",
      cooperativeDelay: noopCooperativeDelay,
      catchupPollMs: null,
      log: () => {},
      onBootImportComplete: () => bootComplete.resolve(),
      watchDirectory: () => fakeFsWatcher(),
      collectors: [buildCollector()],
    });
    secondManager.start();
    await bootComplete.promise;
    await secondManager.stop();

    assert.ok(
      secondProcessIds.includes(incompleteSessionId),
      `the incomplete session must be retried by the next process, not skipped by the cursor: ${JSON.stringify(secondProcessIds)}`
    );
    // The rest of the first process's prefix IS durable, so the cursor must
    // still fast-forward past it — this is what keeps the fix from degenerating
    // into "checkpoint nothing".
    assert.equal(
      secondProcessIds.includes("batch-0"),
      false,
      "a fully-committed session from the first process must still be skipped"
    );
    assert.equal(
      new Set([...firstProcessIds, ...secondProcessIds]).size,
      BATCH_SESSION_COUNT,
      "every session in the store must still end up imported"
    );
  } finally {
    await medium.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-5161 (whitlockk review): the store fingerprint proves the SOURCE has not
 * moved; it says nothing about the SINK. `agent-dashboard.sqlite` is a sibling
 * path that can be rebuilt (a DB reset/migration) while the ingest state — the
 * cursor file included — survives. Fast-forwarding then skips ids out of an
 * EMPTY sink and `markSourceImported` seals the source over rows that were
 * never written.
 *
 * Drives quit + relaunch TWICE over two independent state dirs, differing only
 * in what the second process's sink reports: an intact sink must still
 * fast-forward (so the verification cannot degenerate into "never skip"), and a
 * rebuilt one must replay.
 */
async function runQuitAndRelaunchWithSink(
  dir: string,
  sinkAfterQuit: (writtenBeforeQuit: readonly string[]) => Set<string>,
  medium: CursorMedium
): Promise<{ firstProcessIds: string[]; secondProcessIds: string[] }> {
  const store = join(dir, "opencode.db");
  writeFileSync(store, "{}\n");

  const buildCollector = (): HarnessCollector => {
    const base = fakeCollector(OPENCODE, {
      batch: true,
      sources: [store],
      watchRoots: [dir],
      parse: (source) =>
        Promise.resolve(
          source === store
            ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
                makeSession({ sessionId: `batch-${index}` })
              )
            : []
        ),
    });
    return {
      ...base,
      sourceFingerprint: () => FINGERPRINT_BEFORE_QUIT,
      markSourceImported: () => true,
    };
  };

  const firstProcessIds: string[] = [];
  const quit = deferred();
  let firstManager: CollectorManager | null = null;
  let firstStopped: Promise<void> = Promise.resolve();
  firstManager = new CollectorManager({
    importer: {
      importSession: (session) => {
        firstProcessIds.push(session.sessionId);
        if (firstProcessIds.length === IMPORTS_BEFORE_QUIT) {
          firstStopped = firstManager?.stop() ?? Promise.resolve();
          quit.resolve();
        }
        return { skipped: false, reactivated: false };
      },
    },
    stateDir: dir,
    batchResumeCursorStore: medium.store,
    emit: () => {},
    getCollectionMode: () => "watcher",
    cooperativeDelay: noopCooperativeDelay,
    catchupPollMs: null,
    log: () => {},
    listExistingSessionIds: () => Promise.resolve(new Set<string>()),
    watchDirectory: () => fakeFsWatcher(),
    collectors: [buildCollector()],
  });
  firstManager.start();
  await quit.promise;
  await firstStopped;

  // Whatever the sink looks like when the app comes back: intact, or rebuilt.
  const sink = sinkAfterQuit(firstProcessIds);
  const secondProcessIds: string[] = [];
  const bootComplete = deferred();
  const secondManager = new CollectorManager({
    importer: {
      importSession: (session) => {
        secondProcessIds.push(session.sessionId);
        return { skipped: false, reactivated: false };
      },
    },
    stateDir: dir,
    batchResumeCursorStore: medium.store,
    emit: () => {},
    getCollectionMode: () => "watcher",
    cooperativeDelay: noopCooperativeDelay,
    catchupPollMs: null,
    log: () => {},
    onBootImportComplete: () => bootComplete.resolve(),
    listExistingSessionIds: () => Promise.resolve(sink),
    watchDirectory: () => fakeFsWatcher(),
    collectors: [buildCollector()],
  });
  secondManager.start();
  await bootComplete.promise;
  await secondManager.stop();

  return { firstProcessIds, secondProcessIds };
}

test("ISS-5161: a rebuilt sink is replayed, an intact one is still fast-forwarded", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const intactDir = mkdtempSync(join(tmpdir(), "iss-5161-sink-intact-"));
  const rebuiltDir = mkdtempSync(join(tmpdir(), "iss-5161-sink-rebuilt-"));
  // Two independent mediums, because these are two independent machines: a
  // cursor written by the intact run must not be visible to the rebuilt one.
  const intactMedium = await openCursorMedium();
  const rebuiltMedium = await openCursorMedium();
  try {
    // Control: the sink still holds everything the first process wrote, so the
    // cursor must fast-forward exactly as before.
    const intact = await runQuitAndRelaunchWithSink(
      intactDir,
      (written) => new Set(written),
      intactMedium
    );
    assert.equal(
      intact.secondProcessIds.includes("batch-0"),
      false,
      "an intact sink must still fast-forward past the first process's prefix"
    );
    assert.equal(
      new Set([...intact.firstProcessIds, ...intact.secondProcessIds]).size,
      BATCH_SESSION_COUNT,
      "every session must still end up imported when the sink is intact"
    );

    // The bug: agent-dashboard.sqlite was rebuilt while the cursor survived, so
    // the ids the cursor wants to skip are not in the sink at all.
    const rebuilt = await runQuitAndRelaunchWithSink(
      rebuiltDir,
      () => new Set<string>(),
      rebuiltMedium
    );
    assert.equal(
      rebuilt.secondProcessIds.includes("batch-0"),
      true,
      `a rebuilt sink must be replayed, not fast-forwarded past: ${JSON.stringify(rebuilt.secondProcessIds)}`
    );
    assert.equal(
      new Set(rebuilt.secondProcessIds).size,
      BATCH_SESSION_COUNT,
      "a rebuilt sink must be refilled with the WHOLE store, not just the tail"
    );
  } finally {
    await intactMedium.close();
    await rebuiltMedium.close();
    rmSync(intactDir, { recursive: true, force: true });
    rmSync(rebuiltDir, { recursive: true, force: true });
  }
});

/** One source's persisted checkpoint, as the cursor payload stores it. */
type PersistedCursorEntry = { fingerprint: string; sessionIds: string[] };

/**
 * A fake forked db-host child that EXECUTES the cursor's store op against a real
 * database instead of recording it. Enough of the protocol for this suite: Init
 * is answered Ready, Close is acknowledged, and an Invoke runs the production op
 * body. Replies are deferred a microtask so the client has registered its
 * correlation entry before one lands.
 */
function makeCursorDbHostChild(prisma: DesktopPrisma) {
  let messageListener: DbHostChildMessageListener | undefined;
  const reply = (message: unknown): void => {
    queueMicrotask(() => messageListener?.(message));
  };
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: DbHostRequest): void {
      if (message.kind === DbHostRequestKind.Init) {
        reply({ kind: DbHostResponseKind.Ready, id: message.id });
        return;
      }
      if (message.kind === DbHostRequestKind.Close) {
        reply({ kind: DbHostResponseKind.Result, id: message.id, ok: true });
        return;
      }
      if (message.kind !== DbHostRequestKind.Invoke) {
        return;
      }
      const { id, op, args } = message;
      runIngestBatchResumeCursorStoreOp(
        prisma,
        op.slice(DB_HOST_STORE_OP_PREFIX.length),
        args
      ).then(
        (value) =>
          reply({ kind: DbHostResponseKind.Result, id, ok: true, value }),
        (error: unknown) =>
          reply({
            kind: DbHostResponseKind.Result,
            id,
            ok: false,
            error: { message: String(error) },
          })
      );
    },
    kill(): void {
      /* the client kills the child at the end of close(); nothing to release */
    },
  };
  return child;
}

/**
 * The cursor store reached the way PRODUCTION reaches it on the main thread:
 * the lifecycle's `rawStoreOp` (a `store:`-prefixed invoke) onto a real
 * `DbHostClient`, which holds the ISS-4713 intentional-shutdown gate AND
 * decides what may still cross it (`db-host-shutdown-admission.ts`). The direct `sqliteBatchResumeCursorStore` above
 * skips that hop, so it cannot see this window at all.
 */
async function openClosingDbHostCursorMedium(): Promise<{
  store: BatchResumeCursorStore;
  beginClosing: () => void;
  cursors: () => Promise<Record<string, PersistedCursorEntry> | null>;
  close: () => Promise<void>;
}> {
  const { db, prisma, close } = await openTestPrisma();
  const client = new DbHostClient({
    onEmit: () => {},
    onLog: () => {},
    fork: () => makeCursorDbHostChild(prisma),
  });
  await client.start({ dataDir: join(tmpdir(), "iss-9839-db-host") });
  const rawStoreOp = (name: string, args: unknown[] = []): Promise<unknown> =>
    client.invoke(`${DB_HOST_STORE_OP_PREFIX}${name}`, args);
  return {
    store: createIngestBatchResumeCursorStore({
      prisma,
      invokeStoreOp: rawStoreOp,
    }),
    beginClosing: () => client.beginClosing(),
    cursors: async () => {
      const rows = await db.query<{ cursors: string }>(
        'SELECT "cursors" FROM "ingest_batch_resume_cursor"'
      );
      const cursors = rows.rows.at(0)?.cursors;
      return cursors === undefined
        ? null
        : (JSON.parse(cursors) as Record<string, PersistedCursorEntry>);
    },
    close: async () => {
      await client.close();
      await close();
    },
  };
}

/**
 * One process, quit the way the app quits: the db-host intentional-shutdown
 * window is opened FIRST (ISS-4713 requires that ordering), and only then are
 * the capture services torn down — which is what runs the cursor's terminal
 * flush. Returns what the first process imported and what SQLite holds after it.
 */
async function runQuitInsideShutdownWindow(
  dir: string,
  medium: Awaited<ReturnType<typeof openClosingDbHostCursorMedium>>
): Promise<{
  importedIds: string[];
  persisted: Record<string, PersistedCursorEntry> | null;
  logs: string[];
}> {
  const store = join(dir, "opencode.db");
  writeFileSync(store, "{}\n");
  const importedIds: string[] = [];
  const logs: string[] = [];
  const base = fakeCollector(OPENCODE, {
    batch: true,
    sources: [store],
    watchRoots: [dir],
    parse: (source) =>
      Promise.resolve(
        source === store
          ? Array.from({ length: BATCH_SESSION_COUNT }, (_unused, index) =>
              makeSession({ sessionId: `batch-${index}` })
            )
          : []
      ),
  });
  const quit = deferred();
  let manager: CollectorManager | null = null;
  let stopped: Promise<void> = Promise.resolve();
  manager = new CollectorManager({
    importer: {
      importSession: (session) => {
        importedIds.push(session.sessionId);
        if (importedIds.length === IMPORTS_BEFORE_QUIT) {
          // The user quits. `beginClosing()` before the teardown is the ISS-4713
          // ordering the app is committed to, NOT an artifact of this test:
          // desktop-application-shutdown.ts opens the window first so a db-host
          // exit from here on is expected, then awaits stopAgentCapture().
          medium.beginClosing();
          stopped = manager?.stop() ?? Promise.resolve();
          quit.resolve();
        }
        return { skipped: false, reactivated: false };
      },
    },
    stateDir: dir,
    batchResumeCursorStore: medium.store,
    emit: () => {},
    getCollectionMode: () => "watcher",
    cooperativeDelay: noopCooperativeDelay,
    catchupPollMs: null,
    log: (message) => {
      logs.push(message);
    },
    watchDirectory: () => fakeFsWatcher(),
    collectors: [
      {
        ...base,
        sourceFingerprint: () => FINGERPRINT_BEFORE_QUIT,
        markSourceImported: () => true,
      },
    ],
  });
  manager.start();
  await quit.promise;
  await stopped;
  return { importedIds, persisted: await medium.cursors(), logs };
}

test("ISS-9839: the terminal flush lands even though the quit opened the db-host shutdown window first", {
  timeout: TEST_CASE_TIMEOUT_MS,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "iss-9839-shutdown-window-"));
  const medium = await openClosingDbHostCursorMedium();
  try {
    const run = await runQuitInsideShutdownWindow(dir, medium);

    // ISS-9914: both symptoms of a refused terminal flush in ONE assertion — the
    // lost cursor tail, and the failure it reported on the monitored
    // `collector …` channel on every quit-during-backfill.
    const entries = Object.values(run.persisted ?? {});
    assert.deepEqual(
      {
        persistedSources: entries.length,
        flushFailures: run.logs.filter((line) => line.includes("flush failed")),
      },
      { persistedSources: 1, flushFailures: [] },
      `the quit must persist the in-flight source's cursor and report no flush failure: ${JSON.stringify(run.persisted)}`
    );
    const recorded = entries[0]?.sessionIds ?? [];
    // A prefix of what the first process committed, never a session it did
    // not: the cursor may lag the database (that replays a session) and must
    // never lead it (that would skip one).
    assert.ok(
      recorded.length > 0,
      "the persisted cursor must name the sessions the quit was interrupting"
    );
    assert.deepEqual(
      recorded.filter((id) => !run.importedIds.includes(id)),
      [],
      "the cursor must not name a session that was never imported"
    );
  } finally {
    await medium.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
