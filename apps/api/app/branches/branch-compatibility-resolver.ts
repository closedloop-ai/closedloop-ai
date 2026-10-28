import {
  BranchCompatibilityOutcome,
  type BranchCompatibilityResolution,
} from "@repo/api/src/types/branch-compatibility";
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { ArtifactType, withDb } from "@repo/database";
import { isUuid } from "@/lib/is-uuid";
import { branchProductEligibilityService } from "./branch-product-eligibility-service";
import { matchingGitHubPullRequestUrl } from "./branch-provider-fallback-service";

/**
 * Resolve the minimal org-scoped decision needed by the future `/build/:id`
 * compatibility route. Cross-org, deleted, missing, and ineligible records all
 * produce the same unavailable shape.
 */
export const branchCompatibilityResolver = {
  async resolve(
    organizationId: string,
    branchArtifactId: string
  ): Promise<BranchCompatibilityResolution> {
    if (!isUuid(branchArtifactId)) {
      return { outcome: BranchCompatibilityOutcome.Unavailable };
    }

    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          id: branchArtifactId,
          organizationId,
          type: ArtifactType.BRANCH,
          branch: { deletedAt: null },
        },
        select: {
          id: true,
          branch: {
            select: {
              currentPullRequestDetail: {
                select: {
                  htmlUrl: true,
                  number: true,
                  repositoryFullName: true,
                },
              },
            },
          },
        },
      })
    );
    if (!artifact) {
      return { outcome: BranchCompatibilityOutcome.Unavailable };
    }

    const eligibilityById = await branchProductEligibilityService.findByIds(
      organizationId,
      [artifact.id]
    );
    if (
      eligibilityById.get(artifact.id) !== BranchProductEligibility.Eligible
    ) {
      return { outcome: BranchCompatibilityOutcome.Unavailable };
    }

    const providerUrl = matchingGitHubPullRequestUrl(
      artifact.branch?.currentPullRequestDetail
    );
    return {
      branchArtifactId: artifact.id,
      outcome: BranchCompatibilityOutcome.Eligible,
      ...(providerUrl && { providerUrl }),
    };
  },
};
