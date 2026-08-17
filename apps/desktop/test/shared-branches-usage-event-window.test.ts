import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getSharedBranchUsage } from "../src/main/branch/shared-branches-api.js";
import {
  EVENT_WINDOW_START_RE,
  link,
  makeSource,
} from "./shared-branches-test-helpers.js";

/**
 * ISS-4941: the branch usage rollup must carry an active date window into its
 * per-event `token_events` scan as a `created_at` predicate, instead of scanning
 * the highest-cardinality table whole and filtering it in JS.
 *
 * Lives beside `shared-branches-api.test.ts`, which is grandfathered at the
 * noExcessiveLinesPerFile ceiling and must not grow.
 */

/**
 * The captured SQL for the per-event serving scan. The cost-evidence probe also
 * names `token_events`, so it is excluded by its own CTE.
 */
const eventScans = (sqls: string[]) =>
  sqls.filter(
    (sql) =>
      sql.includes("FROM token_events") &&
      !sql.includes("WITH evidence_size AS MATERIALIZED")
  );

describe("ISS-4941: getSharedBranchUsage token_events window pushdown", () => {
  test("carries the window into its token_events scan", async () => {
    // The usage rollup ALWAYS reads per-event rows (its hourly chart needs each
    // event's own timestamp), so only the SQL bound can shrink it. A real-libSQL
    // reader test proves the predicate, but nothing proves this call site passes
    // the bounds: drop the argument and the rollup silently returns to
    // full-corpus hydration with every projected number unchanged, because the
    // JS filter still runs.
    const windowedSqls: string[] = [];
    await getSharedBranchUsage(
      makeSource({ links: [link({})] }, (sql) => windowedSqls.push(sql)),
      { startDate: "2026-06-01T00:00:00.000Z" }
    );
    const scans = eventScans(windowedSqls);
    assert.equal(scans.length, 1);
    assert.match(scans[0] ?? "", EVENT_WINDOW_START_RE);
  });

  test("all-time still reads the corpus unbounded — there is no window to push", async () => {
    const allTimeSqls: string[] = [];
    await getSharedBranchUsage(
      makeSource({ links: [link({})] }, (sql) => allTimeSqls.push(sql))
    );
    const allTimeScans = eventScans(allTimeSqls);
    assert.equal(allTimeScans.length, 1);
    assert.doesNotMatch(allTimeScans[0] ?? "", EVENT_WINDOW_START_RE);
  });
});
