import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import type { UpsertBranchArtifactInput } from "@/app/branches/branch-service";

/**
 * Shared inputs for `branch-service.test.ts`, which is on the shrink-only
 * grandfather list (ISS-12901).
 */
export const ORG_ID = "org-1";
export const PROJECT_ID = "project-1";
export const REPO_ID = "repo-1";
export const REPO_FULL_NAME = "closedloop-ai/closedloop-ai";

// ISS-6274: every write `branch-service.test.ts` asserts discards its row, so each asks
// for the model's PRIMARY KEY alone — the narrowest `select` Prisma accepts —
// instead of `RETURNING *`. Widen any of them and these assertions redden.
export const expectedProducesLinkUpsert = {
  where: {
    sourceId_targetId_linkType: {
      sourceId: "plan-1",
      targetId: "branch-artifact-1",
      linkType: LinkType.Produces,
    },
  },
  create: {
    organizationId: ORG_ID,
    sourceId: "plan-1",
    targetId: "branch-artifact-1",
    linkType: LinkType.Produces,
    sortOrder: 0,
  },
  update: {},
  select: { id: true },
};

export function branchInput(
  overrides: Partial<UpsertBranchArtifactInput> = {}
): UpsertBranchArtifactInput {
  return {
    organizationId: ORG_ID,
    repositoryId: REPO_ID,
    repositoryFullName: REPO_FULL_NAME,
    branchName: "feature/branch-artifact",
    defaultBranch: "main",
    projectId: PROJECT_ID,
    baseBranch: "main",
    baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
    headSha: "sha-2",
    headShaSource: BranchHeadShaSource.PushWebhook,
    beforeSha: "sha-1",
    ...overrides,
  };
}
