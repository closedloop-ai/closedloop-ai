import { type BranchRow, BranchStatus } from "@repo/api/src/types/branch";

/** Build the canonical minimal Branch row used by data-source tests. */
export function makeBranchRow(id: string): BranchRow {
  return {
    additions: null,
    ahead: null,
    baseBranch: "main",
    behind: null,
    branchName: id,
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: null,
    estimatedCostUsd: null,
    filesChanged: null,
    id,
    lastActivityAt: "2026-07-03T05:00:00.000Z",
    multiPrWarning: false,
    owner: "alice",
    prNumber: null,
    prState: null,
    prTitle: null,
    prUrl: null,
    repoFullName: "closedloop-ai/symphony-alpha",
    reviewDecision: null,
    sessionIds: [],
    status: BranchStatus.Open,
  };
}

/** Build a stable page of distinct Branch rows for pagination tests. */
export function makeBranchRows(count: number, start = 0): BranchRow[] {
  return Array.from({ length: count }, (_, index) =>
    makeBranchRow(`branch-${start + index}`)
  );
}
