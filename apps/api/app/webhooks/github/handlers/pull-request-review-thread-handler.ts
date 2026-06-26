import { type TransactionClient, withDb } from "@repo/database";
import {
  fetchReviewThreadResolutionByNodeId,
  ReviewThreadResolutionResultStatus,
} from "@repo/github/review-thread-lookup";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { resolveExternalGitHubAuthorInTransaction } from "@/app/comments/external-authors";
import {
  findGitHubReviewThreadResolutionProjection,
  GitHubReviewThreadResolutionProjectionStatus,
} from "@/app/comments/github-projection";
import {
  commentsService,
  type GitHubReviewThreadResolutionAttribution,
  GitHubReviewThreadResolutionAttributionKind,
} from "@/app/comments/service";
import { resolveGitHubCommentOwner } from "../comment-owner-resolver";
import { loadPrContextForCommentWebhook } from "./pr-comment-context";
import {
  type PullRequestReviewThreadPayload,
  parsePullRequestReviewThreadPayload,
} from "./pull-request-review-thread-payload";

const PullRequestReviewThreadAction = {
  Resolved: "resolved",
  Unresolved: "unresolved",
} as const;

type PullRequestReviewThreadAction =
  (typeof PullRequestReviewThreadAction)[keyof typeof PullRequestReviewThreadAction];

const PullRequestReviewThreadEligibilityStatus = {
  Eligible: GitHubReviewThreadResolutionProjectionStatus.Eligible,
  UnsupportedAction: "unsupported_action",
  OwnerFailure: "owner_failure",
  MissingOrStalePrContext: "missing_or_stale_pr_context",
  UnknownReviewThread:
    GitHubReviewThreadResolutionProjectionStatus.UnknownReviewThread,
  AmbiguousReviewThread:
    GitHubReviewThreadResolutionProjectionStatus.AmbiguousReviewThread,
  WrongScope: GitHubReviewThreadResolutionProjectionStatus.WrongScope,
  RevalidationFailed: "revalidation_failed",
} as const;

type PullRequestReviewThreadEligibilityStatus =
  (typeof PullRequestReviewThreadEligibilityStatus)[keyof typeof PullRequestReviewThreadEligibilityStatus];

type EligibleReviewThread = {
  status: typeof PullRequestReviewThreadEligibilityStatus.Eligible;
  organizationId: string;
  documentId: string | null;
  documentSlug: string | null;
  threadExternalId: string;
  installationId: string;
};

type TerminalEligibility = {
  status: Exclude<
    PullRequestReviewThreadEligibilityStatus,
    typeof PullRequestReviewThreadEligibilityStatus.Eligible
  >;
};

type ReviewThreadEligibility = EligibleReviewThread | TerminalEligibility;

/**
 * Handle GitHub pull_request_review_thread resolution webhooks with local
 * eligibility before provider confirmation and a separate write revalidation.
 */
export async function handlePullRequestReviewThread(
  rawPayload: unknown
): Promise<Response> {
  const receivedAt = new Date();
  const payload = parsePullRequestReviewThreadPayload(rawPayload);
  if (!payload) {
    return NextResponse.json(
      { message: "Invalid pull_request_review_thread payload", ok: false },
      { status: 400 }
    );
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    log.warn("[handlePullRequestReviewThread] Missing installation on event", {
      action: payload.action,
      prNumber: payload.pull_request.number,
      repositoryFullName: payload.repository.full_name,
    });
    return NextResponse.json(
      { message: "Missing installation", ok: false },
      { status: 400 }
    );
  }

  const action = handledReviewThreadAction(payload.action);
  if (!action) {
    log.info("[handlePullRequestReviewThread] Skipping unhandled action", {
      action: payload.action,
      prNumber: payload.pull_request.number,
      repositoryFullName: payload.repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled pull_request_review_thread action: ${payload.action}`,
      ok: true,
    });
  }

  const eligibility = await loadReviewThreadEligibility(payload, action);
  if (
    eligibility.status !== PullRequestReviewThreadEligibilityStatus.Eligible
  ) {
    log.info("[handlePullRequestReviewThread] Local eligibility no-write", {
      status: eligibility.status,
      action,
      reviewThreadId: payload.thread.node_id,
      prNumber: payload.pull_request.number,
    });
    return NextResponse.json({ message: "Event ignored", ok: true });
  }

  const providerResult = await fetchReviewThreadResolutionByNodeId(
    eligibility.installationId,
    payload.thread.node_id
  );
  if (
    providerResult.status === ReviewThreadResolutionResultStatus.RetryableError
  ) {
    log.warn(
      "[handlePullRequestReviewThread] Provider confirmation retryable",
      {
        action,
        reason: providerResult.reason,
        reviewThreadId: payload.thread.node_id,
        prNumber: payload.pull_request.number,
      }
    );
    return NextResponse.json(
      { message: "Provider confirmation failed", ok: false },
      { status: 502 }
    );
  }

  if (providerResult.status === ReviewThreadResolutionResultStatus.Terminal) {
    log.info("[handlePullRequestReviewThread] Provider terminal no-write", {
      action,
      reason: providerResult.reason,
      reviewThreadId: payload.thread.node_id,
      prNumber: payload.pull_request.number,
    });
    return NextResponse.json({ message: "Event ignored", ok: true });
  }

  if (
    providerResult.isResolved !==
    (action === PullRequestReviewThreadAction.Resolved)
  ) {
    log.info(
      "[handlePullRequestReviewThread] Provider state mismatch no-write",
      {
        action,
        providerIsResolved: providerResult.isResolved,
        reviewThreadId: payload.thread.node_id,
        prNumber: payload.pull_request.number,
      }
    );
    return NextResponse.json({ message: "Event ignored", ok: true });
  }

  const mutation = await writeReviewThreadResolution(
    payload,
    action,
    eligibility,
    receivedAt
  );
  if (
    mutation.status ===
    PullRequestReviewThreadEligibilityStatus.RevalidationFailed
  ) {
    return NextResponse.json({ message: "Event ignored", ok: true });
  }

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}

function handledReviewThreadAction(
  action: string
): PullRequestReviewThreadAction | null {
  if (
    action === PullRequestReviewThreadAction.Resolved ||
    action === PullRequestReviewThreadAction.Unresolved
  ) {
    return action;
  }
  return null;
}

async function loadReviewThreadEligibility(
  payload: PullRequestReviewThreadPayload,
  action: PullRequestReviewThreadAction
): Promise<ReviewThreadEligibility> {
  return await withDb.tx(async (tx) => {
    const ownerResolution = await resolveGitHubCommentOwner(tx, {
      installationId: payload.installation?.id ?? 0,
      repositoryId: payload.repository.id,
      pullNumber: payload.pull_request.number,
    });
    if (!ownerResolution.ok) {
      return { status: PullRequestReviewThreadEligibilityStatus.OwnerFailure };
    }

    const prContext = await loadPrContextForCommentWebhook(tx, {
      ownerResolution,
      prNumber: payload.pull_request.number,
      action,
      logPrefix: "[handlePullRequestReviewThread]",
    });
    if (!prContext) {
      return {
        status:
          PullRequestReviewThreadEligibilityStatus.MissingOrStalePrContext,
      };
    }

    const projection = await findGitHubReviewThreadResolutionProjection(tx, {
      organizationId: ownerResolution.organizationId,
      branchArtifactId: prContext.branchArtifactId,
      pullRequestDetailId: prContext.id,
      reviewThreadId: payload.thread.node_id,
      reviewCommentIds: reviewThreadCommentIds(payload),
    });
    if (
      projection.status !==
      GitHubReviewThreadResolutionProjectionStatus.Eligible
    ) {
      return { status: projection.status };
    }

    return {
      status: PullRequestReviewThreadEligibilityStatus.Eligible,
      organizationId: ownerResolution.organizationId,
      documentId: prContext.documentId,
      documentSlug: prContext.document?.slug ?? null,
      threadExternalId: projection.threadExternalId,
      installationId: String(payload.installation?.id ?? ""),
    };
  });
}

async function writeReviewThreadResolution(
  payload: PullRequestReviewThreadPayload,
  action: PullRequestReviewThreadAction,
  eligible: EligibleReviewThread,
  receivedAt: Date
): Promise<{
  status:
    | "written"
    | typeof PullRequestReviewThreadEligibilityStatus.RevalidationFailed;
}> {
  return await withDb.tx(async (tx) => {
    const revalidated = await loadReviewThreadEligibility(payload, action);
    if (
      revalidated.status !==
        PullRequestReviewThreadEligibilityStatus.Eligible ||
      !sameEligibleReviewThreadScope(revalidated, eligible)
    ) {
      return {
        status: PullRequestReviewThreadEligibilityStatus.RevalidationFailed,
      };
    }
    const activeEligibility = revalidated;

    if (action === PullRequestReviewThreadAction.Resolved) {
      await resolveLocalReviewThread(
        tx,
        payload,
        activeEligibility,
        receivedAt
      );
    } else {
      await commentsService.unresolveThread(
        activeEligibility.organizationId,
        activeEligibility.threadExternalId
      );
    }

    return { status: "written" };
  });
}

async function resolveLocalReviewThread(
  tx: TransactionClient,
  payload: PullRequestReviewThreadPayload,
  activeEligibility: EligibleReviewThread,
  receivedAt: Date
) {
  const author = await resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId: activeEligibility.organizationId,
    author: payload.sender ?? null,
    source: {
      sourceKind: "review_thread",
      githubObjectId: payload.thread.node_id,
      pullNumber: payload.pull_request.number,
    },
  });
  const attribution = resolutionAttribution(payload, author.source, receivedAt);
  return await commentsService.resolveThread(
    activeEligibility.organizationId,
    activeEligibility.threadExternalId,
    receivedAt,
    {
      resolvedById:
        author.source === "github_user_connection" ? author.user.id : null,
      attribution,
    }
  );
}

function resolutionAttribution(
  payload: PullRequestReviewThreadPayload,
  source: "github_user_connection" | "external_comment_author" | "shadow_user",
  receivedAt: Date
): GitHubReviewThreadResolutionAttribution {
  return {
    kind:
      source === "github_user_connection"
        ? GitHubReviewThreadResolutionAttributionKind.ConnectedUser
        : GitHubReviewThreadResolutionAttributionKind.ExternalUnconnected,
    githubUserId:
      payload.sender?.id === null || payload.sender?.id === undefined
        ? null
        : String(payload.sender.id),
    githubNodeId: payload.sender?.node_id ?? null,
    githubLogin: payload.sender?.login ?? null,
    source: "pull_request_review_thread",
    recordedAt: receivedAt.toISOString(),
  };
}

function reviewThreadCommentIds(
  payload: PullRequestReviewThreadPayload
): string[] {
  return payload.thread.comments.flatMap((comment) => {
    const id =
      comment.id === null || comment.id === undefined
        ? null
        : String(comment.id);
    return id ? [id] : [];
  });
}

function sameEligibleReviewThreadScope(
  revalidated: EligibleReviewThread,
  initial: EligibleReviewThread
): boolean {
  return (
    revalidated.organizationId === initial.organizationId &&
    revalidated.documentId === initial.documentId &&
    revalidated.documentSlug === initial.documentSlug &&
    revalidated.threadExternalId === initial.threadExternalId &&
    revalidated.installationId === initial.installationId
  );
}
