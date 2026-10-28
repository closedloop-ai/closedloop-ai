/**
 * @file retention-revision-bound-contract.test.ts
 * @description ISS-9283: pins what retention and staleness are actually bound
 * to, so a "only rebuild rows at or above revision N" optimization cannot land
 * silently.
 *
 * The ruling this file encodes (ISS-8743's enumerate-first pass, on top of
 * ISS-7708's "raw/source session evidence retained independently of any one
 * derived schema"):
 *
 *  - Retention is bound to RAW SOURCE and a TIME WINDOW. `sweepExpiredSessions`
 *    selects on `status IN (terminal)` and `last_activity_at < cutoff`, and
 *    `data_revision` is not in that predicate at all.
 *  - Stale-revision selection is a SET INEQUALITY with NO FLOOR:
 *    `dataRevision: { not: currentRevision }`. There is no `lt`, no `gte`, and
 *    no partitioning of the number line.
 *
 * Why the second one is a real contract and not an implementation detail: no
 * production code branches on the stored revision NUMBER to shape a record. The
 * stamp SELECTS a row for rebuild; it does not SHAPE the record. Every read of
 * the number itself is a sentinel-vs-real ELIGIBILITY screen against
 * `MIN_REAL_DATA_REVISION` (`deferSentinelRevisionCandidates`,
 * `sqliteSelectRedrivableSessionDeadLetters`, and the trace-comment
 * parent-session guard — ISS-8612), never a per-revision transform.
 * The rebuild is not a
 * migration — it is teardown-and-reimport through `importSessionWithTx`
 * (`main/database/write-core.ts`), which runs the same
 * `buildImportSessionContext` + `importPhase*` sequence a fresh import runs. The
 * two differ only in transaction shape (a fresh import goes through
 * `importSessionIsolated` and commits each record group independently), never in
 * how the record is derived,
 * and there is no migration chain, no transform table, and no versioned parser
 * in the tree. A row stamped 47 is therefore NOT a "revision-47 record"; a
 * genuine one would be the output of the revision-47 parser, which no longer
 * exists. Every non-current value — sentinel, ancient, or ahead of us after a
 * downgrade — is ONE equivalence class: "re-derive this from source".
 *
 * WHY THE LITERALS BELOW ARE HAND-WRITTEN, AND MUST STAY THAT WAY.
 * This suite deliberately does NOT import `DATA_REVISION`,
 * `MIN_REAL_DATA_REVISION`, or `DEFAULT_SESSION_RETENTION_DAYS`. A fixture that
 * builds its expectation out of the constant it polices cannot detect the exact
 * regression this file exists to catch: adding `gte: MIN_REAL_DATA_REVISION` to
 * the selection would keep such a fixture green while silently stranding every
 * sentinel row forever. The duplication IS the test — never "simplify" it into
 * a derivation. Same reasoning as `REGISTRY_MEMBERSHIP_WITNESS` and
 * `LEDGER_HISTORICAL_KEYS` in `labs-setting-key-ledger.test.ts`; see
 * `test/AGENTS.md`.
 */

import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { sweepExpiredSessions } from "../src/main/database/session-maintenance.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  maintenanceFacadeFor,
  NOW,
  type SeedSessionRow,
  type Store,
  seedSessions,
} from "./session-sweep-fixtures.js";

/**
 * An arbitrary stand-in for "whatever `DATA_REVISION` happens to be today",
 * chosen so nothing here tracks the real counter. The contract under test is
 * about the SHAPE of the comparison, not about any particular number, so the
 * suite must keep passing unchanged as the real revision climbs.
 */
const CURRENT_REVISION = 42;

/**
 * The revision axis, written out by hand. Each entry is a value the selection
 * must place on a specific side of the equality, and the four stale ones are
 * deliberately spread across the number line: below zero, at zero, at the
 * oldest real revision, and AHEAD of current.
 */
const IMPORT_PENDING_SENTINEL = -1;
const MAINTENANCE_STALE_SENTINEL = 0;
const OLDEST_REAL_REVISION = 1;
const ABOVE_CURRENT_REVISION = CURRENT_REVISION + 1;

const STALE_REVISIONS = [
  IMPORT_PENDING_SENTINEL,
  MAINTENANCE_STALE_SENTINEL,
  OLDEST_REAL_REVISION,
  ABOVE_CURRENT_REVISION,
] as const;

const ALL_REVISIONS = [...STALE_REVISIONS, CURRENT_REVISION] as const;

/**
 * The retention window, hand-written for the same reason the revisions are.
 * Fixture ages are derived from THIS literal, not from
 * `DEFAULT_SESSION_RETENTION_DAYS`, so changing the production window reddens
 * this suite instead of silently dragging its expectations along.
 */
const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const NOW_MS = new Date(NOW).valueOf();
const OUTSIDE_WINDOW = new Date(
  NOW_MS - (RETENTION_DAYS + 1) * MS_PER_DAY
).toISOString();
const INSIDE_WINDOW = new Date(
  NOW_MS - (RETENTION_DAYS - 1) * MS_PER_DAY
).toISOString();
/**
 * EXACTLY on the bound: `NOW - RETENTION_DAYS`, byte-identical to the cutoff
 * `sweepExpiredSessions` computes at the production default (`last_activity_at`
 * is a TEXT column, so the comparison is lexicographic over ISO-8601 and the
 * equality is exact).
 *
 * This row is what actually PINS the 90, and it must land on the RETAINED side:
 * the predicate is the strict `lastActivityAt: { lt: cutoff }`, so a row whose
 * timestamp EQUALS the cutoff is not purged. Rows merely NEAR the bound cannot
 * pin it — with only a 89-day and a 91-day fixture, dropping the default to 89
 * moves the cutoff onto the 89-day row's own timestamp, which then survives on
 * that same `<` while the 91-day row still purges, and the suite stays green one
 * day off its stated contract. Anchoring a row AT the bound closes that: at 89
 * this row falls strictly before the cutoff and purges (red), at 91 the
 * out-of-window row no longer purges (red), and flipping `lt` to `lte` purges
 * this row too (red).
 */
const AT_BOUND = new Date(NOW_MS - RETENTION_DAYS * MS_PER_DAY).toISOString();

function sessionRow(
  id: string,
  status: string,
  lastActivityAt: string,
  dataRevision: number
): SeedSessionRow {
  return {
    id,
    status,
    updatedAt: lastActivityAt,
    lastActivityAt,
    startedAt: lastActivityAt,
    endsWithError: null,
    dataRevision,
  };
}

/** Stable id for a fixture row, so an assertion message names its revision. */
function idFor(prefix: string, revision: number): string {
  return `${prefix}-rev${revision}`;
}

async function selectedIds(
  prisma: Awaited<ReturnType<typeof openTestPrisma>>["prisma"]
): Promise<string[]> {
  const rows =
    await maintenanceFacadeFor(prisma).listStaleRevisionSessions(
      CURRENT_REVISION
    );
  return rows.map((row) => row.id).sort();
}

async function survivingIds(store: Store): Promise<string[]> {
  const result = await store.query<{ id: string }>(
    "SELECT id FROM sessions ORDER BY id"
  );
  return result.rows.map((row) => row.id);
}

/**
 * AC1. The selection is `not currentRevision` — a set inequality over the whole
 * number line — and every row on the other side of that equality is selected,
 * sentinels included.
 *
 * The counterfactuals this is built to catch, both of which are the "obvious
 * optimization" a future reader will reach for:
 *   - `gte: MIN_REAL_DATA_REVISION` alongside the inequality drops the two
 *     sentinel rows, which are precisely the rows that MOST need re-deriving.
 *   - `lt: currentRevision` instead of the inequality drops the above-current
 *     row, stranding every session a downgraded build stamped.
 */
test("ISS-9283: stale-revision selection is a set inequality with no floor — sentinels, revision 1, and an above-current revision are all selected", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSessions(
      store,
      ALL_REVISIONS.map((revision) =>
        sessionRow(
          idFor("stale", revision),
          SESSION_STATUS.INACTIVE,
          INSIDE_WINDOW,
          revision
        )
      )
    );

    // Exact set equality, so this is simultaneously the positive assertion
    // (every stale revision selected) and the negative one (the current
    // revision is not). A floor of any kind shrinks the left side.
    assert.deepEqual(
      await selectedIds(prisma),
      STALE_REVISIONS.map((revision) => idFor("stale", revision)).sort(),
      "selection is not the exact complement of the current revision"
    );

    // The sibling for the one negative above: the current-revision row is
    // excluded ONLY because of its revision. Move that same row off the current
    // value and nothing else, and it becomes selectable — proving it was
    // eligible in every other respect and the equality is what held it back.
    const currentId = idFor("stale", CURRENT_REVISION);
    await store.query("UPDATE sessions SET data_revision = $1 WHERE id = $2", [
      ABOVE_CURRENT_REVISION,
      currentId,
    ]);
    assert.deepEqual(
      await selectedIds(prisma),
      ALL_REVISIONS.map((revision) => idFor("stale", revision)).sort(),
      "a row moved off the current revision was not newly selected"
    );
  } finally {
    await close();
  }
});

/**
 * AC2. The retention sweep is revision-blind: outcome is decided entirely by
 * (status, last_activity_at), and the stored revision neither condemns a row
 * nor rescues one.
 *
 * Run at every revision on the axis, in all three window positions, because a
 * revision-aware sweep would most plausibly appear as "don't purge rows we have
 * not re-derived yet" — i.e. it would spare exactly the sentinel rows, which a
 * fixture seeded only at revision 1 would never notice.
 *
 * The three positions also pin the window itself to exactly 90 days: the
 * {@link AT_BOUND} row is retained (strict `<`), the day-past row is purged, and
 * moving the production default one day in either direction reddens one of those
 * two. See {@link AT_BOUND} for why a near-the-bound pair alone does not.
 */
test("ISS-9283: the 90-day retention sweep is revision-blind and bounded at exactly 90 days — outcome is purely status and last activity", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const rows: SeedSessionRow[] = [];
    for (const revision of ALL_REVISIONS) {
      rows.push(
        // Terminal + outside the window: purged, at every revision.
        sessionRow(
          idFor("expired", revision),
          SESSION_STATUS.INACTIVE,
          OUTSIDE_WINDOW,
          revision
        ),
        // Terminal + inside the window: retained, at every revision. The sibling
        // that keeps the assertion above from being satisfied by a sweep that
        // simply deletes everything.
        sessionRow(
          idFor("recent", revision),
          SESSION_STATUS.ERROR,
          INSIDE_WINDOW,
          revision
        ),
        // Non-terminal + outside the window: retained, at every revision. A stale
        // revision does not make an active session purgeable; status does.
        sessionRow(
          idFor("active", revision),
          SESSION_STATUS.ACTIVE,
          OUTSIDE_WINDOW,
          revision
        ),
        // Terminal + EXACTLY on the bound: retained, at every revision, because
        // the predicate is a strict `<`. See {@link AT_BOUND} — this is the row
        // that pins the default to 90 rather than to "somewhere near 90".
        sessionRow(
          idFor("bound", revision),
          SESSION_STATUS.INACTIVE,
          AT_BOUND,
          revision
        )
      );
    }
    await seedSessions(store, rows);

    // No `retentionDays` argument, so the production default is what decides
    // which side of the window the fixtures fall on.
    const { purged } = await sweepExpiredSessions(prisma, NOW);

    assert.equal(
      purged,
      ALL_REVISIONS.length,
      "the purge count is not one per revision — some revision changed the outcome"
    );
    assert.deepEqual(
      await survivingIds(store),
      ALL_REVISIONS.flatMap((revision) => [
        idFor("active", revision),
        idFor("bound", revision),
        idFor("recent", revision),
      ]).sort(),
      "survivors are not exactly the at-bound, in-window terminal and out-of-window non-terminal rows at every revision"
    );
  } finally {
    await close();
  }
});
