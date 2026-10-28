import { branchPrototypeReviewFixture } from "@repo/app/branches/components/prototype-preview/components/branch-list-fixtures";
import type { BranchRow } from "@repo/app/branches/components/prototype-preview/mock";

/**
 * The branch this route key names, from the Branches surface's own fixture.
 *
 * A project collection links a Branch artifact to `/p/web-master/branches/<key>`,
 * so this route owes that key a lookup; without one the reader lands on the
 * branch list instead of the branch.
 */
export function findWebMasterBranch(
  routeKey: string | null | undefined
): BranchRow | undefined {
  if (!routeKey) {
    return undefined;
  }
  return branchPrototypeReviewFixture.rows.find(
    (row) => row.id === routeKey || row.branchName === routeKey
  );
}
