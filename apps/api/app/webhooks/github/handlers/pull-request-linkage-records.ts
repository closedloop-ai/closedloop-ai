import { LinkType } from "@repo/api/src/types/artifact";
import type { Document } from "@repo/api/src/types/document";
import type { TransactionClient } from "@repo/database";
import { nextProducesLinkSortOrder } from "@/app/artifact-links/produces-link-sort-order";
import type { HandledPullRequestEvent } from "./pull-request-action-application";

/**
 * Create the ArtifactLink row for a PR-to-plan link. Lifecycle/status mutations
 * are intentionally owned by `applyPrAction` or the branch service create path
 * so linkage cannot double-write PR state.
 */
export async function createLinkageRecords(
  tx: TransactionClient,
  artifact: Pick<Document, "id" | "organizationId" | "projectId" | "slug">,
  pullRequest: HandledPullRequestEvent["pull_request"],
  knownBranchArtifactId?: string
): Promise<void> {
  // Find the branch artifact by current PR detail github id.
  const existingPrDetail = await tx.pullRequestDetail.findUnique({
    where: { githubId: String(pullRequest.id) },
    select: { artifactId: true, branchArtifactId: true },
  });

  const branchArtifactId =
    knownBranchArtifactId ?? existingPrDetail?.branchArtifactId ?? null;
  const legacyArtifactId = branchArtifactId
    ? null
    : (existingPrDetail?.artifactId ?? null);
  const targetArtifactId = branchArtifactId ?? legacyArtifactId;
  if (!targetArtifactId) {
    return;
  }

  // Dedup ArtifactLink — enforced by the unique constraint but we check first
  // to avoid the round-trip when it already exists.
  const existingLink = await tx.artifactLink.findFirst({
    where: {
      organizationId: artifact.organizationId,
      sourceId: artifact.id,
      targetId: targetArtifactId,
      linkType: LinkType.Produces,
    },
    select: { id: true },
  });

  if (!existingLink) {
    const sortOrder = await nextProducesLinkSortOrder(
      tx,
      artifact.organizationId,
      artifact.id
    );
    await tx.artifactLink.create({
      data: {
        organizationId: artifact.organizationId,
        sourceId: artifact.id,
        targetId: targetArtifactId,
        linkType: LinkType.Produces,
        sortOrder,
      },
      select: { id: true },
    });
  }
}
