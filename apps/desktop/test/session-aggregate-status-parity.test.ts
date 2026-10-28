import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DISPLAYED_STATUS_PARITY_CASES } from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterAll, describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { countSqliteSessionsForFilters } from "../src/main/database/session-aggregate-filters.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import { recomputeSessionLastActivityAt } from "../src/main/database/write-core.js";
import { servedSessionActivityAt } from "../src/main/session/session-activity-anchor.js";
import { parseSessionDate } from "../src/main/session/session-instant.js";
import { matchesStatusFilter } from "../src/main/session/session-status-filter-match.js";
import { projectDisplayedSharedStatus } from "../src/main/session/shared-agent-session-status.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import {
  parityCaseEndedAt,
  recentActivityAt,
  staleActivityAt,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-4559: the desktop usage/count SQL fast path and the hydrated JS fold must
 * bucket the SAME row identically.
 *
 * These are one cohort — the summary cards and the FEA-4142 count badge aggregate
 * exactly the population the table lists — so a row the two paths disagree about
 * appears in the table under a facet the cards above it do not count. That is a
 * reconciliation defect, not a rounding difference.
 *
 * Both sides are EXECUTED over the shared cross-surface oracle: the SQL against a
 * real SQLite database (the dialect that actually runs it, so operator-precedence
 * or NULL-handling surprises surface here rather than in production), the fold by
 * calling the matcher. Asserting the rendered clause's shape instead would pass
 * just as happily on a predicate that returns the wrong rows — the same blind
 * spot that let ISS-4559 through the existing tests.
 */

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

// The session start every case seeds unless it is testing the absence of one.
// Earlier than both markers below, so a row's stored timestamps stay a coherent
// chronology now that `started_at` is the recompute's floor rather than a value
// the seeded `last_activity_at` overrode.
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const AWAITING_AT = "2026-01-01T01:30:00.000Z";
/** Not a date in any shape: `Date` NaNs on it and `julianday()` answers NULL. */
const UNPARSABLE_ENDED_AT = "not-a-date";
let opened: { db: SqliteDb; dir: string } | null = null;

async function openDb(): Promise<SqliteDb> {
  if (!opened) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "session-status-parity-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "api",
      now: () => "2026-06-07T12:00:00.000Z",
    });
    opened = { db, dir };
  }
  return opened.db;
}

afterAll(async () => {
  if (opened) {
    const { db, dir } = opened;
    opened = null;
    // ISS-4556: close BEFORE removing the directory, as every sibling suite does
    // (`shared-agent-sessions-usage-aggregation.test.ts`). An open SQLite handle
    // keeps its boot-maintenance timers alive, which hangs the `test:node` lane
    // with no failing assertion to point at, and recursively removing a
    // WAL-open directory out from under a live connection is its own hazard.
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * One row at a time: the count read is corpus-wide, so a clean table per case
 * keeps "count === 1" an unambiguous membership answer. The child `events` go
 * with it — they are the activity input now, so a leftover event would seed the
 * next case's anchor.
 */
async function clearSessions(db: SqliteDb): Promise<void> {
  await db.run("DELETE FROM events");
  await db.run("DELETE FROM sessions");
}

/**
 * Seed ONE row and let PRODUCTION derive its `last_activity_at`.
 *
 * ISS-6798: the activity input a case seeds is an `events.created_at` (or, for
 * an event-less row, `started_at`), and the column is written by
 * {@link recomputeSessionLastActivityAt} — the statement every ingest
 * transaction runs — rather than by a literal this file chose. That is what
 * makes the column an OUTPUT of the contract instead of a value copied from the
 * JS fixture beside it, and {@link hydrate} is the other half of the same rule:
 * the two paths are compared on what the production derivations make of one
 * seeded row.
 *
 * `AWAITING_AT` stays a fixed literal: every predicate on both paths tests it
 * for PRESENCE (`IS NULL` / `Boolean(...)`), never against the activity anchor,
 * so it is a marker rather than a chronology. The same now holds for
 * `ended_at`: no predicate on either path compares it against the anchor.
 */
async function insertRow(
  db: SqliteDb,
  id: string,
  rawStatus: string,
  awaitingInput: boolean,
  endedAt: string | null,
  eventAts: readonly string[],
  startedAt: string | null = STARTED_AT
): Promise<void> {
  await db.run(
    `INSERT INTO sessions
       (id, status, started_at, updated_at, ended_at, harness, billing_mode, awaiting_input_since, ends_with_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    id,
    rawStatus,
    startedAt,
    "2026-01-01T01:00:00.000Z",
    endedAt,
    "claude",
    "api",
    awaitingInput ? AWAITING_AT : null,
    null
  );
  for (const [index, eventAt] of eventAts.entries()) {
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES ($1, $2, $3, $4)`,
      `${id}-event-${index}`,
      id,
      "tool_use",
      eventAt
    );
  }
  // ISS-5366: `last_activity_at` is NOT NULL with an EPOCH default and the
  // ACTIVE/STALE partition reads that bare column, so the INSERT above omits it
  // deliberately — the recompute, not this file, decides what it holds.
  await db.prisma.write((client) => recomputeSessionLastActivityAt(client, id));
}

/**
 * Whether the seeded row is in the facet, decided by the PRODUCTION count read
 * (`countSqliteSessionsForFilters` — the FEA-4142 badge path, which renders the
 * same predicate the usage/analytics aggregate uses) against real SQLite. Each
 * case seeds exactly one row, so a count of 1 means "matched".
 */
async function sqlMatches(db: SqliteDb, facet: string): Promise<boolean> {
  const count = await countSqliteSessionsForFilters(db.prisma, {
    status: facet,
  } as Parameters<typeof countSqliteSessionsForFilters>[1]);
  return count === 1;
}

/**
 * The HYDRATED half of the same seeded row, loaded through the PRODUCTION list
 * hydrate (`loadSyncedSessions` -> `assembleSyncedSessions`) rather than
 * assembled here.
 *
 * ISS-6798: this was a `sessionFor` helper that set `lastActivityAt` to the very
 * literal `insertRow` wrote into `last_activity_at`, and a comment called that
 * mirroring a virtue. It is not. In production the hydrated anchor is the
 * EVENT-DERIVED max floored at `started_at` — the full list hydrate does not
 * read the stored column at all unless it loaded no events
 * (`preferStoredLastActivityAt`, `sync-source.ts`) — while the SQL twin reads
 * that column. Stored-vs-derived is therefore the one dimension on which these
 * two predicates can disagree about staleness, and copying one into the other
 * equalized it away: the same blindness-BY-CONSTRUCTION the shared oracle
 * records for ISS-4556, one column over.
 *
 * It also never set `startedAt`, so the anchor's `started_at` fallback rung was
 * unreached by every case in the sweep even though `insertRow` always seeded the
 * column. A hydrated row carries both fields, so both rungs are now live.
 */
async function hydrate(db: SqliteDb, id: string): Promise<SyncedAgentSession> {
  const [session] = await createSqliteSessionSyncSource(
    db.prisma
  ).loadSyncedSessions([id], emptyAttributionCache());
  if (!session) {
    // Not an assertion: the hydrate IS the fixture here, so an empty result is a
    // broken seed rather than a contract failure, and must not be reported as
    // one of the parity expectations below.
    throw new Error(`no hydrated session for ${id}`);
  }
  return session;
}

describe("usage-aggregate status predicate parity (ISS-4559)", () => {
  test("the SQL fast path buckets every oracle row exactly as the hydrated fold does", async () => {
    const db = await openDb();
    for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
      await clearSessions(db);
      // ISS-4556: the anchor is driven by the oracle rather than pinned fresh,
      // because staleness is exactly the dimension on which the ACTIVE and
      // STALE predicates could disagree. ISS-6798: it is seeded ONCE, as the
      // row's own event, and each path then derives its own reading of it —
      // the SQL half through the recompute into `last_activity_at`, the
      // hydrated half through the assembler's event fold.
      const parityActivityAt = parityCase.staleAnchor
        ? staleActivityAt()
        : recentActivityAt();
      await insertRow(
        db,
        "parity-row",
        parityCase.rawStatus,
        parityCase.awaitingInput,
        parityCaseEndedAt(parityCase),
        [parityActivityAt],
        STARTED_AT
      );
      const session = await hydrate(db, "parity-row");
      // ISS-4556: the row's OWN stored status joins the sweep. It is the only
      // filter that reaches the INACTIVE branch and the raw-status fallback,
      // where the SQL fast path and the hydrated fold spelled "terminal" two
      // different ways — the literal `('inactive','failed')` here against
      // `TERMINAL_SHARED_STATUSES` there.
      //
      // It is its OWN pair, read from `matchedByRawStatusFacet`, and NOT a
      // string appended to `FACETS` and resolved through a facet→expectation
      // lookup. Ten of the thirteen oracle cases store a `rawStatus` that IS
      // one of the four sweep facets, so a lookup-with-fallback answered those
      // ten from the facet field and never read the raw-status field at all —
      // flipping `matchedByRawStatusFacet` on the first case reddened both
      // sibling consumers and left this suite green. Three suites reading one
      // shared table while disagreeing about which column governs a facet is
      // exactly the drift the table exists to prevent, so this states the pair
      // explicitly, as `displayed-status-parity.test.ts` and
      // `shared-agent-sessions-status-facet.test.ts` both do.
      // ISS-10629: the WAITING/STALE/UNKNOWN rows went with the branches they
      // asserted, on BOTH paths in one change — which is the property this
      // suite exists for, so the SQL twin and the hydrated fold are still
      // compared over every row that remains.
      for (const [facet, expected] of [
        [SESSION_STATUS.ACTIVE, parityCase.matchedByActiveFacet],
        // The two TERMINAL facets, asked directly: ISS-11239 rules that
        // neither returns a row storing `active`, whatever end it carries, and
        // these two pairs are what redden if either twin unions it back in.
        [SESSION_STATUS.INACTIVE, parityCase.matchedByInactiveFacet],
        [SESSION_STATUS.ERROR, parityCase.matchedByErrorFacet],
        [parityCase.rawStatus, parityCase.matchedByRawStatusFacet],
      ] as const) {
        assert.equal(
          matchesStatusFilter(session, facet),
          expected,
          `hydrated ${facet}: ${parityCase.name}`
        );
        assert.equal(
          await sqlMatches(db, facet),
          expected,
          `SQL ${facet}: ${parityCase.name}`
        );
      }
    }
  });

  // ISS-10741: the ticket's acceptance criterion, stated without the oracle.
  //
  // The sweep above reads its verdicts from a shared table, so if that table is
  // wrong about Active every surface asserting against it agrees and goes green
  // together — the failure mode `agent-session-displayed-status-parity.test.ts`
  // exists to watch for. These two rows carry their expectations inline, so the
  // claim survives the table being edited.
  //
  // Before ISS-10741 the desktop ACTIVE arm subtracted exactly these two
  // projections, so both rows were reachable under no desktop facet at all
  // while cloud returned them under Active (ISS-9939).
  //
  // ISS-10364 (operator ruling 2026-09-23): the badge no longer distinguishes
  // an awaiting-input or long-silent row from an ordinary stored `active` one
  // — `projectDisplayedSharedStatus` returns `active` for both. Kept as a
  // counterfactual (a `WAITING`/`STALE` badge here would mean one of the
  // retired projections came back) alongside the facet assertions, which this
  // test is otherwise about and which the ruling did not touch.
  test("a row awaiting input or long silent over a stored `active` still badges and facets Active", async () => {
    const db = await openDb();
    for (const [name, awaitingInput, activityAt] of [
      ["waiting-row", true, recentActivityAt()],
      ["stale-row", false, staleActivityAt()],
    ] as const) {
      await clearSessions(db);
      await insertRow(db, name, SESSION_STATUS.ACTIVE, awaitingInput, null, [
        activityAt,
      ]);
      const session = await hydrate(db, name);

      // The badge first: without it the two assertions below hold on a row that
      // merely displays Active, which is the case this test is not about.
      assert.equal(
        projectDisplayedSharedStatus(session),
        SESSION_STATUS.ACTIVE,
        `badge: ${name}`
      );
      assert.equal(
        matchesStatusFilter(session, SESSION_STATUS.ACTIVE),
        true,
        `hydrated active: ${name}`
      );
      assert.equal(
        await sqlMatches(db, SESSION_STATUS.ACTIVE),
        true,
        `SQL active: ${name}`
      );

      // And the terminal facets do NOT also claim it — the subtraction moved to
      // Active, it was not duplicated into a second bucket.
      for (const terminal of [
        SESSION_STATUS.INACTIVE,
        SESSION_STATUS.ERROR,
      ] as const) {
        assert.equal(
          matchesStatusFilter(session, terminal),
          false,
          `hydrated ${terminal}: ${name}`
        );
        assert.equal(
          await sqlMatches(db, terminal),
          false,
          `SQL ${terminal}: ${name}`
        );
      }
    }
  });

  // ISS-10741 (whitlockk, PR #7677): a NON-NULL but unparsable `ended_at`. SQL's
  // `julianday()` once turned it into a NULL that dropped the row out of Active
  // while the hydrated twin kept it. ISS-11239 removed the `ended_at` read from
  // both status predicates, so the row stays in Active on stored status alone;
  // this case pins that no predicate that reads the column comes back without
  // agreeing. The oracle cannot carry this shape — every case there names a
  // parseable instant — so it is seeded inline.
  test("a stored `active` row whose recorded end is unparsable stays in Active on both paths", async () => {
    const db = await openDb();
    await clearSessions(db);
    await insertRow(
      db,
      "unparsable-end",
      SESSION_STATUS.ACTIVE,
      false,
      UNPARSABLE_ENDED_AT,
      [recentActivityAt()]
    );
    const session = await hydrate(db, "unparsable-end");

    assert.equal(matchesStatusFilter(session, SESSION_STATUS.ACTIVE), true);
    assert.equal(await sqlMatches(db, SESSION_STATUS.ACTIVE), true);

    // Neither terminal facet may claim it: it stores `active`.
    for (const terminal of [
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
    ] as const) {
      assert.equal(
        matchesStatusFilter(session, terminal),
        false,
        `hydrated ${terminal}`
      );
      assert.equal(await sqlMatches(db, terminal), false, `SQL ${terminal}`);
    }
  });

  // ISS-6798: the dimension this suite used to equalize away — the STORED
  // `last_activity_at` column against the anchor the list hydrate DERIVES.
  //
  // The sweep above can only compare the two predicates honestly if the two
  // paths receive the same instant, and nothing in the suite proved they do: the
  // old fixture wrote one literal into the column and copied it into the JS
  // session. Both halves are production reads of one seeded row now, so the
  // agreement is assertable — and it is asserted directly here rather than only
  // through the facet, because a divergence in the anchor is the INPUT defect,
  // visible on the served row and its Duration cell and its `lastActivity` sort
  // long before any facet folds on it.
  //
  // The shapes are the ones `insertRow`'s activity input can actually make
  // disagree: `sessions.started_at` is NULLABLE and free-form, and
  // `events.created_at` is too.
  //
  // NOT COVERED, and it is a TRADE rather than a gap: a `started_at` that is
  // DATE-PREFIX SHAPED but still unreadable (`2026-13-01T00:00:00Z`). The
  // recompute's GLOB accepts it, SQLite cannot canonicalize it, so the value
  // expression falls to `SESSION_LEGACY_LAST_ACTIVITY_AT_SQL` and BYTE-compares
  // the raw text against the events — where `2026-13…` outsorts every real
  // instant and lands in the column, which then reads as the epoch on the JS
  // side. Before this change the fold's NaN accumulator produced that same
  // epoch, so the two agreed on a value both had wrong; after it the fold
  // reports the session's actual last event and the COLUMN is the side left
  // wrong.
  //
  // That residual is `canonicalizeHealableTimestampSql`'s known ISS-5497 gap,
  // and closing it means moving the SQL anchor — a value
  // `SESSION_LAST_ACTIVITY_AT_VALUE_SQL` documents as one that must not move
  // backward, because the irreversible retention purge derives from it. Out of
  // this ticket's scope; asserted neither way here rather than pinned as
  // correct.
  test("the hydrated activity anchor is the instant the stored column holds", async () => {
    const db = await openDb();
    for (const [name, startedAt, eventAts] of [
      // The `?? startedAt` fallback rung: no activity input at all, so the
      // column takes the recompute's epoch sentinel and the hydrate has nothing
      // to derive from. Unreachable by the sweep, which seeds every row an
      // anchor.
      ["no anchor at all", null, []],
      // A readable start with no events — the column is the start floor.
      ["start floor only", STARTED_AT, []],
      // The event max wins over the start floor on both sides.
      ["events over the floor", STARTED_AT, [recentActivityAt()]],
      // ISS-6798: the shape the fold used to lose. An unreadable `started_at`
      // seeded the running max as `NaN`, and an unreadable EVENT ahead of the
      // real one was adopted outright by the `=== null` rung and re-poisoned it
      // — either way every later `eventEpoch > lastActivityEpoch` is false, so
      // the whole event stream was discarded and the raw string survived as the
      // hydrated anchor, while `last_activity_at` held the true event max.
      //
      // The leading `!` is load-bearing: the hydrate reads events `ORDER BY
      // created_at ASC` over the RAW column, so an unreadable value only reaches
      // the accumulator first if its text sorts below an ISO date.
      [
        "unreadable start and event",
        "not-a-timestamp",
        ["!not-a-timestamp", recentActivityAt()],
      ],
    ] as const) {
      await clearSessions(db);
      await insertRow(
        db,
        "anchor-row",
        SESSION_STATUS.ACTIVE,
        false,
        null,
        eventAts,
        startedAt
      );
      const session = await hydrate(db, "anchor-row");
      const [row] = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<{ last_activity_at: string }[]>(
          "SELECT last_activity_at FROM sessions WHERE id = $1",
          "anchor-row"
        )
      );
      assert.equal(
        // Compared as INSTANTS, through the same reading the producer serves
        // (`servedSessionActivityAt`) and the same one the SQL text denotes —
        // not as strings, because the recompute stores canonical UTC text while
        // the hydrate hands back the raw event string it read.
        servedSessionActivityAt(session).getTime(),
        parseSessionDate(row?.last_activity_at ?? "").getTime(),
        `${name}: the derived anchor must be the stored column's instant`
      );
    }
  });

  // ISS-5592: this case is named for the arm both twins used to carry, which
  // canonicalized a stored `running`. That arm is gone — no write path produced
  // the value, so the spelling is unrecognized like any other and answers
  // Unknown. See `canonicalSharedStatus` for the evidence.
  //
  // Removing the arm did not redden the case, because the case never reached
  // it: `insertRow` takes `(db, id, rawStatus, …)` and the old call passed
  // `"running"` as the ID and `SESSION_STATUS.ACTIVE` as the status. It seeded
  // an ordinary `active` row and asserted the Active facet returned it — a
  // tautology wearing the name of the fold it was meant to guard.
  //
  // So it is rewritten rather than deleted, and widened while the expectation
  // is being restated: it now stores the spelling it names, drives BOTH twins
  // (the old one executed the SQL path only, so re-adding the arm to one side
  // would still not have reddened it), and pins both facets the removal moved
  // the row between.
  test("an unrecognized stored spelling answers its own spelling, not Active, on both paths", async () => {
    const db = await openDb();
    await clearSessions(db);
    await insertRow(db, "running", "running", false, null, [
      recentActivityAt(),
    ]);
    const session = await hydrate(db, "running");
    // ISS-7838: this swept `for (const gate of [false, true])`. The SQL half
    // never read the loop variable — ISS-7019 made that predicate
    // unconditional — so it asserted the same row twice, and the hydrated half
    // was the only thing the gate still reached. With the dead parameter gone
    // there is one behavior to pin, and the two paths pin it together.
    //
    // ISS-10629: EXPECTATION CHANGED on the UNKNOWN row, deliberately. The
    // match-by-exclusion arm that gathered an unrecognized spelling under
    // Unknown was retired with the facet, so `unknown` now answers `false` and
    // the row is reachable by the literal spelling it stores. Both are kept as
    // counterfactuals: `unknown: true` would mean the arm came back, and
    // `active: true` would mean the fold started claiming a status it does not
    // recognize — the defect this case was rewritten to catch in the first
    // place.
    for (const [facet, expected] of [
      [SESSION_STATUS.ACTIVE, false],
      // Plain literal: ISS-10364 retired `DISPLAYED_SESSION_STATUS.UNKNOWN`.
      ["unknown", false],
      ["running", true],
    ] as const) {
      assert.equal(await sqlMatches(db, facet), expected, `SQL ${facet}`);
      assert.equal(
        matchesStatusFilter(session, facet),
        expected,
        `hydrated ${facet}`
      );
    }
  });
});
