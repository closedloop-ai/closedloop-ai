import assert from "node:assert/strict";
import test from "node:test";
import {
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  hasMultipleValidPullRequestNumbers,
  projectDesktopBranchAssociatedPullRequests,
  selectedDesktopPullRequestFields,
  statusForSelectedDesktopPullRequest,
} from "../src/main/branch/branch-associated-pull-request-projection.js";
import type { BranchPrRow } from "../src/main/database/branch-reads.js";

test("Desktop selects the active PR independently of observation order", () => {
  const result = projectDesktopBranchAssociatedPullRequests([
    pr({
      prNumber: 10,
      state: "closed",
      closedAt: "2026-08-02T00:00:00.000Z",
      observedAt: "2026-08-03T00:00:00.000Z",
    }),
    pr({
      prNumber: 12,
      isDraft: true,
      observedAt: "2026-08-01T00:00:00.000Z",
    }),
  ]);

  assert.deepEqual(
    result.collection.items.map(({ number }) => number),
    [10, 12]
  );
  assert.equal(
    result.collection.selectionReason,
    BranchAssociatedPullRequestSelectionReason.Active
  );
  assert.equal(
    result.collection.completeness.state,
    BranchAssociatedPullRequestCompletenessState.Complete
  );
  assert.deepEqual(selectedDesktopPullRequestFields(result.selected), {
    prNumber: 12,
    prState: GitHubPRState.Open,
    prTitle: "PR 12",
    prUrl: "https://github.com/closedloop-ai/symphony/pull/12",
    reviewDecision: null,
  });
  assert.equal(statusForSelectedDesktopPullRequest(result.selected), "draft");
});

test("Desktop retains repository-qualified collisions and reports multiple active evidence", () => {
  const result = projectDesktopBranchAssociatedPullRequests([
    pr({ repoFullName: "other/repo", prNumber: 4 }),
    pr({ repoFullName: "closedloop-ai/symphony", prNumber: 4 }),
  ]);

  assert.deepEqual(
    result.collection.items.map(({ id }) => id),
    ["closedloop-ai/symphony#4", "other/repo#4"]
  );
  assert.equal(result.collection.selectedId, null);
  assert.equal(
    result.collection.completeness.state,
    BranchAssociatedPullRequestCompletenessState.Incomplete
  );
});

test("Desktop reports an absent persisted lifecycle as unavailable", () => {
  const result = projectDesktopBranchAssociatedPullRequests([
    pr({ state: null }),
  ]);

  assert.deepEqual(result.collection.items, []);
  assert.equal(
    result.collection.completeness.state,
    BranchAssociatedPullRequestCompletenessState.Unavailable
  );
  assert.ok(
    result.collection.completeness.reasons.includes(
      BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle
    )
  );
});

test("Desktop legacy warning ignores null and invalid PR numbers", () => {
  assert.equal(
    hasMultipleValidPullRequestNumbers([
      { prNumber: 42 },
      { prNumber: null },
      { prNumber: 0 },
    ]),
    false
  );
  assert.equal(
    hasMultipleValidPullRequestNumbers([{ prNumber: 42 }, { prNumber: 43 }]),
    true
  );
});

function pr(overrides: Partial<BranchPrRow> = {}): BranchPrRow {
  const prNumber = overrides.prNumber ?? 1;
  return {
    repoFullName: "closedloop-ai/symphony",
    branchName: "feature/associated-prs",
    prNumber,
    prUrl: `https://github.com/closedloop-ai/symphony/pull/${prNumber}`,
    title: `PR ${prNumber}`,
    state: "open",
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    openedAt: "2026-08-01T00:00:00.000Z",
    observedAt: "2026-08-01T00:00:01.000Z",
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    ...overrides,
  };
}
