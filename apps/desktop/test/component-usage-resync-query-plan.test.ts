/**
 * @file component-usage-resync-query-plan.test.ts
 * @description ISS-7701 — pins the PLAN of the component-usage discovery read.
 *
 * The ticket asked for a settled steady state to stop paying full discovery on
 * every boot. A completion marker cannot do that soundly (the module header of
 * `component-usage-resync-heal.ts` sets out both populations it would strand),
 * so what changed instead is the COST of the read: the `sessions` bound and the
 * marker probe moved from WHERE — evaluated once per usage ROW — to HAVING,
 * evaluated once per GROUP after aggregation. In a settled store there are no
 * over-cap groups, so neither probe runs at all.
 *
 * That is a property of the PLAN, not of the answer, so no behavioral test can
 * observe it — the rows are identical either way, which is exactly why the
 * regression would be silent. `EXPLAIN QUERY PLAN` is the store's own account of
 * how it will run the statement, so these assertions read runtime output rather
 * than scanning source (the `no-raw-text-source-scan` gate's concern).
 *
 * Counting CORRELATED SCALAR SUBQUERY entries is the assertion that actually
 * kills the mutation: the previous WHERE/JOIN form reached `sessions` through a
 * join and produced exactly ONE correlated subquery (the marker `NOT EXISTS`).
 * Restoring it drops this count to 1 and reddens the test.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { componentUsageResyncChunkSelectSql } from "../src/main/database/component-usage-resync-heal.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** The usage table's primary-key index — `(session_id, …)`, so it covers the grouping. */
const USAGE_COVERING_INDEX = "sqlite_autoindex_agent_component_session_usage_1";

/**
 * A sort SQLite cannot satisfy from an index. Load-bearing rather than tidy: a
 * plan that sorts must drain EVERY over-cap group before `LIMIT` can stop it,
 * which would replace the per-row cost this change removes with a per-chunk one.
 */
const TEMP_B_TREE = "TEMP B-TREE";

const CORRELATED_SUBQUERY = "CORRELATED SCALAR SUBQUERY";

/**
 * Representative values for the statement's positional parameters, in bind
 * order (whitlockk review).
 *
 * SQLite plans at PREPARE time, so the plan these assertions read is the same
 * whether or not values are bound — but production never prepares this
 * statement without them, and explaining a shape the store is never actually
 * asked to run is a weaker oracle than explaining the real one. The values are
 * deliberately arbitrary-but-typed: only their TYPES can reach the planner.
 */
function planParams(hasKeysetBound: boolean): (string | number)[] {
  const cap = 500;
  const passStart = "2026-09-01T00:00:00.000Z";
  const chunkSize = 25;
  return hasKeysetBound
    ? ["00000000-0000-4000-8000-000000000000", cap, passStart, chunkSize]
    : [cap, passStart, chunkSize];
}

test("ISS-7701: discovery groups over the covering index and never sorts", async () => {
  const plan = await planFor(false);

  assert.ok(
    plan.some(
      (step) => step.startsWith("SCAN") && step.includes(USAGE_COVERING_INDEX)
    ),
    `the grouped scan must stay on the usage covering index; plan was:\n${plan.join("\n")}`
  );
  assert.ok(
    !plan.some((step) => step.includes(TEMP_B_TREE)),
    `the keyset order must come from the index, not a sort; plan was:\n${plan.join("\n")}`
  );
});

test("ISS-7701: the keyset bound is a range scan, not a residual filter", async () => {
  const plan = await planFor(true);

  assert.ok(
    plan.some(
      (step) =>
        step.startsWith("SEARCH") &&
        step.includes(USAGE_COVERING_INDEX) &&
        step.includes("session_id>?")
    ),
    `the bound must range over the index so a chunk skips what it has passed; plan was:\n${plan.join("\n")}`
  );
  assert.ok(
    !plan.some((step) => step.includes(TEMP_B_TREE)),
    `plan was:\n${plan.join("\n")}`
  );
});

test("ISS-7701: both post-filters are per-GROUP probes, not per-ROW ones", async () => {
  for (const hasKeysetBound of [false, true]) {
    const plan = await planFor(hasKeysetBound);
    const correlated = plan.filter((step) =>
      step.includes(CORRELATED_SUBQUERY)
    );

    // Two: the `sessions` pass-start bound and the marker `NOT EXISTS`. The
    // WHERE/JOIN form this replaced produced one, because `sessions` was joined
    // and therefore probed for every usage row rather than every over-cap group.
    assert.equal(
      correlated.length,
      2,
      `both post-filters must sit in HAVING; plan was:\n${plan.join("\n")}`
    );
    assert.ok(
      plan.some((step) => step.includes("sessions")),
      `the pass-start bound must still be enforced in the read; plan was:\n${plan.join("\n")}`
    );
    assert.ok(
      plan.some((step) => step.includes("component_usage_resync_seen")),
      `the marker must still exclude already-asked sessions; plan was:\n${plan.join("\n")}`
    );
  }
});

/** The store's own plan for the production discovery statement, step by step. */
async function planFor(hasKeysetBound: boolean): Promise<string[]> {
  const { db, close } = await openTestPrisma();
  try {
    const result = await db.query(
      `EXPLAIN QUERY PLAN ${componentUsageResyncChunkSelectSql(hasKeysetBound)}`,
      planParams(hasKeysetBound)
    );
    return result.rows.map((row) => String(row.detail));
  } finally {
    await close();
  }
}
