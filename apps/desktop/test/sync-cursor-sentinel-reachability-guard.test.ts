/**
 * @file sync-cursor-sentinel-reachability-guard.test.ts
 * @description ISS-9269: a TRIPWIRE, not a description of current behaviour.
 *
 * WHY THIS FILE EXISTS. ISS-8904 ("import groups publish the sync watermark
 * before dependent phases commit") proposes a one-line fix that looks obviously
 * right: have `listUpdatedSessionCursorRows` (`database/sync-source.ts`) exclude
 * rows still parked at `DATA_REVISION_IMPORT_PENDING`, since that sentinel is
 * exactly "this import has not sealed yet". An ISS-8904 lane built that mutation
 * and probed it. It does not defer the row — it STRANDS it, permanently, from
 * the sync lane. Nothing else in this repository reddens when it is applied.
 * This file is the only thing standing between that predicate and `main`.
 *
 * DO NOT delete or weaken these cases to make a cursor-level sentinel filter
 * pass. A red assertion here means the change under test drops a session on the
 * floor, not that the expectation is stale.
 *
 * THE INVARIANT. A session parked at the import sentinel must remain reachable
 * by the sync lane after a no-bump reseal.
 *
 * WHY EXCLUSION IS UNRECOVERABLE, in four facts that are each load-bearing:
 *   1. `revision_seal` (`write-core.ts`) is
 *      `UPDATE sessions SET data_revision = $1 WHERE id = $2 AND data_revision = $3`.
 *      It NEVER touches `updated_at`. A seal therefore cannot re-pend a row that
 *      has already fallen behind the cursor.
 *   2. `feedIncrementalCursorRows` derives `nextTopUpdatedAt` from the RETURNED
 *      rows, so an EXCLUDED row does not hold the watermark back — any co-scanned
 *      sibling at a later stamp carries the cursor straight past it. That sibling
 *      is why these tests seed a second session; without it the exclusion looks
 *      harmless because the watermark never moves and the row is re-offered next
 *      tick.
 *   3. Only a row admitted by a live cursor scan carries a stamp
 *      (`agent-session-sync-cursor-prefix.ts`), so a never-admitted row cannot
 *      hold the durable boundary either.
 *   4. There is no rescue path: `runInitialBackfillWalk` returns early once a
 *      cursor exists, and the data-revision rebuild only selects
 *      `data_revision != DATA_REVISION` — which the seal has just repaired.
 *
 * This is the same shape `apps/desktop/src/main/sync/AGENTS.md` already forbids
 * one layer up ("never a durable `withheld` mark, because the reseal stamps only
 * `data_revision` without bumping `updated_at`"). These cases extend that
 * documented invariant down to the cursor layer, where it was unenforced.
 *
 * WHAT IS REAL HERE. The store (`openTestDb`), the ingest (`db.importer.
 * importSession`), the cursor scan (`db.syncSource.listUpdatedSessionCursorRows`)
 * and the queue/watermark fold (`feedIncrementalCursorRows`) are all the
 * production code, wired in the production order and with the production
 * arguments — `runIncrementalPass` below mirrors `enqueueIncrementalUpdates` in
 * `agent-session-sync-service.ts` statement for statement. The ONLY seeded state
 * is the sentinel park itself (a direct `data_revision` write), which is how
 * `import-revision-seal-orphan-heal.test.ts` (R2) also stands a row up "as an
 * interrupted import would leave it"; reproducing the eviction that parks it is
 * that file's subject, not this one's, and the park is a precondition rather
 * than the behaviour under test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { feedIncrementalCursorRows } from "../src/main/agent-sync/incremental-cursor-feed.js";
import { DATA_REVISION_IMPORT_PENDING } from "../src/main/collectors/engine/data-revision.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { Harness } from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

/** The session that gets parked at the sentinel — the one at risk of stranding. */
const PARKED_ID = "iss9269-parked-at-sentinel";
/**
 * The co-scanned healthy sibling. Its LATER `updated_at` is the whole mechanism:
 * it is what carries `nextTopUpdatedAt` past the parked row, so an exclusion is
 * permanent rather than merely deferred to the next tick.
 */
const SIBLING_ID = "iss9269-healthy-sibling";

/** Inside RECENT_ACTIVITY_MS (10 min) of every clock below, so no row goes stale
 * and no import travels the reactivation path — reactivation writes `updated_at`
 * and would supply a bump these cases must prove is absent. */
const LIVE_FILE_MTIME_MS = Date.parse("2026-06-07T11:59:00.000Z");
/** The ISS-8904 probe's own timestamps: parked at 12:00, sibling at 12:05. */
const PARKED_IMPORT_AT = "2026-06-07T12:00:00.000Z";
const SIBLING_IMPORT_AT = "2026-06-07T12:05:00.000Z";
/** The repair pass, deliberately LATER than the sibling's stamp so a bump — if
 * one happened — would be unambiguously visible to the next scan. */
const REPAIR_AT = "2026-06-07T12:06:00.000Z";
/** A cold cursor: strictly before both imports, so the first scan co-scans both. */
const COLD_WATERMARK = "2026-06-07T11:00:00.000Z";

type Db = SqliteAgentDatabase;

/**
 * The sync lane's live cursor position plus the queue state the fold appends to
 * — the exact fields `agent-session-sync-service.ts` hands
 * `feedIncrementalCursorRows` from itself.
 */
type LaneCursor = {
  watermark: string;
  observedTopIds: Set<string>;
  incrementalQueue: string[];
  incrementalQueuedIds: Set<string>;
  backfillQueuedIds: Set<string>;
  queuedUpdatedAtById: Map<string, string>;
};

function coldCursor(): LaneCursor {
  return {
    watermark: COLD_WATERMARK,
    observedTopIds: new Set<string>(),
    incrementalQueue: [],
    incrementalQueuedIds: new Set<string>(),
    backfillQueuedIds: new Set<string>(),
    queuedUpdatedAtById: new Map<string, string>(),
  };
}

/**
 * One production incremental pass: the REAL cursor scan followed by the REAL
 * admission/watermark fold, with the advance applied back to the cursor exactly
 * as `enqueueIncrementalUpdates` applies it. Returns the ids newly admitted to
 * the incremental queue by THIS pass.
 */
async function runIncrementalPass(
  db: Db,
  cursor: LaneCursor
): Promise<string[]> {
  const rows = await db.syncSource.listUpdatedSessionCursorRows(
    cursor.watermark,
    [...cursor.observedTopIds]
  );
  const advance = feedIncrementalCursorRows(
    {
      incrementalQueue: cursor.incrementalQueue,
      incrementalQueuedIds: cursor.incrementalQueuedIds,
      backfillQueuedIds: cursor.backfillQueuedIds,
      queuedUpdatedAtById: cursor.queuedUpdatedAtById,
    },
    rows,
    cursor.watermark,
    cursor.observedTopIds
  );
  cursor.watermark = advance.nextTopUpdatedAt;
  cursor.observedTopIds = advance.nextTopIds;
  return advance.newlyQueued;
}

function liveSession(
  sessionId: string,
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return makePopulatedSession({
    sessionId,
    fileModifiedAt: LIVE_FILE_MTIME_MS,
    ...overrides,
  });
}

/**
 * The row's stored sync watermark. Returns a literal sentinel rather than
 * asserting, so a missing row fails the CALLER's comparison with the id in the
 * message (the convention the sibling cursor suites use).
 */
async function updatedAtOf(db: Db, sessionId: string): Promise<string> {
  const rows = await db.syncSource.listAllSessionCursorRows();
  return (
    rows.find((row) => row.id === sessionId)?.updated_at ??
    `<absent: ${sessionId}>`
  );
}

async function dataRevisionOf(db: Db, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ data_revision: number }>
  >("SELECT data_revision FROM sessions WHERE id = $1", sessionId);
  const raw = rows[0]?.data_revision;
  return raw == null ? Number.NaN : Number(raw);
}

/** Park a row at the import sentinel, as an evicted mid-flight import leaves it. */
async function parkAtSentinel(db: Db, sessionId: string): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE sessions SET data_revision = $1 WHERE id = $2",
      DATA_REVISION_IMPORT_PENDING,
      sessionId
    )
  );
}

async function withDb(
  run: (db: Db, setClock: (at: string) => void) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss9269-"));
  let clock = PARKED_IMPORT_AT;
  const db = await openTestDb(dir, { now: () => clock });
  try {
    await run(db, (at: string) => {
      clock = at;
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The observable state the seed produced, read back off the store. Compared
 * against {@link EXPECTED_SEED} inside each case (Biome's
 * `noMisplacedAssertion` keeps assertions out of helpers), so a fixture that
 * silently stopped producing this state fails on the precondition rather than
 * making a downstream assertion vacuously true.
 */
type SeededFacts = {
  parkedImportSkipped: boolean;
  siblingImportSkipped: boolean;
  parkedDataRevision: number;
  parkedUpdatedAt: string;
  siblingUpdatedAt: string;
};

const EXPECTED_SEED: SeededFacts = {
  parkedImportSkipped: false,
  siblingImportSkipped: false,
  parkedDataRevision: DATA_REVISION_IMPORT_PENDING,
  parkedUpdatedAt: PARKED_IMPORT_AT,
  siblingUpdatedAt: SIBLING_IMPORT_AT,
};

/**
 * Seed the shared fixture: the parked row at `PARKED_IMPORT_AT` stamped back to
 * the sentinel, and the healthy sibling at the strictly LATER
 * `SIBLING_IMPORT_AT`.
 */
async function seedParkedRowAndLaterSibling(
  db: Db,
  setClock: (at: string) => void
): Promise<SeededFacts> {
  setClock(PARKED_IMPORT_AT);
  const parked = await db.importer.importSession(
    liveSession(PARKED_ID),
    Harness.Claude
  );
  await parkAtSentinel(db, PARKED_ID);

  setClock(SIBLING_IMPORT_AT);
  const sibling = await db.importer.importSession(
    liveSession(SIBLING_ID),
    Harness.Claude
  );

  return {
    parkedImportSkipped: parked.skipped,
    siblingImportSkipped: sibling.skipped,
    parkedDataRevision: await dataRevisionOf(db, PARKED_ID),
    parkedUpdatedAt: await updatedAtOf(db, PARKED_ID),
    siblingUpdatedAt: await updatedAtOf(db, SIBLING_ID),
  };
}

test("ISS-9269 GUARD: a sentinel-parked session co-scanned with a later sibling must still be queued — excluding DATA_REVISION_IMPORT_PENDING from the cursor scan strands it permanently", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedParkedRowAndLaterSibling(db, setClock),
      EXPECTED_SEED,
      "precondition: both imports wrote, and the parked row really is at the import sentinel with the sibling's stamp ahead of it"
    );
    assert.ok(
      EXPECTED_SEED.siblingUpdatedAt > EXPECTED_SEED.parkedUpdatedAt,
      "precondition: the sibling is STRICTLY LATER — it is what carries the watermark past the parked row"
    );

    const cursor = coldCursor();
    const everQueued = new Set<string>();

    // PASS 1 — the co-scan. On `main` the cursor returns both rows and the fold
    // admits both. Under a sentinel-exclusion predicate it returns the sibling
    // ONLY, and the sibling's later stamp still advances the watermark.
    const firstPass = await runIncrementalPass(db, cursor);
    for (const id of firstPass) {
      everQueued.add(id);
    }
    assert.ok(
      firstPass.includes(SIBLING_ID),
      "precondition: the healthy sibling WAS co-scanned in the same pass — without it this case cannot observe the stranding at all"
    );
    assert.equal(
      cursor.watermark,
      SIBLING_IMPORT_AT,
      "the sibling carried the watermark to its own stamp"
    );
    assert.ok(
      cursor.watermark > PARKED_IMPORT_AT,
      "the watermark is now STRICTLY PAST the parked row — a row not admitted in this pass can never be offered by a later scan"
    );

    // THE RESEAL. A byte-identical re-import of a sentinel-parked row takes the
    // revision-only branch: `sessionDataChanged` is `contentChanged` alone, so
    // nothing bumps `updated_at`, while `revisionStamped` is
    // `contentChanged || revisionChanged` — so the seal DOES promote the row off
    // the sentinel. This is the no-bump reseal, and it is the path that matters:
    // the row becomes healthy and simultaneously loses every reason to be
    // re-offered.
    setClock(REPAIR_AT);
    const reseal = await db.importer.importSession(
      liveSession(PARKED_ID),
      Harness.Claude
    );
    assert.equal(
      reseal.skipped,
      true,
      "the reseal is a byte-identical re-import — it writes no content at all"
    );
    assert.equal(
      await dataRevisionOf(db, PARKED_ID),
      effectiveDataRevision(),
      "the reseal DID promote the row off the sentinel, so the data-revision rebuild will never revisit it"
    );
    assert.equal(
      await updatedAtOf(db, PARKED_ID),
      PARKED_IMPORT_AT,
      "THE LOAD-BEARING FACT: `revision_seal` never touches `updated_at`, so the reseal did NOT re-pend the row"
    );

    // PASS 2 — after the reseal, from the advanced watermark. There is nothing
    // left to select: the row is healthy, behind the cursor, and invisible to
    // both the backfill walk (a cursor exists) and the revision rebuild (it is
    // at DATA_REVISION).
    const secondPass = await runIncrementalPass(db, cursor);
    for (const id of secondPass) {
      everQueued.add(id);
    }
    assert.equal(
      secondPass.includes(PARKED_ID),
      false,
      "no rescue path: the reseal bumped nothing, so the post-reseal scan cannot re-offer the row"
    );

    // THE TRIPWIRE. `main` reaches here with the parked id queued by pass 1. Add
    // a `data_revision != DATA_REVISION_IMPORT_PENDING` term to
    // `listUpdatedSessionCursorRows` and this flips false — the ISS-8904 probe
    // recorded exactly this as `A EVER QUEUED? true -> false`. That is a session
    // permanently absent from the cloud, not a deferred one.
    assert.equal(
      everQueued.has(PARKED_ID),
      true,
      "a sentinel-parked session must be queued by SOME pass; excluding the sentinel from listUpdatedSessionCursorRows strands it from the sync lane forever"
    );
  });
});

test("ISS-9269 CONTROL: from the stranded cursor state only a CONTENT-CHANGED repair re-queues the parked row — the bump the no-bump reseal provably does not make", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedParkedRowAndLaterSibling(db, setClock),
      EXPECTED_SEED,
      "precondition: the same seeded fixture as the GUARD case"
    );

    // The cursor state a sentinel-exclusion predicate LEAVES BEHIND: the sibling
    // was admitted at its own stamp and carried the watermark there, and the
    // parked row was never admitted at all. Constructed directly rather than by
    // mutating production code, so this case can stand alongside the GUARD case
    // on an unmodified tree.
    const cursor = coldCursor();
    cursor.watermark = SIBLING_IMPORT_AT;
    cursor.observedTopIds = new Set([SIBLING_ID]);

    assert.deepEqual(
      await runIncrementalPass(db, cursor),
      [],
      "from the stranded state the scan offers nothing — the parked row sits behind the watermark"
    );

    // The same repair moment as the GUARD case's reseal, but this import
    // genuinely changes content (`nextName !== existing.name` is one of the three
    // `contentChanged` signals), so the gate takes the content branch and writes
    // the strictly-forward watermark instead of the revision-only stamp.
    setClock(REPAIR_AT);
    const changed = await db.importer.importSession(
      liveSession(PARKED_ID, { name: "Renamed by a later parse" }),
      Harness.Claude
    );
    assert.equal(changed.skipped, false, "a name change is real content");
    assert.equal(
      await dataRevisionOf(db, PARKED_ID),
      effectiveDataRevision(),
      "the content-changed import also seals the row off the sentinel"
    );
    assert.equal(
      await updatedAtOf(db, PARKED_ID),
      REPAIR_AT,
      "the content branch DOES bump the watermark — this is the difference that decides reachability"
    );

    // What makes the GUARD case's `everQueued` assertion non-vacuous: this
    // harness CAN queue the parked row on a later pass, but ONLY when something
    // bumps `updated_at`. The GUARD case proves the reseal is not that something,
    // so a row excluded from the co-scan has no later pass to be caught by.
    assert.deepEqual(
      await runIncrementalPass(db, cursor),
      [PARKED_ID],
      "a bumped row lands past the watermark and is re-selected — the only repair shape that rescues a stranded session"
    );
  });
});
