/**
 * @file import-pending-sentinel-scan.test.ts
 * @description ISS-5336: planner guard for the ISS-5103 import-health probe's
 * sentinel sample.
 *
 * `import-pending-sentinel-count.test.ts` already covers WHAT
 * `listImportPendingSessionIds` returns, and it is green whether the read walks
 * `idx_sessions_data_revision_pending` or full-scans `sessions` — a handful of
 * fixture rows behave identically either way. The defect this file exists for is
 * invisible to that: the probe ticks every 5 minutes forever on a db-host reader
 * connection that self-serializes its statements, so a scan of a large local
 * history sits ahead of every other read dispatched to that reader while
 * returning the healthy answer of zero rows.
 *
 * The index is PARTIAL on the sentinel (`WHERE data_revision = -1`), which keeps
 * it empty at rest but also makes it conditional: SQLite uses a partial index
 * only where it can prove the query's WHERE clause implies the index's. It
 * proves that here from the BOUND value of `data_revision`, so the guard has to
 * assert the plan rather than the presence of the DDL.
 *
 * The statement it plans is CAPTURED from a real production-path call, never
 * transcribed: the store is opened with the `onStatement` hook, the probe runs
 * through the production `createStoreHealthMethods`, and the EXPLAIN replays the
 * SQL and bindings that reached the driver adapter. A Prisma upgrade or a
 * `findMany` edit that changes the emitted statement therefore moves this
 * assertion with it — a hand-copied statement would stay green while the
 * production probe drifted back onto a table scan.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_REVISION_IMPORT_PENDING } from "../src/main/collectors/engine/data-revision.js";
import type {
  CapturedStatement,
  DesktopPrisma,
} from "../src/main/database/prisma-client.js";
import { createStoreHealthMethods } from "../src/main/database/store-health-methods.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type QueryPlanRow = { detail: string };
type SqliteMasterRow = { sql: string | null };

const PENDING_INDEX_NAME = "idx_sessions_data_revision_pending";
const SNAPSHOT_LIMIT = 1000;
/** Any ordinary revision — the sentinel is the only negative value in use. */
const LIVE_DATA_REVISION = 7;

/** The probe's read walks only the partial index, which is empty at rest. */
const PENDING_INDEX_PLAN_RE = new RegExp(`INDEX ${PENDING_INDEX_NAME}`);
/**
 * The order the probe actually asks for, read off the CAPTURED statement. The
 * sort assertion below is only a claim about the index while the sort under it
 * is the id one the index is keyed for — re-point the probe's `orderBy` at
 * another column and the plan question changes underneath it — and the ISS-5103
 * stable-snapshot contract (two ticks must cap the same backlog the same way)
 * rests on this order too.
 */
const ORDER_BY_ID_RE = /ORDER\s+BY\s+[^;]*\bid`?\s+ASC/i;
/**
 * The `ORDER BY id ASC` must come from the index's own key rather than a sort of
 * the matched rows. The index is keyed on `id` alone precisely so it supplies
 * that order for free; a re-key that dropped the property would still return the
 * right ids AND would still name the index in the plan, while making the probe
 * materialize and sort the whole pending set on every tick. Same invariant, same
 * spelling as the `idx_sessions_last_activity` guard in
 * `sqlite-agent-dashboard-database.test.ts`.
 */
const TEMP_BTREE_SORT_PLAN_RE = /TEMP B-TREE FOR ORDER BY/i;
/**
 * The index's own predicate, as the live schema stores it. A partial index is
 * only reachable while it and the probe name the same sentinel, so moving
 * `DATA_REVISION_IMPORT_PENDING` without a follow-on migration silently returns
 * the probe to a full scan — with every behavioural assertion still green.
 */
const SENTINEL_PARTIAL_PREDICATE_RE = new RegExp(
  `WHERE\\s+data_revision\\s*=\\s*${DATA_REVISION_IMPORT_PENDING}\\b`
);
/** Picks the probe's own statement out of everything the store issued. */
const SESSIONS_READ_RE = /\bsessions\b/;

async function explain(
  prisma: DesktopPrisma,
  statement: CapturedStatement
): Promise<string> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<QueryPlanRow[]>(
      `EXPLAIN QUERY PLAN ${statement.sql}`,
      ...statement.args
    )
  );
  return rows.map((row) => row.detail).join(" | ");
}

/** The `CREATE INDEX` the migration chain left in the live schema, if any. */
async function readPendingIndexDdl(
  prisma: DesktopPrisma
): Promise<string | undefined> {
  const [row] = await prisma.read((reader) =>
    reader.$queryRawUnsafe<SqliteMasterRow[]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = $1",
      PENDING_INDEX_NAME
    )
  );
  return row?.sql ?? undefined;
}

/**
 * The captured statement with every sentinel binding replaced by an ordinary
 * revision. Compared numerically because the engine binds `LIMIT`/`OFFSET` as
 * strings — only the revision arg can carry the sentinel's value.
 */
function atLiveRevision(statement: CapturedStatement): CapturedStatement {
  return {
    sql: statement.sql,
    args: statement.args.map((arg) =>
      Number(arg) === DATA_REVISION_IMPORT_PENDING ? LIVE_DATA_REVISION : arg
    ),
  };
}

test("ISS-5336: the sentinel sample plans on the partial index, not a sessions scan", async () => {
  const captured: CapturedStatement[] = [];
  const handle = await openTestPrisma(createWriteQueue(), {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    const indexDdl = await readPendingIndexDdl(handle.prisma);
    assert.ok(
      indexDdl,
      `${PENDING_INDEX_NAME} is missing from the migrated schema`
    );
    assert.match(
      indexDdl,
      SENTINEL_PARTIAL_PREDICATE_RE,
      `${PENDING_INDEX_NAME} must be partial on the sentinel the probe queries for, got: ${indexDdl}`
    );

    // The production read, through the production factory: whatever SQL this
    // emits IS the statement the 5-minute probe runs.
    captured.length = 0;
    await createStoreHealthMethods(handle.prisma).listImportPendingSessionIds(
      SNAPSHOT_LIMIT
    );
    const sessionsReads = captured.filter((statement) =>
      SESSIONS_READ_RE.test(statement.sql)
    );
    assert.equal(
      sessionsReads.length,
      1,
      `the probe must be ONE read of sessions for this plan to cover it, got: ${JSON.stringify(sessionsReads.map((statement) => statement.sql))}`
    );
    const [probe] = sessionsReads;
    assert.ok(
      probe.args.some((arg) => Number(arg) === DATA_REVISION_IMPORT_PENDING),
      `the probe must bind the sentinel for SQLite to reach the partial index, got: ${JSON.stringify(probe.args)}`
    );
    assert.match(
      probe.sql,
      ORDER_BY_ID_RE,
      `the probe must still ask for its id order for the sort assertion below to mean anything, got: ${probe.sql}`
    );

    const sentinelPlan = await explain(handle.prisma, probe);
    assert.match(
      sentinelPlan,
      PENDING_INDEX_PLAN_RE,
      `the probe must plan on ${PENDING_INDEX_NAME}, got: ${sentinelPlan}`
    );
    assert.doesNotMatch(
      sentinelPlan,
      TEMP_BTREE_SORT_PLAN_RE,
      `${PENDING_INDEX_NAME} must supply the id order itself, not a sort, got: ${sentinelPlan}`
    );

    // The contrast that makes the assertion above non-vacuous: the same
    // statement at an ordinary revision falls outside the partial predicate and
    // gets no index at all, so the plan above is earned by the sentinel rather
    // than by the `SELECT id` / `ORDER BY id` shape.
    const livePlan = await explain(handle.prisma, atLiveRevision(probe));
    assert.doesNotMatch(
      livePlan,
      PENDING_INDEX_PLAN_RE,
      `a non-sentinel revision cannot imply the partial predicate, got: ${livePlan}`
    );
  } finally {
    await handle.close();
  }
});
