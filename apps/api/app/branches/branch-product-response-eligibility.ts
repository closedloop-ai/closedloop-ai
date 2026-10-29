import { withDb } from "@repo/database";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";

/**
 * Apply the Product membership gate at the final response boundary.
 * Provider and projection work must finish before callers invoke this helper.
 */
export async function finalizeCloudBranchProductResponse<Response>(
  organizationId: string,
  branchId: string,
  response: Response | null
): Promise<Response | null> {
  if (response === null) {
    return null;
  }
  const remainsEligible = await withDb((db) =>
    branchHasCloudEligibility(db, organizationId, branchId)
  );
  return remainsEligible ? response : null;
}
