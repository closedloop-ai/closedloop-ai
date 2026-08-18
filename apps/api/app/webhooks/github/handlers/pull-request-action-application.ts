import type {
  PullRequestClosedEvent,
  PullRequestConvertedToDraftEvent,
  PullRequestEditedEvent,
  PullRequestOpenedEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReopenedEvent,
  PullRequestSynchronizeEvent,
} from "@octokit/webhooks-types";
import {
  BranchHeadShaSource,
  BranchPushSource,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ChecksStatus, type TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";
import { stampBranchFirstPush } from "@/app/branches/branch-push-state";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import { pullRequestToDetailUpdate } from "./pull-request-detail-update";
import { pullRequestState } from "./pull-request-lifecycle-decision";

/** Pull-request webhook actions whose existing projection this service owns. */
export type HandledPullRequestEvent =
  | PullRequestOpenedEvent
  | PullRequestEditedEvent
  | PullRequestClosedEvent
  | PullRequestReopenedEvent
  | PullRequestSynchronizeEvent
  | PullRequestConvertedToDraftEvent
  | PullRequestReadyForReviewEvent;

type PullRequestActionTarget = {
  id: string;
  headSha: string | null;
};

/** Apply one accepted pull-request action without deriving Branch activity. */
export async function applyPullRequestAction(
  tx: TransactionClient,
  event: HandledPullRequestEvent,
  existingPr: PullRequestActionTarget
): Promise<void> {
  const { action, pull_request: pullRequest } = event;
  switch (action) {
    case "opened":
    case "edited": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: pullRequestState(pullRequest) },
        select: { id: true },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
        select: { id: true },
      });
      log.debug("[handlePullRequest] PR metadata refreshed", {
        action,
        prNumber: pullRequest.number,
      });
      break;
    }

    case "closed": {
      const isMerged = event.pull_request.merged;
      const newState = isMerged ? GitHubPRState.Merged : GitHubPRState.Closed;
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: newState },
        select: { id: true },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: {
          ...pullRequestToDetailUpdate(pullRequest),
          prState: newState,
          closedAt: parseDateOrNow(pullRequest.closed_at),
        },
        select: { id: true },
      });
      log.debug("[handlePullRequest] PR closed", {
        prNumber: pullRequest.number,
        newState,
        isMerged,
      });
      break;
    }

    case "reopened": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: GitHubPRState.Open },
        select: { id: true },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
        select: { id: true },
      });
      log.debug("[handlePullRequest] PR reopened", {
        prNumber: pullRequest.number,
      });
      break;
    }

    case "synchronize": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: GitHubPRState.Open },
        select: { id: true },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
        select: { id: true },
      });
      const branchUpdate = await tx.branchDetail.updateMany({
        where: { artifactId: existingPr.id },
        data: {
          headSha: pullRequest.head.sha,
          headShaSource: BranchHeadShaSource.PullRequestWebhook,
          headShaObservedAt: new Date(),
          lastPushBeforeSha: null,
          checksStatus: ChecksStatus.PENDING,
        },
      });
      if (
        branchUpdate.count > 0 &&
        existingPr.headSha !== pullRequest.head.sha
      ) {
        await invalidateBranchStatusChecksForHeadChange(tx, existingPr.id);
      }
      await stampBranchFirstPush(
        tx,
        existingPr.id,
        parseDateOrNow(pullRequest.updated_at),
        BranchPushSource.Webhook
      );
      log.debug("[handlePullRequest] PR synchronized", {
        prNumber: pullRequest.number,
        before: event.before,
        after: event.after,
        newHeadSha: pullRequest.head.sha,
      });
      break;
    }

    case "converted_to_draft": {
      await updateOpenPullRequest(tx, existingPr.id, pullRequest);
      log.debug("[handlePullRequest] PR converted to draft", {
        prNumber: pullRequest.number,
      });
      break;
    }

    case "ready_for_review": {
      await updateOpenPullRequest(tx, existingPr.id, pullRequest);
      log.debug("[handlePullRequest] PR ready for review", {
        prNumber: pullRequest.number,
      });
      break;
    }

    default:
      return exhaustivePullRequestAction(action);
  }
}

async function updateOpenPullRequest(
  tx: TransactionClient,
  branchArtifactId: string,
  pullRequest: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  await tx.artifact.update({
    where: { id: branchArtifactId },
    data: { status: GitHubPRState.Open },
    select: { id: true },
  });
  await tx.pullRequestDetail.update({
    where: { githubId: String(pullRequest.id) },
    data: pullRequestToDetailUpdate(pullRequest),
    select: { id: true },
  });
}

function parseDateOrNow(value: string | null): Date {
  return value ? new Date(value) : new Date();
}

function exhaustivePullRequestAction(action: never): never {
  throw new Error(`Unhandled pull request action: ${String(action)}`);
}
