import { type BranchRow, BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";

export function branchRow(overrides: Partial<BranchRow>): BranchRow {
  return {
    id: "branch",
    branchName: "feature/branch",
    baseBranch: "main",
    repoFullName: "acme/web",
    owner: "Alice",
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: 10,
    deletions: 5,
    filesChanged: 1,
    lastActivityAt: "2026-08-18T17:00:00.000Z",
    sessionIds: [],
    estimatedCostUsd: null,
    ...overrides,
  };
}

export function branchServerPageQuery(
  overrides: Partial<BranchServerPageQuery> = {}
): BranchServerPageQuery {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
    ...overrides,
  };
}
