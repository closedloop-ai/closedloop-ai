import type { ArtifactActivityFeedResult } from "@repo/api/src/types/artifact-activity-feed";
import { withDb } from "@repo/database";
import { artifactActivityFeedService } from "@/app/documents/artifact-activity-feed-service";
import { finalizeCloudBranchProductResponse } from "./branch-product-response-eligibility";
import { branchHasCloudEligibility } from "./cloud-branch-eligibility";

type BranchActivityFeedInput = {
  organizationId: string;
  branchId: string;
  cursor?: string;
  limit?: number;
};

/** Read V1 edits only while the Branch remains Product-eligible. */
export const branchActivityFeedService = {
  async listActivityFeed(
    input: BranchActivityFeedInput
  ): Promise<ArtifactActivityFeedResult | null> {
    const eligible = await withDb((db) =>
      branchHasCloudEligibility(db, input.organizationId, input.branchId)
    );
    if (!eligible) {
      return null;
    }

    const page = await artifactActivityFeedService.listStoredEventActivityFeed({
      organizationId: input.organizationId,
      artifactId: input.branchId,
      cursor: input.cursor,
      limit: input.limit,
    });
    return finalizeCloudBranchProductResponse(
      input.organizationId,
      input.branchId,
      page
    );
  },
};
