import assert from "node:assert/strict";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { describe, test } from "vitest";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../src/main/branch/branch-cohort-analytics.js";
import {
  type BranchSyncSource,
  getSharedBranchesPageData,
} from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

/**
 * ISS-9862: the lifecycle-event read is bounded at 10,000 rows, and that bound
 * is honest only while it applies to ONE request's Branch cohort. The reader
 * scopes by `branchKeys`; a caller that omits them gets no `requested_branches`
 * CTE and no join against it, so the scan covers every Branch-linked Session
 * and the ceiling decides the metric for every branch at once. Two of the three
 * production callers used to omit them. Each test drives a serving op through
 * the canned source and reads the SQL the lifecycle query actually issued: the
 * `requested_branches` CTE, the join that scopes `branch_sessions` by it, and
 * the page's keys as the bound parameters. Counterfactual: drop `branchKeys`
 * from any one call and that op's case fails on the CTE, the join, and the
 * parameters at once, because all three come from the same
 * `buildBranchCohortSqlScope` branch.
 */

const LIFECYCLE_SQL = "pr_branch AS (";
const REQUESTED_BRANCHES_CTE =
  "requested_branches(repo_full_name, branch_name) AS (";
const REQUESTED_BRANCHES_JOIN = "JOIN requested_branches rb";
const PAGE_KEY_PARAMETERS = [
  JSON.stringify([{ repoFullName: "acme/web", branchName: "main" }]),
];

type LifecycleRead = { sql: string; parameters: readonly unknown[] };

function recordLifecycleReads(): {
  source: BranchSyncSource;
  lifecycleReads: LifecycleRead[];
} {
  const lifecycleReads: LifecycleRead[] = [];
  const source = makeSource(
    { links: [link({ branch_name: "main", session_id: "s1" })] },
    (sql, parameters) => {
      if (sql.includes(LIFECYCLE_SQL)) {
        lifecycleReads.push({ sql, parameters: parameters ?? [] });
      }
    }
  );
  return { source, lifecycleReads };
}

function cohortScopeOf(lifecycleReads: readonly LifecycleRead[]): {
  readCount: number;
  hasRequestedBranchesCte: boolean;
  hasRequestedBranchesJoin: boolean;
  parameters: readonly unknown[];
} {
  const read = lifecycleReads[0];
  return {
    readCount: lifecycleReads.length,
    hasRequestedBranchesCte:
      read?.sql.includes(REQUESTED_BRANCHES_CTE) ?? false,
    hasRequestedBranchesJoin:
      read?.sql.includes(REQUESTED_BRANCHES_JOIN) ?? false,
    parameters: read?.parameters ?? [],
  };
}

const EXPECTED_SCOPE = {
  readCount: 1,
  hasRequestedBranchesCte: true,
  hasRequestedBranchesJoin: true,
  parameters: PAGE_KEY_PARAMETERS,
};

describe("Branch lifecycle-event read — per-request cohort scope (ISS-9862)", () => {
  test("getSharedBranchesPageData passes the list page's eligible branch keys", async () => {
    const { source, lifecycleReads } = recordLifecycleReads();

    await getSharedBranchesPageData(source);

    assert.deepEqual(cohortScopeOf(lifecycleReads), EXPECTED_SCOPE);
  });

  test("getSharedBranchAnalytics passes the same eligible keys its activity read takes", async () => {
    const { source, lifecycleReads } = recordLifecycleReads();

    await getSharedBranchAnalytics(source);

    assert.deepEqual(cohortScopeOf(lifecycleReads), EXPECTED_SCOPE);
  });

  test("getSharedBranchCohortAnalytics passes the requested branch ids", async () => {
    const { source, lifecycleReads } = recordLifecycleReads();

    await getSharedBranchCohortAnalytics(source, {
      branchIds: [
        encodeBranchId({ repoFullName: "acme/web", branchName: "main" }),
      ],
    });

    assert.deepEqual(cohortScopeOf(lifecycleReads), EXPECTED_SCOPE);
  });
});

/**
 * ISS-9862 review (whitlockk, Codex on PR #7098): scoping the cap by cohort is only
 * safe while the cohort itself fits in one statement. `branchListSnapshotRequestSchema`
 * permits 20,000 branch ids, so a `VALUES (?, ?)` expansion binds TWO variables
 * per key and faults the whole lifecycle read with `too many SQL variables` from
 * 500 branches up on a 999-variable SQLite build — turning a request-scoped cap
 * into a failed read. The cohort therefore crosses as one `json_each` bind.
 * Counterfactual: restore the per-key expansion and this case fails twice over —
 * 1,200 bound parameters instead of 1, and `(?, ?)` back in the SQL.
 */
const BIND_BUDGET_COHORT_SIZE = 600;

describe("Branch lifecycle-event read — cohort bind budget (ISS-9862)", () => {
  test("binds one json parameter for a cohort past the 999-variable floor", async () => {
    const { source, lifecycleReads } = recordLifecycleReads();
    const branchIds = Array.from(
      { length: BIND_BUDGET_COHORT_SIZE },
      (_, index) =>
        encodeBranchId({
          repoFullName: "acme/web",
          branchName: `feature/${index}`,
        })
    );

    await getSharedBranchCohortAnalytics(source, { branchIds });

    assert.equal(lifecycleReads.length, 1);
    assert.equal(lifecycleReads[0]?.parameters.length, 1);
    assert.equal(lifecycleReads[0]?.sql.includes("(?, ?)"), false);
  });
});
