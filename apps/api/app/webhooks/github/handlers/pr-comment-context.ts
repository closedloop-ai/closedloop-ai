import { LinkType } from "@repo/api/src/types/artifact";
import { ArtifactType, type TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";
import { ApplyExternalOutcome } from "@/app/comments/service/github/apply-external-events";
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

  const currentPullRequestDetailId = branchCurrentPullRequestDetailId(
    prDetail?.branchArtifact.branch
  );
  const isCurrentPullRequest = isBranchCurrentPullRequest(
    currentPullRequestDetailId,
    input.ownerResolution.pullRequestDetailId
  );

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

/**
 * Whether a comment webhook's delivery reached the projection, which gates its
 * branch activity and dirty-scope publication. Parity with the handlers before
 * `applyExternal`: every delivery the writer accepted recorded activity, and
 * the ordering guard's drops are deliveries the writer used to accept; a
 * refused write or a missing row did not, and neither does a bad timestamp.
 */
export function webhookDeliveryReachedProjection(
  outcome: ApplyExternalOutcome
): boolean {
  return WEBHOOK_DELIVERY_REACHED_PROJECTION[outcome];
}

/**
 * The current-PR rule the comment webhooks and the review-summary write check
 * before they hand a pull request's comments to `applyExternal`: only the
 * branch's current pull request is written, and a branch with no current-PR
 * pointer accepts its pull requests. The reconcile cron's due-PR scan states
 * the same rule in SQL. `applyExternal` itself does not check it.
 */
export function isBranchCurrentPullRequest(
  currentPullRequestDetailId: string | null,
  pullRequestDetailId: string
): boolean {
  return (
    currentPullRequestDetailId === null ||
    currentPullRequestDetailId === pullRequestDetailId
  );
}

export function branchCurrentPullRequestDetailId(
  branch: { currentPullRequestDetailId: string | null } | null | undefined
): string | null {
  return branch?.currentPullRequestDetailId ?? null;
}

const WEBHOOK_DELIVERY_REACHED_PROJECTION = {
  [ApplyExternalOutcome.Applied]: true,
  [ApplyExternalOutcome.Unchanged]: true,
  [ApplyExternalOutcome.RejectedOlder]: true,
  [ApplyExternalOutcome.RejectedDeleted]: true,
  [ApplyExternalOutcome.RejectedFuture]: false,
  [ApplyExternalOutcome.NotFound]: false,
  [ApplyExternalOutcome.NoWrite]: false,
} as const satisfies Record<ApplyExternalOutcome, boolean>;
