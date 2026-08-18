import { LinkType } from "@repo/api/src/types/artifact";
import { ArtifactType, type TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";
import type { GitHubCommentOwnerSuccess } from "../comment-owner-resolver";

export type CommentWebhookPrContext = {
  id: string;
  branchArtifactId: string;
  isCurrentPullRequest: boolean;
  documentId: string | null;
  document: { slug: string } | null;
};

type LoadPrContextInput = {
  ownerResolution: GitHubCommentOwnerSuccess;
  prNumber: number;
  action: string;
  logPrefix: string;
};

/**
 * Loads the persisted PR context shared by issue-comment and review-comment
 * webhooks after owner resolution has already authenticated the delivery.
 */
export async function loadPrContextForCommentWebhook(
  tx: TransactionClient,
  input: LoadPrContextInput
): Promise<CommentWebhookPrContext | null> {
  const prDetail = await tx.pullRequestDetail.findUnique({
    where: { id: input.ownerResolution.pullRequestDetailId },
    select: {
      id: true,
      artifactId: true,
      branchArtifactId: true,
      artifact: {
        select: {
          // PR is the TARGET of a DOCUMENT -> produces -> PR link. Query
          // targetLinks, not sourceLinks, to follow that persisted direction.
          targetLinks: {
            where: {
              linkType: LinkType.Produces,
              source: { type: ArtifactType.DOCUMENT },
            },
            select: {
              source: { select: { id: true, slug: true } },
            },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
      branchArtifact: {
        select: {
          branch: {
            select: { currentPullRequestDetailId: true },
          },
          targetLinks: {
            where: {
              linkType: LinkType.Produces,
              source: { type: ArtifactType.DOCUMENT },
            },
            select: {
              source: { select: { id: true, slug: true } },
            },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
    },
  });

  const currentPullRequestDetailId =
    prDetail?.branchArtifact.branch?.currentPullRequestDetailId ?? null;
  const isCurrentPullRequest =
    currentPullRequestDetailId === null ||
    currentPullRequestDetailId === input.ownerResolution.pullRequestDetailId;

  if (!isCurrentPullRequest) {
    log.warn(`${input.logPrefix} Loaded non-current pull request context`, {
      repositoryId: input.ownerResolution.repositoryRecordId,
      branchArtifactId: input.ownerResolution.branchArtifactId,
      pullRequestDetailId: input.ownerResolution.pullRequestDetailId,
      currentPullRequestDetailId,
      prNumber: input.prNumber,
      action: input.action,
    });
  }

  const ownerArtifact = prDetail
    ? (prDetail.branchArtifact ?? prDetail.artifact)
    : null;
  const linkedDoc = ownerArtifact?.targetLinks[0]?.source ?? null;
  const context = prDetail
    ? {
        id: prDetail.id,
        branchArtifactId: input.ownerResolution.branchArtifactId,
        isCurrentPullRequest,
        documentId: linkedDoc?.id ?? null,
        document: linkedDoc ? { slug: linkedDoc.slug ?? "" } : null,
      }
    : null;

  if (!context) {
    log.warn(`${input.logPrefix} Pull request not found in database`, {
      repositoryId: input.ownerResolution.repositoryRecordId,
      prNumber: input.prNumber,
      action: input.action,
      reason: "Resolved PR detail disappeared before comment handling",
    });
  }

  return context;
}
