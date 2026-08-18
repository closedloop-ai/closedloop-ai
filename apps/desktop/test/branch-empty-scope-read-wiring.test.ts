import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../src/main/branch/branch-cohort-analytics.js";
import { readCanonicalBranchMetricEventRows } from "../src/main/branch/branch-metric-event-read.js";
import {
  type BranchSyncSource,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import type { BranchCanonicalActivityReadRequest } from "../src/main/database/branch-activity-read.js";
import type { BranchMetricEventEvidenceRequest } from "../src/main/database/branch-metric-event-provenance.js";
import {
  type CannedRows,
  link,
  makeSource,
} from "./shared-branches-test-helpers.js";

/**
 * ISS-5957 review (T3), production wiring — the empty-cohort bypass is only
 * worth anything at the CALL SITES, and nothing else in the suite pins them.
 *
 * `branch-empty-scope-reads.test.ts` drives the two helpers directly, so it
 * stays green if a serving op is reverted to calling the facade itself. And the
 * returned VALUE is byte-identical either way — both facades already
 * short-circuit an empty cohort inside the worker — so no data assertion
 * anywhere can catch that revert. The only observable difference is whether the
 * bounded-lane permit was taken, i.e. whether the proxy method was called at
 * all. That is what these tests record.
 *
 * FIVE production-reachable call sites are pinned here, and only those five:
 * `shared-branches-api` :297, :830 and :1083, `branch-analytics-read` :61, and
 * `branch-cohort-analytics` :70. Each of their tests drives a REAL serving op
 * through the shared canned-row fixture with both heavy Branch facades wrapped
 * in a recorder, and asserts the recorder saw nothing. Revert any one of those
 * five from the `…ForScope` wrapper back to `source.readBranch…` and exactly
 * that op's test fails.
 *
 * The other two call sites cannot receive an empty cohort in production, so
 * neither has production-wiring coverage here and neither needs it:
 *
 * `getSharedBranchDetail` (`shared-branches-api` :688) is deliberately absent:
 * it sits behind two `linkRows.length === 0` early returns, and its cohort is
 * `eligibleBranchKeys` over rows the same snapshot already filtered, so an empty
 * cohort is unreachable from that entry point.
 *
 * The evidence-side call site in `branch-metric-event-read.ts` has no production
 * caller that can reach its empty branch either. That op has exactly three
 * callers: `branch-analytics-read` and `shared-branches-api` both omit
 * `branchKeys` (and `undefined` is NOT empty — the wrapper deliberately does not
 * short-circuit it), while `branch-cohort-analytics` passes
 * `request.branchIds.map(decodeBranchId)` after
 * `branchAnalyticsCohortRequestSchema` has enforced `branchIds.min(1)` on both
 * of its piped object schemas, and `.map` preserves length. Its test below is
 * retained as a unit test of the wrapper AT that call site; it is not, and must
 * not be counted as, production-wiring coverage.
 */

/** A serving-op source whose two heavy Branch facades record every call. */
function recordingSource(rows: CannedRows): {
  source: BranchSyncSource;
  activityCalls: BranchCanonicalActivityReadRequest[];
  evidenceCalls: BranchMetricEventEvidenceRequest[];
  queries: string[];
} {
  const queries: string[] = [];
  const base = makeSource(rows, (sql) => {
    queries.push(sql);
  });
  const activityCalls: BranchCanonicalActivityReadRequest[] = [];
  const evidenceCalls: BranchMetricEventEvidenceRequest[] = [];
  const source: BranchSyncSource = {
    ...base,
    readBranchCanonicalActivityRows: (request) => {
      activityCalls.push(request);
      return base.readBranchCanonicalActivityRows(request);
    },
    readBranchMetricEventEvidence: (request) => {
      evidenceCalls.push(request);
      return base.readBranchMetricEventEvidence(request);
    },
  };
  return { source, activityCalls, evidenceCalls, queries };
}

/** A corpus with no branches at all — every serving op resolves an empty cohort. */
const EMPTY_CORPUS: CannedRows = { links: [] };

/** A corpus with one real branch — the control that the recorder does fire. */
const ONE_BRANCH_CORPUS: CannedRows = {
  links: [link({ branch_name: "main", session_id: "s1" })],
};

const NO_CALLS = "an empty cohort must not reach the bounded lane";
const READ_BOUNDARY = new Date("2026-06-10T00:00:00.000Z");

const REACHED_COHORT_READ =
  "the serving op must have run its link read and reached its cohort read";

/**
 * The op reached its cohort read rather than bailing early — asserted by every
 * test below, because without it a future early-return would keep the no-call
 * assertions green for the wrong reason.
 */
function reachedCohortRead(queries: readonly string[]): boolean {
  return queries.includes("links");
}

describe("Branch empty-scope reads — production wiring", () => {
  test("getSharedBranches does not call the activity facade for an empty cohort", async () => {
    const { source, activityCalls, queries } = recordingSource(EMPTY_CORPUS);

    const result = await getSharedBranches(source);

    assert.deepEqual(result.items, []);
    assert.ok(reachedCohortRead(queries), REACHED_COHORT_READ);
    assert.deepEqual(activityCalls, [], NO_CALLS);
  });

  test("getSharedBranchesPageData does not call the activity facade for an empty cohort", async () => {
    const { source, activityCalls, evidenceCalls, queries } =
      recordingSource(EMPTY_CORPUS);

    const result = await getSharedBranchesPageData(source);

    assert.deepEqual(result.list?.items, []);
    assert.ok(reachedCohortRead(queries), REACHED_COHORT_READ);
    assert.deepEqual(activityCalls, [], NO_CALLS);
    // The same page's evidence read is NOT cohort-scoped — it passes no
    // `branchKeys` at all, which means "the whole eligible corpus", the heaviest
    // shape the op has. It must still be admitted, or the bypass would be
    // silently swallowing a real corpus read.
    assert.equal(evidenceCalls.length, 1);
    assert.equal(evidenceCalls[0]?.branchKeys, undefined);
  });

  test("getSharedBranchAnalytics does not call the activity facade for an empty cohort", async () => {
    const { source, activityCalls, queries } = recordingSource(EMPTY_CORPUS);

    await getSharedBranchAnalytics(source);

    assert.ok(reachedCohortRead(queries), REACHED_COHORT_READ);
    assert.deepEqual(activityCalls, [], NO_CALLS);
  });

  test("getSharedBranchUsage does not call the activity facade for an empty cohort", async () => {
    const { source, activityCalls, queries } = recordingSource(EMPTY_CORPUS);

    await getSharedBranchUsage(source);

    assert.ok(reachedCohortRead(queries), REACHED_COHORT_READ);
    assert.deepEqual(activityCalls, [], NO_CALLS);
  });

  test("getSharedBranchCohortAnalytics does not call the activity facade when no requested branch is eligible", async () => {
    // The cohort request schema requires at least one branch id, so the
    // realistic empty cohort here is a requested id matching no eligible link
    // row, which leaves `eligibleBranchKeys` empty.
    const { source, activityCalls, queries } = recordingSource(EMPTY_CORPUS);

    const result = await getSharedBranchCohortAnalytics(source, {
      branchIds: [
        encodeBranchId({ repoFullName: "acme/app", branchName: "missing" }),
      ],
    });

    assert.deepEqual(result?.matchedBranchIds, []);
    assert.ok(reachedCohortRead(queries), REACHED_COHORT_READ);
    assert.deepEqual(activityCalls, [], NO_CALLS);
  });

  test("readCanonicalBranchMetricEventRows routes its evidence read through the bypass wrapper (synthetic empty cohort)", async () => {
    // NOT production wiring, and not one of the five pinned call sites. The `[]`
    // below is synthetic: no caller of this op can produce an empty cohort (see
    // the file header), so all this pins is that the sole evidence-read call
    // site goes through `…ForScope` rather than calling the facade directly.
    const { source, evidenceCalls } = recordingSource(EMPTY_CORPUS);

    const read = await readCanonicalBranchMetricEventRows(
      source,
      {},
      READ_BOUNDARY,
      []
    );

    assert.deepEqual(read.rows, []);
    assert.deepEqual(evidenceCalls, [], NO_CALLS);
  });

  test("a NON-empty cohort still reaches both facades", async () => {
    // The control. Without it every assertion above would pass just as well
    // against a bypass that skipped the proxy unconditionally — which would
    // silently blank every real Branch read.
    const { source, activityCalls, evidenceCalls } =
      recordingSource(ONE_BRANCH_CORPUS);

    await getSharedBranchesPageData(source);
    await readCanonicalBranchMetricEventRows(source, {}, READ_BOUNDARY, [
      { repoFullName: "acme/app", branchName: "main" },
    ]);

    assert.equal(activityCalls.length, 1);
    assert.equal(activityCalls[0]?.branchKeys.length, 1);
    assert.equal(evidenceCalls.length, 2);
  });
});
