import assert from "node:assert/strict";
import {
  BRANCH_STATUS_PARITY_CASES,
  BranchStatusEvidence,
  type BranchStatusParityCase,
} from "@repo/api/src/branch-status-parity.test-fixtures";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github";
import { test } from "vitest";
import {
  type DesktopAssociatedPullRequestCandidate,
  desktopAssociatedPullRequestCandidates,
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

// Desktop stores no GitHub lifecycle (operator ruling, ISS-12709): a PR the
// transcript named stays visible by identity, and its state is not a reading.
test("Desktop keeps a PR with no stored lifecycle as unobserved", () => {
  const result = projectDesktopBranchAssociatedPullRequests([
    pr({ prNumber: 7, state: null }),
  ]);

  assert.deepEqual(
    result.collection.items.map(({ number, lifecycleObserved }) => ({
      number,
      lifecycleObserved,
    })),
    [{ number: 7, lifecycleObserved: false }]
  );
  assert.equal(
    result.collection.selectionReason,
    BranchAssociatedPullRequestSelectionReason.Unobserved
  );
  assert.equal(
    result.collection.completeness.state,
    BranchAssociatedPullRequestCompletenessState.Complete
  );
  assert.equal(
    result.collection.completeness.reasons.includes(
      BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle
    ),
    false
  );
  assert.equal(selectedDesktopPullRequestFields(result.selected).prState, null);
  assert.equal(
    statusForSelectedDesktopPullRequest(result.selected),
    BranchStatus.Open
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

/**
 * ISS-9664 — the DESKTOP half of the cross-surface branch-status contract. The
 * cloud half walks the same table through its own producer in
 * `apps/api/app/branches/branch-status-cross-surface-parity.test.ts`; the two
 * cannot be one test because neither app can import the other, so the shared
 * fixture is what holds them together. Drift on this surface fails here.
 *
 * Before the fix this surface answered "draft" for the first two rows and
 * "closed" for the last one.
 */
for (const parityCase of BRANCH_STATUS_PARITY_CASES) {
  test(`Desktop branch status parity: ${parityCase.name}`, () => {
    assert.equal(
      statusForSelectedDesktopPullRequest(parityCandidate(parityCase)),
      parityCase.expected
    );
  });
}

function parityCandidate(
  parityCase: BranchStatusParityCase
): DesktopAssociatedPullRequestCandidate | null {
  if (parityCase.evidence === BranchStatusEvidence.None) {
    return null;
  }
  const [candidate] = desktopAssociatedPullRequestCandidates([
    pr({
      isDraft: parityCase.isDraft,
      state: parityCase.prState,
      mergedAt:
        parityCase.prState === GitHubPRState.Merged
          ? "2026-08-02T00:00:00.000Z"
          : null,
    }),
  ]);
  if (parityCase.evidence === BranchStatusEvidence.Unobserved) {
    return { ...candidate, lifecycleObserved: false };
  }
  return candidate;
}

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
