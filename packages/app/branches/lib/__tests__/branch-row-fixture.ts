import type { BranchRow } from "@repo/app/branches/lib/branch-row";
import { BranchRowStatus } from "@repo/app/branches/lib/branch-row";

/**
 * A complete {@link BranchRow} for branch-list unit tests.
 *
 * Shared rather than re-declared per suite: a per-file builder that spells only
 * the fields its own assertions touch needs an `as BranchRow` cast to compile,
 * and that cast is what lets a newly-required field go missing from the fixture
 * without `tsc` saying so. This one returns the real shape, so adding a field to
 * `BranchRow` fails here until every suite's fixture has it.
 */
export function branchRow(over: Partial<BranchRow> = {}): BranchRow {
  return {
    id: "id",
    branchName: "agent/x",
    baseBranch: "main",
    repo: "acme/web",
    owner: "Alex",
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: null,
    ahead: null,
    additions: null,
    deletions: null,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1h ago",
    ...over,
  };
}
