/**
 * ISS-10864 — Desktop holds no repository-default authority (the cloud owns
 * Branch eligibility), so a non-empty read publishes the candidates that
 * nothing could exclude, with the gap disclosed, rather than failing.
 *
 * Three arms are pinned together, because narrowing the gate must not delete
 * any of them:
 *  - the PUBLICATION gate keeps running, since it is decidable from local
 *    evidence alone (tamsinb review; PRD-683 D7 / ISS-8148);
 *  - a cohort NUMBER is withheld, so the same corpus cannot arrive somewhere
 *    else as a measured total (whitlockk review);
 *  - an empty corpus has nothing to decide, so it is complete.
 */

import assert from "node:assert/strict";
import { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import { test } from "vitest";
import { BranchDefaultEligibilityUnavailableError } from "../src/main/branch/branch-default-eligibility-diagnostic.js";
import {
  assertBranchDefaultEligibilityCoverageComplete,
  denominatorEligibleBranchKeys,
  eligibleBranchKeys,
  filterEligibleBranchRows,
  resolveBranchProductEligibilitySnapshot,
} from "../src/main/branch/shared-branches-default-eligibility.js";

const REPOSITORY = "acme/web";
const PUBLISHED_ROWS = [
  {
    repoFullName: REPOSITORY,
    branchName: "feature/one",
    sessionId: "s-1",
    hasLocalPublication: true,
  },
  {
    repoFullName: REPOSITORY,
    branchName: "feature/two",
    sessionId: "s-2",
    hasLocalPublication: true,
  },
  {
    repoFullName: REPOSITORY,
    branchName: "main",
    sessionId: "s-3",
    hasLocalPublication: true,
  },
];
/** Commit-only: decisively not a Branch, and GitHub is not what decides that. */
const COMMIT_ONLY_ROW = {
  repoFullName: REPOSITORY,
  branchName: "feature/commit-only",
  sessionId: "s-4",
};
const ROWS = [...PUBLISHED_ROWS, COMMIT_ONLY_ROW];

test("the published branch corpus survives the eligibility gate", () => {
  const snapshot = resolveBranchProductEligibilitySnapshot(ROWS);

  // Nothing could be excluded by an absent authority, so nothing is, including
  // `main`, which without a repository default looks like any other branch.
  assert.deepEqual(filterEligibleBranchRows(ROWS, snapshot), PUBLISHED_ROWS);
  assert.deepEqual(
    eligibleBranchKeys(ROWS, snapshot).map((row) => row.branchName),
    ["feature/one", "feature/two", "main"]
  );
  assert.equal(denominatorEligibleBranchKeys(snapshot).length, 3);

  // …and the gap travels with it, so no cohort report reads as decided.
  assert.equal(snapshot.authoritative, false);
  assert.equal(snapshot.coverageComplete, false);
  assert.equal(snapshot.pullRequestCoverageComplete, false);
  assert.equal(
    snapshot.diagnostic?.status,
    BranchCloudHydrationStatus.NotConnected
  );
});

test("the publication gate still decides, because GitHub is not what decides it", () => {
  const snapshot = resolveBranchProductEligibilitySnapshot(ROWS);

  // Presence and absence on the SAME locator: a published row survives, the
  // commit-only row does not, so this cannot pass by admitting nothing.
  const survivors = filterEligibleBranchRows(ROWS, snapshot).map(
    (row) => row.branchName
  );
  assert.ok(survivors.includes("feature/one"));
  assert.equal(survivors.includes(COMMIT_ONLY_ROW.branchName), false);
  assert.equal(survivors.length, PUBLISHED_ROWS.length);
});

test("a cohort NUMBER is withheld from a non-empty read", () => {
  // `getSharedBranchUsage` guards on this before publishing token and cost
  // totals. The list is restored; a total over a cohort that can still contain
  // a repository's own default branch is not.
  assert.throws(
    () =>
      assertBranchDefaultEligibilityCoverageComplete(
        resolveBranchProductEligibilitySnapshot(ROWS)
      ),
    BranchDefaultEligibilityUnavailableError
  );
});

test("an empty corpus is complete, so the withheld number above is not vacuous", () => {
  const snapshot = resolveBranchProductEligibilitySnapshot([]);

  assert.equal(snapshot.authoritative, true);
  assert.equal(snapshot.coverageComplete, true);
  assert.doesNotThrow(() =>
    assertBranchDefaultEligibilityCoverageComplete(snapshot)
  );
});
