import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import {
  ExternalLinkType,
  type PreviewDeploymentMetadata,
} from "@repo/api/src/types/external-link";
import { GitHubPRState, type TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Input for creating or deduplicating PR linkage records.
 * Used by both the workflow-completion handler and the loop execute handler
 * to ensure idempotent ExternalLink, EntityLink, and preview deployment creation.
 */
type PrLinkageInput = {
  organizationId: string;
  workstreamId: string;
  projectId: string;
  artifactId: string;
  prUrl: string;
  prTitle: string;
  prNumber: number;
  githubId: number;
  headBranch: string;
  baseBranch: string;
  commitSha: string | null;
};

/**
 * Create ExternalLink, EntityLink, and preview deployment records for a PR,
 * deduplicating against records that may already exist from a racing handler.
 *
 * Three code paths can create these records for the same PR:
 * - workflow-completion-handler (handleExecutionSuccess)
 * - loop execute handler (ingestExecutionArtifacts)
 * - pull-request webhook handler (createLinkageRecords)
 *
 * This function checks for existing records before creating.
 */
export async function ensurePrLinkageRecords(
  tx: TransactionClient,
  input: PrLinkageInput
): Promise<void> {
  // Dedup ExternalLink: check for existing PR link by URL
  const existingExternalLink = await tx.externalLink.findFirst({
    where: {
      organizationId: input.organizationId,
      type: ExternalLinkType.PullRequest,
      externalUrl: input.prUrl,
    },
    select: { id: true },
  });

  let externalLinkId: string;

  if (existingExternalLink) {
    externalLinkId = existingExternalLink.id;
  } else {
    const prLink = await tx.externalLink.create({
      data: {
        organizationId: input.organizationId,
        workstreamId: input.workstreamId,
        projectId: input.projectId,
        type: ExternalLinkType.PullRequest,
        title: input.prTitle,
        externalUrl: input.prUrl,
        metadata: {
          number: input.prNumber,
          githubId: input.githubId,
          headBranch: input.headBranch,
          baseBranch: input.baseBranch,
          state: GitHubPRState.OPEN,
        },
      },
    });
    externalLinkId = prLink.id;
  }

  // Dedup EntityLink: artifact → PRODUCES → PR external link
  const existingEntityLink = await tx.entityLink.findFirst({
    where: {
      organizationId: input.organizationId,
      sourceId: input.artifactId,
      targetId: externalLinkId,
      linkType: LinkType.Produces,
    },
    select: { id: true },
  });

  if (!existingEntityLink) {
    await tx.entityLink.create({
      data: {
        organizationId: input.organizationId,
        sourceId: input.artifactId,
        sourceType: EntityType.Artifact,
        targetId: externalLinkId,
        targetType: EntityType.ExternalLink,
        linkType: LinkType.Produces,
      },
    });
  }

  // TODO: These preview deployment bits were pre-existing, but they need to be revisited.
  // PRs can have multiple preview links (ours have 3). Also the title matching is a bit odd.
  // We should only create the preview links when the deployment is created in GitHub.
  // Dedup preview deployment ExternalLink by branch ref
  const previewTitle = `Preview: ${input.headBranch}`;
  const existingPreviewLink = await tx.externalLink.findFirst({
    where: {
      organizationId: input.organizationId,
      type: ExternalLinkType.PreviewDeployment,
      workstreamId: input.workstreamId,
      title: previewTitle,
    },
    select: { id: true },
  });

  let previewLinkId: string;

  if (existingPreviewLink) {
    previewLinkId = existingPreviewLink.id;
  } else {
    const metadata: PreviewDeploymentMetadata = {
      ref: input.headBranch,
      sha: input.commitSha,
      environment: "preview",
      state: null,
    };

    const previewLink = await tx.externalLink.create({
      data: {
        organizationId: input.organizationId,
        workstreamId: input.workstreamId,
        projectId: input.projectId,
        type: ExternalLinkType.PreviewDeployment,
        title: previewTitle,
        externalUrl: "",
        metadata,
      },
    });
    previewLinkId = previewLink.id;
  }

  // Dedup EntityLink: PR → PRODUCES → preview deployment
  const existingPreviewEntityLink = await tx.entityLink.findFirst({
    where: {
      sourceId: externalLinkId,
      targetId: previewLinkId,
      linkType: LinkType.Produces,
    },
    select: { id: true },
  });

  if (!existingPreviewEntityLink) {
    await tx.entityLink.create({
      data: {
        organizationId: input.organizationId,
        sourceId: externalLinkId,
        sourceType: EntityType.ExternalLink,
        targetId: previewLinkId,
        targetType: EntityType.ExternalLink,
        linkType: LinkType.Produces,
      },
    });
  }

  log.info("[pr-linkage] Ensured PR linkage records", {
    artifactId: input.artifactId,
    prUrl: input.prUrl,
    prNumber: input.prNumber,
    externalLinkId,
    previewLinkId,
  });
}
