import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { DISPLAYED_STATUS_PARITY_CASES } from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { countSqliteSessionsForFilters } from "../src/main/database/session-aggregate-filters.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { setDisplayedStatusParityResolver } from "../src/main/session/displayed-status-parity-gate.js";
import { matchesStatusFilter } from "../src/main/session/session-status-filter-match.js";
import {
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

const AWAITING_AT = "2026-01-01T01:30:00.000Z";
const ENDED_AT = "2026-01-01T02:00:00.000Z";
// ISS-4556: STALE and UNKNOWN join the sweep. They are where the two paths could
// still disagree — ACTIVE subtracts "displays as Waiting" while STALE used the
// wider "awaiting input", and UNKNOWN matched purely on an unrecognized status —
// so a sweep over ACTIVE/WAITING alone cannot see either gap.
const FACETS = [
  SESSION_STATUS.ACTIVE,
  DISPLAYED_SESSION_STATUS.WAITING,
  DISPLAYED_SESSION_STATUS.STALE,
  DISPLAYED_SESSION_STATUS.UNKNOWN,
] as const;

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

after(async () => {
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

async function insertRow(
  db: SqliteDb,
  id: string,
  rawStatus: string,
  awaitingInput: boolean,
  ended: boolean,
  staleAnchor = false
): Promise<void> {
  await db.run(
    `INSERT INTO sessions
       (id, status, started_at, updated_at, ended_at, harness, billing_mode, awaiting_input_since, last_activity_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    id,
    rawStatus,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T01:00:00.000Z",
    ended ? ENDED_AT : null,
    "claude",
    "api",
    awaitingInput ? AWAITING_AT : null,
    // ISS-5366: `last_activity_at` is NOT NULL with an EPOCH default, and the
    // ACTIVE/STALE partition reads that bare column — so a row that omits it is
    // stale by construction. ISS-4556: the anchor is now driven by the oracle
    // rather than pinned fresh, because staleness is exactly the dimension on
    // which the ACTIVE and STALE predicates could disagree.
    staleAnchor ? staleActivityAt() : recentActivityAt()
  );
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

function sessionFor(
  rawStatus: string,
  awaitingInput: boolean,
  ended: boolean,
  staleAnchor = false
): SyncedAgentSession {
  return {
    status: rawStatus,
    awaitingInputSince: awaitingInput ? AWAITING_AT : null,
    endedAt: ended ? ENDED_AT : null,
    // Mirrors the seeded row's anchor, so the two paths are compared on the same
    // input rather than one of them silently being judged stale.
    lastActivityAt: staleAnchor ? staleActivityAt() : recentActivityAt(),
  } as SyncedAgentSession;
}

describe("usage-aggregate status predicate parity (ISS-4559)", () => {
  // ISS-4556: every test states its own gate state. Relying on the previous
  // test's `finally` to leave the resolver OFF makes the gate-OFF cases pass for
  // a reason that has nothing to do with them — a `.only`, a reorder, or a
  // failure before the `finally` silently exercises the wrong branch.
  beforeEach(() => {
    setDisplayedStatusParityResolver(() => false);
  });

  test("the SQL fast path buckets every oracle row exactly as the hydrated fold does", async () => {
    const db = await openDb();
    setDisplayedStatusParityResolver(() => true);
    try {
      for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
        // One row at a time: the count read is corpus-wide, so a clean table per
        // case keeps "count === 1" an unambiguous membership answer.
        await db.run("DELETE FROM sessions");
        await insertRow(
          db,
          "parity-row",
          parityCase.rawStatus,
          parityCase.awaitingInput,
          parityCase.ended,
          parityCase.staleAnchor
        );
        const session = sessionFor(
          parityCase.rawStatus,
          parityCase.awaitingInput,
          parityCase.ended,
          parityCase.staleAnchor
        );
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
        for (const [facet, expected] of [
          [SESSION_STATUS.ACTIVE, parityCase.matchedByActiveFacet],
          [DISPLAYED_SESSION_STATUS.WAITING, parityCase.matchedByWaitingFacet],
          [DISPLAYED_SESSION_STATUS.STALE, parityCase.matchedByStaleFacet],
          [DISPLAYED_SESSION_STATUS.UNKNOWN, parityCase.matchedByUnknownFacet],
          [parityCase.rawStatus, parityCase.matchedByRawStatusFacet],
        ] as const) {
          assert.equal(
            matchesStatusFilter(session, facet, true),
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
    } finally {
      setDisplayedStatusParityResolver(() => false);
    }
  });

  test("the gate OFF reproduces the pre-ISS-4559 SQL, including the invisible row", async () => {
    // Closed-by-default rollout state: the ended + awaiting row is matched by
    // neither facet, byte-for-byte today's behavior. The hydrated fold agreed
    // with the SQL about that before the fix, and must keep agreeing while the
    // flag is off.
    const db = await openDb();
    await db.run("DELETE FROM sessions");
    await insertRow(
      db,
      "off-ended-awaiting",
      SESSION_STATUS.ACTIVE,
      true,
      true
    );
    for (const facet of FACETS) {
      assert.equal(
        await sqlMatches(db, facet),
        false,
        `SQL ${facet} must not match the ended + awaiting row when the gate is OFF`
      );
    }
  });

  test("the gate OFF still double-counts the awaiting-input `stale` row, on both paths", async () => {
    // ISS-5656, pinned as the closed-by-default rollout state. The oracle sweep
    // above asserts this row leaves the Stale facet with the gate ON — and would
    // pass identically on an exclusion applied UNCONDITIONALLY, which is the
    // feature-gated-default trap AGENTS.md names. This is the branch that tells
    // the two apart, asserted on the SQL fast path AND the hydrated matcher so
    // neither can be gated while the other is not.
    const db = await openDb();
    await db.run("DELETE FROM sessions");
    await insertRow(
      db,
      "off-stale-awaiting",
      DISPLAYED_SESSION_STATUS.STALE,
      true,
      false
    );
    const session = sessionFor(DISPLAYED_SESSION_STATUS.STALE, true, false);

    for (const facet of [
      DISPLAYED_SESSION_STATUS.STALE,
      DISPLAYED_SESSION_STATUS.WAITING,
    ]) {
      assert.equal(
        await sqlMatches(db, facet),
        true,
        `SQL ${facet} must still match the awaiting-input \`stale\` row when the gate is OFF`
      );
      assert.equal(
        matchesStatusFilter(session, facet, false),
        true,
        `hydrated ${facet} must still match the awaiting-input \`stale\` row when the gate is OFF`
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
  test("an unrecognized stored spelling answers Unknown, not Active, on both paths", async () => {
    const db = await openDb();
    await db.run("DELETE FROM sessions");
    await insertRow(db, "running", "running", false, false);
    const session = sessionFor("running", false, false);
    for (const gate of [false, true]) {
      setDisplayedStatusParityResolver(() => gate);
      try {
        for (const [facet, expected] of [
          [SESSION_STATUS.ACTIVE, false],
          [DISPLAYED_SESSION_STATUS.UNKNOWN, true],
        ] as const) {
          assert.equal(
            await sqlMatches(db, facet),
            expected,
            `SQL ${facet} (parity gate ${gate})`
          );
          assert.equal(
            matchesStatusFilter(session, facet, gate),
            expected,
            `hydrated ${facet} (parity gate ${gate})`
          );
        }
      } finally {
        setDisplayedStatusParityResolver(() => false);
      }
    }
  });
});
