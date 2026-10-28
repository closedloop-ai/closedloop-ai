/**
 * @file plans-dedup-file-path-scan.test.ts
 * @description ISS-6754: planner guard for the plans dedup read's file-capture
 * branch.
 *
 * `plan-store-conversion.test.ts` already covers WHAT `upsertPlan`/`upsertPlans`
 * resolve — create vs dedup vs new version, the null-safe match, the COALESCE
 * backfill — and it is green whether the dedup read seeks an index or walks the
 * whole `plans` table, because a handful of fixture rows behave identically
 * either way. The defect this file exists for is invisible to that:
 * `findExistingPlan` runs once per capture inside a `prisma.write` chunk, so a
 * directory sweep (`plans.backfill`) that walks the table per file costs
 * O(captures x plans) — each walk holding the SOLE SQLite writer, with live
 * ingestion and user mutations queued behind it.
 *
 * The branch is the one a sweep ALWAYS takes: `extractPlansFromPlansDir` stamps
 * every capture with the file it came from, and a plan file is identified by its
 * BASENAME, so the branch deliberately leaves `created_from_session_id` — the
 * leading column of `idx_plans_session_key` — unconstrained. `plan_key = ?`
 * alone implies that index's partial predicate but supplies no seek key, which
 * is exactly the shape that reads as "indexed" while planning as a full walk.
 *
 * So the assertions here are about the PLAN, not the DDL. Two ways to
 * reintroduce the scan silently:
 *   - `idx_plans_key_harness` is PARTIAL, so SQLite reaches it only where the
 *     query's terms imply `plan_key IS NOT NULL`. Loosening `plan_key = ?` into
 *     an `OR`, or into a `LIKE`/`COALESCE`, makes it unreachable with every
 *     behavioural assertion still green.
 *   - `harness IS NOT DISTINCT FROM ?` compiles to SQLite's `IS`, which is
 *     indexable even against NULL. Rewriting it as
 *     `(harness = ? OR (harness IS NULL AND ? IS NULL))` returns the same rows
 *     and drops the second seek key, so the NULL-harness case is planned here
 *     too rather than assumed.
 *
 * The statement it plans is CAPTURED from a real production-path call, never
 * transcribed: the store is opened with the `onStatement` hook, the batch runs
 * through the exported `upsertPlans` the `plans.backfill` op calls, and the
 * EXPLAIN replays the SQL and bindings that reached the driver adapter. Editing
 * the query therefore moves this assertion with it — a hand-copied statement
 * would stay green while the sweep drifted back onto the per-file scan.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { CapturedStatement } from "../src/main/database/prisma-statement-observers.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import {
  makeCapture,
  type PlanCapture,
  planKeyFor,
  upsertPlans,
} from "../src/main/plans/plan-store.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

type QueryPlanRow = { detail: string };
type SqliteMasterRow = { sql: string | null };

const NOW = "2026-08-19T12:00:00.000Z";
const HARNESS = "claude";
const PLANS_DIR = "/home/dev/.claude/plans";
const PLAN_FILE_NAME = "refactor-the-writer-queue.md";
const PLAN_FILE = `${PLANS_DIR}/${PLAN_FILE_NAME}`;
/**
 * The key the seeded legacy row must carry to land in the same group as the file
 * capture — derived through the production `planKeyFor` rather than transcribed,
 * so a change to the derivation moves the fixture with it instead of quietly
 * seeding a row the branch never looks at.
 */
const PLAN_KEY = planKeyFor(planCapture("key-derivation"));

const KEY_HARNESS_INDEX_NAME = "idx_plans_key_harness";
const SESSION_KEY_INDEX_NAME = "idx_plans_session_key";

/** The seek this whole change exists to produce. */
const KEY_HARNESS_SEEK_RE = new RegExp(
  `SEARCH plans USING (?:COVERING )?INDEX ${KEY_HARNESS_INDEX_NAME} \\(plan_key=\\? AND harness=\\?\\)`
);
/**
 * The regression itself. `SCAN plans USING INDEX idx_plans_session_key` is what
 * the branch planned before this index existed: an index appears in the plan,
 * and every row is still visited. Pinned on the plan WORD rather than on an
 * index name, so any future full walk of `plans` fails here too.
 */
const PLANS_SCAN_RE = /\bSCAN plans\b/;
/**
 * The index's own predicate, as the live schema stores it. A partial index is
 * only reachable while the query can prove it, so widening either side silently
 * returns the sweep to the scan.
 */
const PARTIAL_PREDICATE_RE = /WHERE\s+plan_key\s+IS\s+NOT\s+NULL/i;
/** Picks the file-capture dedup read out of everything the batch issued. */
const DEDUP_READ_RE = /SELECT\s+id\s+FROM\s+plans\b/i;
const FILE_PATH_BRANCH_RE = /\bfile_path\b/;

function planCapture(sessionId: string): PlanCapture {
  return makeCapture({
    harness: HARNESS,
    source: "claude-plan-file",
    captureMethod: "file",
    sessionId,
    content: "# Refactor the writer queue\n\nStep one.\n",
    filePath: PLAN_FILE,
    confidence: 1.0,
    sourceEventRef: `plansdir:${PLAN_FILE_NAME}`,
    capturedAt: NOW,
  });
}

/** A capture with no file behind it — the sibling, session-keyed branch. */
function sessionOnlyCapture(sessionId: string): PlanCapture {
  return makeCapture({
    harness: HARNESS,
    source: "transcript",
    captureMethod: "extractor",
    sessionId,
    content: "# Drain the outbox\n\nStep one.\n",
    confidence: 1.0,
    capturedAt: NOW,
  });
}

/**
 * The legacy row shape: the same basename key with no `file_path` and no
 * session. `upsertPlans` cannot produce it — a file capture always stamps its
 * path — so the fixture writes it directly, through the same raw handle the
 * other store fixtures seed with.
 */
async function seedKeyedPlanWithoutFile(
  h: OpenTestPrisma,
  id: string
): Promise<void> {
  await h.db.query(
    `INSERT INTO plans
       (id, title, status, source, capture_method, harness,
        created_from_session_id, plan_key, file_path, needs_confirmation,
        confidence, created_at, updated_at)
     VALUES ($1, 'Legacy', 'active', 'captured', 'extractor', $2,
             NULL, $3, NULL, 0, 1.0, $4, $4)`,
    [id, HARNESS, PLAN_KEY, NOW]
  );
}

async function explain(
  h: OpenTestPrisma,
  statement: CapturedStatement
): Promise<string> {
  const rows = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<QueryPlanRow[]>(
      `EXPLAIN QUERY PLAN ${statement.sql}`,
      ...statement.args
    )
  );
  return rows.map((row) => row.detail).join(" | ");
}

async function readIndexDdl(
  h: OpenTestPrisma,
  name: string
): Promise<string | undefined> {
  const [row] = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<SqliteMasterRow[]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = $1",
      name
    )
  );
  return row?.sql ?? undefined;
}

/**
 * The captured statement with the harness binding replaced by NULL — the
 * capture paths that carry no harness. Same statement, so the plan below is a
 * claim about `IS NOT DISTINCT FROM`'s indexability rather than about a
 * separate query.
 */
function atNullHarness(statement: CapturedStatement): CapturedStatement {
  return {
    sql: statement.sql,
    args: statement.args.map((arg) => (arg === HARNESS ? null : arg)),
  };
}

test("ISS-6754: the plans backfill dedup read seeks by plan key instead of scanning plans", async () => {
  const captured: CapturedStatement[] = [];
  const h = await openTestPrisma(createWriteQueue(), {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    const ddl = await readIndexDdl(h, KEY_HARNESS_INDEX_NAME);
    assert.ok(
      ddl,
      `${KEY_HARNESS_INDEX_NAME} is missing from the migrated schema`
    );
    assert.match(
      ddl,
      PARTIAL_PREDICATE_RE,
      `${KEY_HARNESS_INDEX_NAME} must be partial on the predicate the dedup read implies, got: ${ddl}`
    );

    // TWO rows under the one basename key — the group the branch has to rank,
    // and the reason it cannot constrain `created_from_session_id`. The first is
    // the ordinary file capture; the second is the legacy shape the residual
    // `(file_path = ? OR file_path IS NULL)` and the leading CASE tiebreak exist
    // for — same key, no file and no session behind it. No capture path emits
    // that row (a file capture always stamps its path), so it is seeded
    // directly.
    const [first] = await upsertPlans(h.prisma, [planCapture("session-a")]);
    await seedKeyedPlanWithoutFile(h, "legacy-plan-row");

    // The production batch, through the production entry point: whatever SQL
    // this emits IS the statement `plans.backfill` runs per captured file.
    captured.length = 0;
    const [again] = await upsertPlans(h.prisma, [planCapture("session-b")]);
    // The seeded row is load-bearing, not decoration: the branch has to rank
    // past it to land back on the file's own row.
    assert.equal(
      again.planId,
      first.planId,
      "the file capture must dedup onto its own row, not the keyed row with no file behind it"
    );
    const dedupReads = captured.filter(
      (statement) =>
        DEDUP_READ_RE.test(statement.sql) &&
        FILE_PATH_BRANCH_RE.test(statement.sql)
    );
    assert.equal(
      dedupReads.length,
      1,
      `the batch must issue ONE file-capture dedup read per capture for this plan to cover it, got: ${JSON.stringify(dedupReads.map((statement) => statement.sql))}`
    );
    const [dedupRead] = dedupReads;

    const plan = await explain(h, dedupRead);
    assert.match(
      plan,
      KEY_HARNESS_SEEK_RE,
      `the file-capture branch must seek ${KEY_HARNESS_INDEX_NAME} on both equalities, got: ${plan}`
    );
    assert.doesNotMatch(
      plan,
      PLANS_SCAN_RE,
      `the file-capture branch must not walk plans — that is the per-file cost this index removes, got: ${plan}`
    );

    // The same statement with no harness: `IS NOT DISTINCT FROM` must still
    // reach both seek keys, or the harness-less capture paths keep the scan.
    const nullHarnessPlan = await explain(h, atNullHarness(dedupRead));
    assert.match(
      nullHarnessPlan,
      KEY_HARNESS_SEEK_RE,
      `a NULL harness must still seek ${KEY_HARNESS_INDEX_NAME}, got: ${nullHarnessPlan}`
    );
    assert.doesNotMatch(
      nullHarnessPlan,
      PLANS_SCAN_RE,
      `a NULL harness must not walk plans, got: ${nullHarnessPlan}`
    );

    // The sibling branch — captured the same way, from a capture carrying no
    // file — is unaffected: it still seeks the UNIQUE index whose leading column
    // it DOES constrain. Asserted because re-keying idx_plans_session_key to
    // serve the file branch instead would satisfy everything above while costing
    // the session branch its seek.
    captured.length = 0;
    await upsertPlans(h.prisma, [sessionOnlyCapture("session-d")]);
    const sessionReads = captured.filter(
      (statement) =>
        DEDUP_READ_RE.test(statement.sql) &&
        !FILE_PATH_BRANCH_RE.test(statement.sql)
    );
    assert.equal(
      sessionReads.length,
      1,
      `the session branch must issue ONE dedup read for this plan to cover it, got: ${JSON.stringify(sessionReads.map((statement) => statement.sql))}`
    );
    const sessionBranch = await explain(h, sessionReads[0]);
    assert.match(
      sessionBranch,
      new RegExp(
        `SEARCH plans USING (?:COVERING )?INDEX ${SESSION_KEY_INDEX_NAME}`
      ),
      `the session branch must keep its ${SESSION_KEY_INDEX_NAME} seek, got: ${sessionBranch}`
    );
  } finally {
    await h.close();
  }
});
