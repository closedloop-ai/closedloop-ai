import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";

export const BRANCH_ROW_A: BranchRow = {
  id: "owner%2Fweb::feature-a",
  branchName: "feature/a",
  baseBranch: "main",
  repo: "owner/web",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "Add feature",
  prUrl: "https://github.com/owner/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: "PASSING",
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
  lastActivityAt: "2026-08-20T00:00:00.000Z",
};

export const BRANCH_ROW_B: BranchRow = {
  ...BRANCH_ROW_A,
  id: "owner%2Fapi::feature-b",
  branchName: "feature/b",
  owner: "Sam Chen",
  repo: "owner/api",
  sessionCount: 1,
};
