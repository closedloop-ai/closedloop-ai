/**
 * @file sync-watermark-durability.test.ts
 * @description ISS-8758 (whitlockk on #6383, threads PRRT_kwDOQ4gDpM6eJPTh /
 * PRRT_kwDOQ4gDpM6eJPTl): the two failure modes of the `sessions.updated_at`
 * sync-watermark bump the isolated import path writes when a change lands that
 * the session's synced metadata blob does not carry.
 *
 * A. A LOST BUMP WAS PERMANENT. The bump used to run in its own tolerant
 *    `sync_watermark` group, after the group that committed the change. All three
 *    signals feeding it — `eventsChanged` (ISS-8699), `linksChanged` (FEA-2729 /
 *    FEA-3227), `invocationSetChanged` (ISS-5801) — are before/after observations
 *    of state the same pass committed, so they are NOT reproducible: the retry
 *    re-read identical durable state, computed `false`, and never re-attempted the
 *    bump. The session stayed behind the incremental cursor forever. The fix folds
 *    the bump into the change's own transaction, so the pair is all-or-nothing and
 *    the retry re-derives the observation.
 *
 * B. A SAME-TIMESTAMP BUMP WAS A NO-OP. The write was
 *    `updated_at = MAX(updated_at, now)`, so a stored value already equal to `now`
 *    was written back unchanged — and the scan is
 *    `updated_at > $cursor OR (updated_at = $cursor AND id NOT IN <observed>)`,
 *    which excludes an already-observed row at the tied top timestamp. The change
 *    silently stayed local.
 *
 * Every test drives the REAL ingest path (`db.importer.importSession`) against a
 * live SQLite store and reads selection back through the REAL scan
 * (`listUpdatedSessionCursorRows`). Defect A is proved by fault injection: a
 * SQLite trigger that ABORTs any advance of this session's `updated_at`, which
 * fails whichever group attempts the bump. Under the pre-fix arrangement that
 * group was `sync_watermark` and the change had already committed; the retry
 * assertions below are what that leaves red.
 *
 * The clock is INJECTED (`openTestDb({ now })`), not faked at the process level:
 * `openSqliteAgentDatabase` takes `now` as a seam and never reads the wall clock
 * on this path, so injection is what actually pins the import's `now` — including
 * the deliberate tie in the defect-B tests, where the second import reuses the
 * first import's exact timestamp.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { NORMALIZED_PR_LINK_METHOD } from "../src/main/database/pr-link-maintenance.js";
import {
  advanceSessionSyncWatermark,
  sessionSyncWatermarkTarget,
} from "../src/main/database/session-sync-watermark.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";
import {
  selectedSince,
  updatedAtOf,
} from "./session-sync-cursor-test-utils.js";

const SESSION_ID = "iss8758-session";
/** Inside RECENT_ACTIVITY_MS of every clock below, so the row stays live throughout. */
const LIVE_FILE_MTIME_MS = Date.parse("2026-06-07T11:59:00.000Z");
const FIRST_IMPORT_AT = "2026-06-07T12:00:00.000Z";
/**
 * The millisecond after FIRST_IMPORT_AT, written as its own literal rather than
 * derived from the clock the fix reads — a fold that computes the successor
 * wrongly must not be able to compute the expectation wrongly in the same way.
 */
const FIRST_IMPORT_TIE_BREAK = "2026-06-07T12:00:00.001Z";
const BLOCKED_IMPORT_AT = "2026-06-07T12:01:00.000Z";
const RETRY_IMPORT_AT = "2026-06-07T12:02:00.000Z";
const SETTLED_REIMPORT_AT = "2026-06-07T12:03:00.000Z";
/** The appended turn's own timestamp; it adds one `TurnDuration` event row. */
const APPENDED_TURN_AT = "2026-06-07T10:02:00.000Z";

const BLOCK_WATERMARK_TRIGGER = "iss8758_block_watermark_advance";
const BLOCK_LINK_DELETE_TRIGGER = "iss8758_block_link_delete";
const BLOCK_PR_LINK_INSERT_TRIGGER = "iss8758_block_pr_link_insert";
const EVENTS = "events";
const ARTIFACT_LINKS = "session_artifact_links";
const INVOCATIONS = "agent_component_invocations";
/** An unparseable stored timestamp; the degrade path is reachable from a legacy row. */
const UNORDERABLE_CLOCK = "not-a-timestamp";
/**
 * The last millisecond `toISOString`'s four-digit-year form can express. Its
 * `+1ms` successor is `+010000-01-01T00:00:00.000Z`, and SQLite TEXT sorts `+`
 * before `9`, so stepping there would move the row BEHIND the cursor.
 */
const MAX_FOUR_DIGIT_YEAR_CLOCK = "9999-12-31T23:59:59.999Z";
/** One millisecond below the boundary — still steps normally, inside the form. */
const NEAR_MAX_FOUR_DIGIT_YEAR_CLOCK = "9999-12-31T23:59:59.998Z";

type Db = SqliteAgentDatabase;

/** What the seed import left behind, for the test to assert as its precondition. */
type SeededState = {
  skipped: boolean;
  updatedAt: string;
  owedToCloud: string[];
};

/** What a blocked-watermark import left behind, for the test to assert. */
type BlockedImportState = {
  incomplete: boolean | undefined;
  failedGroups: readonly string[] | undefined;
  updatedAt: string;
};

/**
 * The base fixture: a live session that owns one artifact link (its `main`
 * branch) and one component invocation (a `Read` tool use), so the same row can
 * exercise all three watermark signals.
 */
function liveSession(): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    fileModifiedAt: LIVE_FILE_MTIME_MS,
    toolUses: [
      {
        id: "toolu_read_1",
        providerToolUseId: "toolu_read_1",
        name: "Read",
        kind: "builtin",
        timestamp: "2026-06-07T10:00:01.000Z",
      },
    ],
  });
}

/**
 * The base fixture with no recent file activity, so the import lands it
 * `inactive` — the terminal state the stored-row rebuild admits.
 */
function terminalSession(): NormalizedSession {
  return { ...liveSession(), fileModifiedAt: null };
}

/**
 * The base fixture plus a referenced pull request, so the pull-requests phase
 * mints a `normalized_pr` link of its own — the slice that phase exclusively
 * owns, and (since ISS-8905) exclusively tears down.
 */
function prLinkedSession(): NormalizedSession {
  const base = liveSession();
  return {
    ...base,
    artifacts: {
      ...base.artifacts,
      prs: [{ number: "8758", repo: "closedloop-ai/closedloop-ai" }],
    },
  };
}

/** An event-only append: one `TurnDuration` row, no metadata-blob change. */
function withAppendedTurn(session: NormalizedSession): NormalizedSession {
  return {
    ...session,
    turnDurations: [{ durationMs: 4200, timestamp: APPENDED_TURN_AT }],
  };
}

function write(db: Db, sql: string, ...params: unknown[]): Promise<unknown> {
  return db.prisma.write((client) => client.$executeRawUnsafe(sql, ...params));
}

function countRows(db: Db, table: string): Promise<number> {
  return db.prisma.client
    .$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = $1`,
      SESSION_ID
    )
    .then((rows) => Number(rows[0]?.n ?? 0));
}

function clearRows(db: Db, table: string): Promise<unknown> {
  return write(db, `DELETE FROM ${table} WHERE session_id = $1`, SESSION_ID);
}

async function withDb(
  run: (db: Db, setClock: (at: string) => void) => Promise<void>
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8758-"));
  let clock = FIRST_IMPORT_AT;
  // allowImportFailures: a DELIBERATELY failed group is this suite's subject —
  // the teardown assertion exists to catch UNINTENDED swallowed import failures,
  // and every test asserts on the failure it injected instead.
  const db = await openTestDb(
    dir,
    { now: () => clock },
    { allowImportFailures: true }
  );
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
 * Import the base fixture and report the state the caller asserts as its
 * precondition: the row landed, its watermark is the seed clock, and the cursor
 * has already delivered it — so every later selection assertion is about the
 * change under test rather than about the seed.
 */
async function seedDeliveredSession(
  db: Db,
  session: NormalizedSession = liveSession()
): Promise<SeededState> {
  const result = await db.importer.importSession(session, "claude");
  return {
    skipped: result.skipped,
    updatedAt: await updatedAtOf(db, SESSION_ID),
    owedToCloud: await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
  };
}

/**
 * Import `input` with an advance of this session's watermark aborted at the
 * engine, then lift the block. `UPDATE OF updated_at` fires only when the column
 * is in the SET list, and the `IS NOT` guard narrows it to a real advance — in
 * every scenario here the metadata blob is unchanged, so the gate writes no
 * watermark and the bump is the only statement the trigger can catch.
 */
async function importWithWatermarkBlocked(
  db: Db,
  setClock: (at: string) => void,
  input: NormalizedSession
): Promise<BlockedImportState> {
  await write(
    db,
    `CREATE TRIGGER ${BLOCK_WATERMARK_TRIGGER}
     BEFORE UPDATE OF updated_at ON sessions
     FOR EACH ROW WHEN NEW.id = '${SESSION_ID}' AND NEW.updated_at IS NOT OLD.updated_at
     BEGIN SELECT RAISE(ABORT, 'ISS-8758 injected watermark failure'); END`
  );
  setClock(BLOCKED_IMPORT_AT);
  const blocked = await db.importer.importSession(input, "claude");
  await write(db, `DROP TRIGGER ${BLOCK_WATERMARK_TRIGGER}`);
  return {
    incomplete: blocked.incomplete,
    failedGroups: blocked.failedGroups,
    updatedAt: await updatedAtOf(db, SESSION_ID),
  };
}

/**
 * The state a blocked import must leave: the group that COMMITS the change is
 * the group that failed (shared fate), and the watermark has not moved.
 */
function blockedBy(group: string): BlockedImportState {
  return {
    incomplete: true,
    failedGroups: [group],
    updatedAt: FIRST_IMPORT_AT,
  };
}

const DELIVERED_SEED: SeededState = {
  skipped: false,
  updatedAt: FIRST_IMPORT_AT,
  owedToCloud: [],
};

test("ISS-8758: an event append survives a failed watermark write and re-arms the cursor on the next import", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredSession(db), DELIVERED_SEED);
    const eventsBefore = await countRows(db, EVENTS);
    const appended = withAppendedTurn(liveSession());

    assert.deepEqual(
      await importWithWatermarkBlocked(db, setClock, appended),
      blockedBy("events")
    );
    assert.equal(
      await countRows(db, EVENTS),
      eventsBefore,
      "the appended event rolled back WITH the bump — an event that commits without its bump is unrecoverable"
    );

    setClock(RETRY_IMPORT_AT);
    await db.importer.importSession(appended, "claude");

    assert.equal(
      await countRows(db, EVENTS),
      eventsBefore + 1,
      "the retry re-derives the append"
    );
    assert.equal(await updatedAtOf(db, SESSION_ID), RETRY_IMPORT_AT);
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session after the retry"
    );
  });
});

test("ISS-8758: an artifact-link change survives a failed watermark write and re-arms the cursor on the next import", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredSession(db), DELIVERED_SEED);
    assert.equal(
      await countRows(db, ARTIFACT_LINKS),
      1,
      "precondition: the fixture owns a branch link"
    );
    // A link set that must be re-derived — the FEA-3227 shape: the session's
    // payload is byte-identical, only its durable link rows differ.
    await clearRows(db, ARTIFACT_LINKS);

    assert.deepEqual(
      await importWithWatermarkBlocked(db, setClock, liveSession()),
      blockedBy("artifact_links")
    );
    assert.equal(
      await countRows(db, ARTIFACT_LINKS),
      0,
      "the re-derived link rolled back WITH the bump"
    );

    setClock(RETRY_IMPORT_AT);
    await db.importer.importSession(liveSession(), "claude");

    assert.equal(await countRows(db, ARTIFACT_LINKS), 1);
    assert.equal(await updatedAtOf(db, SESSION_ID), RETRY_IMPORT_AT);
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session after the retry"
    );
  });
});

test("ISS-8758: an invocation-set change survives a failed watermark write and re-arms the cursor on the next import", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredSession(db), DELIVERED_SEED);
    assert.equal(
      await countRows(db, INVOCATIONS),
      1,
      "precondition: the fixture owns one invocation"
    );
    // The ISS-5801 shape: a deriver that first materializes a session's
    // invocations while its synced payload is unchanged.
    await clearRows(db, INVOCATIONS);

    assert.deepEqual(
      await importWithWatermarkBlocked(db, setClock, liveSession()),
      blockedBy("component_invocations")
    );
    assert.equal(
      await countRows(db, INVOCATIONS),
      0,
      "the re-materialized invocation rolled back WITH the bump"
    );

    setClock(RETRY_IMPORT_AT);
    await db.importer.importSession(liveSession(), "claude");

    assert.equal(await countRows(db, INVOCATIONS), 1);
    assert.equal(await updatedAtOf(db, SESSION_ID), RETRY_IMPORT_AT);
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session after the retry"
    );
  });
});

test("ISS-8758: an event append on the stored watermark's own timestamp still leaves the session selectable", async () => {
  await withDb(async (db) => {
    assert.deepEqual(await seedDeliveredSession(db), DELIVERED_SEED);

    // The clock is NOT advanced: the import's `now` is exactly the stored
    // `updated_at`, the live-hook interleaving the monotonic MAX exists to
    // tolerate. `MAX(stored, now)` writes the stored value back.
    await db.importer.importSession(withAppendedTurn(liveSession()), "claude");

    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      FIRST_IMPORT_TIE_BREAK,
      "a tie must step forward one millisecond, not write the stored value back"
    );
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the tied-top NOT IN exclusion makes an unmoved watermark permanently unselectable"
    );
  });
});

test("ISS-8758: an artifact-link change on the stored watermark's own timestamp still leaves the session selectable", async () => {
  await withDb(async (db) => {
    assert.deepEqual(await seedDeliveredSession(db), DELIVERED_SEED);
    await clearRows(db, ARTIFACT_LINKS);

    await db.importer.importSession(liveSession(), "claude");

    assert.equal(await countRows(db, ARTIFACT_LINKS), 1);
    assert.equal(await updatedAtOf(db, SESSION_ID), FIRST_IMPORT_TIE_BREAK);
    assert.deepEqual(await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]), [
      SESSION_ID,
    ]);
  });
});

test("ISS-8758: an invocation-set change on the stored watermark's own timestamp still leaves the session selectable", async () => {
  await withDb(async (db) => {
    assert.deepEqual(await seedDeliveredSession(db), DELIVERED_SEED);
    await clearRows(db, INVOCATIONS);

    await db.importer.importSession(liveSession(), "claude");

    assert.equal(await countRows(db, INVOCATIONS), 1);
    assert.equal(await updatedAtOf(db, SESSION_ID), FIRST_IMPORT_TIE_BREAK);
    assert.deepEqual(await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]), [
      SESSION_ID,
    ]);
  });
});

test("ISS-8758: the tie step is once, not per pass — a settled re-import on a later clock leaves the watermark pinned", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(await seedDeliveredSession(db), DELIVERED_SEED);
    const appended = withAppendedTurn(liveSession());
    await db.importer.importSession(appended, "claude");
    assert.equal(await updatedAtOf(db, SESSION_ID), FIRST_IMPORT_TIE_BREAK);

    // The same input again on a LATER clock. Nothing durable changed, so nothing
    // may move — a bump keyed on anything other than a real delta would stamp
    // SETTLED_REIMPORT_AT here, and a tie rule that fires unconditionally would
    // step again.
    setClock(SETTLED_REIMPORT_AT);
    const settled = await db.importer.importSession(appended, "claude");

    assert.equal(settled.skipped, true, "the repeat writes nothing durable");
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      FIRST_IMPORT_TIE_BREAK,
      "the watermark must stay pinned to the append, not advance to the repeat's clock"
    );
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_TIE_BREAK, [SESSION_ID]),
      [],
      "a settled session must not be re-selected — that is the update loop"
    );
  });
});

test("ISS-8758: a PR-owned link change bumps the watermark that an artifact-links-only fingerprint would miss", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedDeliveredSession(db, prLinkedSession()),
      DELIVERED_SEED
    );
    // The `normalized_pr` rows are the pull-requests phase's OWN slice — the
    // half of the method partition only that phase writes. Clearing just that
    // slice isolates the `ownedByPullRequestPhase: true` half of the
    // fingerprint — the branch link the artifact-links phase owns is untouched.
    await write(
      db,
      `DELETE FROM ${ARTIFACT_LINKS} WHERE session_id = $1 AND method = $2`,
      SESSION_ID,
      NORMALIZED_PR_LINK_METHOD
    );
    const branchLinksBefore = await countRows(db, ARTIFACT_LINKS);

    setClock(RETRY_IMPORT_AT);
    await db.importer.importSession(prLinkedSession(), "claude");

    assert.equal(
      await countRows(db, ARTIFACT_LINKS),
      branchLinksBefore + 1,
      "the pull-requests phase must restore its own link"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      RETRY_IMPORT_AT,
      "a PR-only link change is watermark-worthy — an artifact-links-only partition would miss it"
    );
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session"
    );
  });
});

test("ISS-8758: a failed artifact-links group still lets the pull-requests phase detect and bump its own link change", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedDeliveredSession(db, prLinkedSession()),
      DELIVERED_SEED
    );
    await write(
      db,
      `DELETE FROM ${ARTIFACT_LINKS} WHERE session_id = $1 AND method = $2`,
      SESSION_ID,
      NORMALIZED_PR_LINK_METHOD
    );

    // Abort the artifact-links phase at its opening DELETE, so it rolls back
    // wholesale. The pull-requests phase must still run and still see its own
    // slice correctly: it snapshots at the head of its OWN transaction, which
    // the rollback has returned to the inherited state. The trigger cannot also
    // catch that phase's teardown here — the PR-owned slice was cleared above,
    // so its DELETE matches no row and the per-row trigger never fires.
    await write(
      db,
      `CREATE TRIGGER ${BLOCK_LINK_DELETE_TRIGGER}
       BEFORE DELETE ON ${ARTIFACT_LINKS}
       FOR EACH ROW WHEN OLD.session_id = '${SESSION_ID}'
       BEGIN SELECT RAISE(ABORT, 'ISS-8758 injected artifact-links failure'); END`
    );
    setClock(RETRY_IMPORT_AT);
    const partial = await db.importer.importSession(
      prLinkedSession(),
      "claude"
    );
    await write(db, `DROP TRIGGER ${BLOCK_LINK_DELETE_TRIGGER}`);

    assert.deepEqual(
      partial.failedGroups,
      ["artifact_links"],
      "only the artifact-links group may fail — the pull-requests group must still run"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      RETRY_IMPORT_AT,
      "the surviving phase's own link change must still reach the cursor"
    );
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the incremental scan must re-select the session"
    );
  });
});

/*
 * ISS-8905 CHANGED THE BEHAVIOR THIS TEST PINS, so its expectation moved with it.
 *
 * It used to assert the compensating half of ISS-8758: the artifact-links group
 * had already COMMITTED its DELETE of the PR-owned slice, so a failed
 * pull-requests group left the rows durably gone with the bump that described
 * them rolled back — and a best-effort `pr_link_teardown_watermark` group
 * published the loss out-of-band. ISS-8905 removed the split that made that
 * necessary: the pull-requests phase now tears down and rebuilds its own slice in
 * ONE transaction, so a failure rolls the teardown back too and there is nothing
 * left to compensate for.
 *
 * What survives unchanged is the CONTRACT the ISS-8758 half of the pair owes: a
 * failed group must not leave a durable change with no bump. The assertion below
 * is that contract restated against the atomic arrangement — no durable change,
 * therefore no bump owed. The all-or-nothing rollback itself, and the retirement
 * case that made the old split silent, are covered in
 * `pr-link-teardown-atomicity.test.ts`.
 */
test("ISS-8758/ISS-8905: a failed pull-requests group leaves neither a durable teardown nor an unbumped change behind", async () => {
  await withDb(async (db, setClock) => {
    assert.deepEqual(
      await seedDeliveredSession(db, prLinkedSession()),
      DELIVERED_SEED
    );
    const prLinksSeeded = await countRows(db, ARTIFACT_LINKS);

    // Abort the pull-requests phase at the one INSERT only it issues. Since
    // ISS-8905 its DELETE of the same slice rides this transaction, so the
    // rollback takes the teardown with it.
    await write(
      db,
      `CREATE TRIGGER ${BLOCK_PR_LINK_INSERT_TRIGGER}
       BEFORE INSERT ON ${ARTIFACT_LINKS}
       FOR EACH ROW WHEN NEW.session_id = '${SESSION_ID}'
         AND NEW.method = '${NORMALIZED_PR_LINK_METHOD}'
       BEGIN SELECT RAISE(ABORT, 'ISS-8758 injected pull-requests failure'); END`
    );
    setClock(RETRY_IMPORT_AT);
    const partial = await db.importer.importSession(
      prLinkedSession(),
      "claude"
    );
    await write(db, `DROP TRIGGER ${BLOCK_PR_LINK_INSERT_TRIGGER}`);

    assert.deepEqual(
      partial.failedGroups,
      ["pull_requests"],
      "only the pull-requests group may fail — the artifact-links group owns no part of this slice"
    );
    assert.equal(
      await countRows(db, ARTIFACT_LINKS),
      prLinksSeeded,
      "the PR-owned link is still there: the failed group rolled its own teardown back"
    );
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      FIRST_IMPORT_AT,
      "no durable change survived the failure, so no bump is owed and none is lost"
    );
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [],
      "an unchanged session must not be re-selected"
    );
  });
});

test("ISS-8758: the stored-row invocation rebuild advances the watermark off a tie, not just the import path", async () => {
  await withDb(async (db) => {
    // The rebuild only admits a TERMINAL session carrying a STALE revision
    // (`staleRebuildSkip`), so the fixture drops `fileModifiedAt` to land
    // `inactive` and the call asks for the next revision.
    assert.deepEqual(
      await seedDeliveredSession(db, terminalSession()),
      DELIVERED_SEED
    );
    // The rebuild derives the invocation set from stored rows only, so clearing
    // them is what makes its re-materialization a real set change. The clock is
    // NOT advanced, so the rebuild's own `now` ties the stored watermark — the
    // second call site of the shared helper, on the same defect.
    await clearRows(db, INVOCATIONS);

    const rebuilt = await db.rebuildComponentInvocationsFromStoredRows(
      SESSION_ID,
      effectiveDataRevision() + 1
    );

    assert.equal(rebuilt.needsResync, true, "the invocation set changed");
    assert.equal(
      await updatedAtOf(db, SESSION_ID),
      FIRST_IMPORT_TIE_BREAK,
      "the rebuild path must take the same tie step as the import path"
    );
    assert.deepEqual(
      await selectedSince(db, FIRST_IMPORT_AT, [SESSION_ID]),
      [SESSION_ID],
      "the rebuilt session must re-enter the incremental cursor"
    );
  });
});

test("ISS-8758: the watermark target always moves strictly past the stored value, and never persists an unorderable one", () => {
  assert.equal(
    sessionSyncWatermarkTarget(RETRY_IMPORT_AT, FIRST_IMPORT_AT),
    RETRY_IMPORT_AT,
    "a stored value behind the clock advances to the clock"
  );
  assert.equal(
    sessionSyncWatermarkTarget(FIRST_IMPORT_AT, null),
    FIRST_IMPORT_AT,
    "an absent stored value advances to the clock"
  );
  assert.equal(
    sessionSyncWatermarkTarget(FIRST_IMPORT_AT, FIRST_IMPORT_AT),
    FIRST_IMPORT_TIE_BREAK,
    "a tie steps to the next representable millisecond"
  );
  assert.equal(
    sessionSyncWatermarkTarget(FIRST_IMPORT_AT, RETRY_IMPORT_AT),
    "2026-06-07T12:02:00.001Z",
    "a value already AHEAD of the clock — a live-hook bump, or an earlier phase of this same pass — still steps, so a cursor that already observed the row there re-selects it"
  );
  assert.equal(
    sessionSyncWatermarkTarget(FIRST_IMPORT_AT, NEAR_MAX_FOUR_DIGIT_YEAR_CLOCK),
    MAX_FOUR_DIGIT_YEAR_CLOCK,
    "the last step that stays inside the four-digit-year form is still taken"
  );
  // Both of these used to answer `now`. That was a LEXICAL REGRESSION, not a
  // degrade: `now` sorts BELOW a `9999-…` (and below any non-timestamp), so
  // writing it neither re-selects the row nor leaves it where it was, and can
  // drop it behind cursors it was ahead of. `null` is "do not write".
  assert.equal(
    sessionSyncWatermarkTarget(FIRST_IMPORT_AT, MAX_FOUR_DIGIT_YEAR_CLOCK),
    null,
    "at the year-10000 boundary there is no orderable successor, so no write is authorized"
  );
  assert.equal(
    sessionSyncWatermarkTarget(FIRST_IMPORT_AT, UNORDERABLE_CLOCK),
    null,
    "a stored value the column's ordering cannot compare authorizes no write either"
  );
});

test("ISS-8758: an unadvanceable watermark is LEFT ALONE — the advance issues no UPDATE at all", async () => {
  // davetho on #6457: refusing the fabricated successor is only half of it.
  // The target is what the caller WRITES, so a non-null fallback is still a
  // write — this asserts at the statement level that none is issued, which is
  // the only place the difference between "declined" and "clobbered" shows.
  for (const stored of [MAX_FOUR_DIGIT_YEAR_CLOCK, UNORDERABLE_CLOCK]) {
    const written: RecordedWrite[] = [];
    await advanceSessionSyncWatermark(
      recordingTx(stored, written),
      SESSION_ID,
      FIRST_IMPORT_AT
    );

    assert.deepEqual(
      written,
      [],
      `a stored ${stored} must leave the column untouched, not be overwritten with a value that sorts below it`
    );
  }

  // The control: the same seam DOES write when an orderable successor exists,
  // so the assertion above is about the boundary and not about a stub that
  // never writes anything.
  const advanced: RecordedWrite[] = [];
  await advanceSessionSyncWatermark(
    recordingTx(FIRST_IMPORT_AT, advanced),
    SESSION_ID,
    FIRST_IMPORT_AT
  );

  assert.deepEqual(advanced, [
    {
      sql: "UPDATE sessions SET updated_at = $1 WHERE id = $2",
      params: [FIRST_IMPORT_TIE_BREAK, SESSION_ID],
    },
  ]);
});

/** One statement the advance issued, so an absent write is observable as `[]`. */
type RecordedWrite = { sql: string; params: unknown[] };

/** The exact transaction seam `advanceSessionSyncWatermark` narrows its arg to. */
type WatermarkTx = Parameters<typeof advanceSessionSyncWatermark>[0];

/**
 * A transaction double whose row read is pinned and whose writes are recorded.
 *
 * Deliberately NOT the live store: the question is whether an UPDATE is ISSUED,
 * and a real SQLite row cannot tell "the column was left alone" from "it was
 * rewritten with the value it already held".
 */
function recordingTx(
  storedUpdatedAt: string | null,
  written: RecordedWrite[]
): WatermarkTx {
  return {
    $queryRawUnsafe: (() =>
      Promise.resolve([
        { updated_at: storedUpdatedAt },
      ])) as unknown as WatermarkTx["$queryRawUnsafe"],
    $executeRawUnsafe: ((sql: string, ...params: unknown[]) => {
      written.push({ sql, params });
      return Promise.resolve(1);
    }) as unknown as WatermarkTx["$executeRawUnsafe"],
  };
}
