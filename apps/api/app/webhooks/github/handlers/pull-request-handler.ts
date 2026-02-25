import type {
  PullRequestClosedEvent,
  PullRequestConvertedToDraftEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReopenedEvent,
  PullRequestSynchronizeEvent,
} from "@octokit/webhooks-types";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 * GitHub sends many PR action types (edited, labeled, assigned, etc.)
 * that we don't process.
 */
const HANDLED_ACTIONS = new Set([
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "ready_for_review",
]);

/**
 * Union type for pull request events we handle.
 * Other PR action types (edited, labeled, assigned, review_requested, etc.)
 * are documented in the handlePullRequest function for future reference.
 */
export type HandledPullRequestEvent =
  | PullRequestClosedEvent
  | PullRequestReopenedEvent
  | PullRequestSynchronizeEvent
  | PullRequestConvertedToDraftEvent
  | PullRequestReadyForReviewEvent;

/** Parse a nullable ISO date string, falling back to current time if null. */
function parseDateOrNow(value: string | null): Date {
  return value ? new Date(value) : new Date();
}

/**
 * Handle GitHub pull_request webhook events.
 *
 * Supported lifecycle actions:
 * - closed: Updates state to MERGED (if merged) or CLOSED, creates corresponding workstream event
 * - reopened: Updates state to OPEN, clears closedAt
 * - synchronize: Updates head SHA when PR is updated with new commits
 * - converted_to_draft: Sets isDraft to true
 * - ready_for_review: Sets isDraft to false
 *
 * Other GitHub PR action types (for future reference):
 * - opened: Initial PR creation (handled by execute workflow, not here)
 * - edited: Title/body/base branch changed
 * - labeled/unlabeled: Labels added/removed
 * - assigned/unassigned: Assignees changed
 * - review_requested/review_request_removed: Reviewers changed
 * - auto_merge_enabled/auto_merge_disabled: Auto-merge toggled
 * - locked/unlocked: Conversation locked/unlocked
 * - milestoned/demilestoned: Milestone changed
 * - enqueued/dequeued: Merge queue operations
 */
export async function handlePullRequest(
  event: HandledPullRequestEvent
): Promise<Response> {
  const { action, pull_request, repository } = event;

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.info("[handlePullRequest] Skipping unhandled action", {
      action,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled pull_request action: ${action}`,
      ok: true,
    });
  }

  log.info("[handlePullRequest] Processing pull_request event", {
    action,
    prNumber: pull_request.number,
    prTitle: pull_request.title,
    prState: pull_request.state,
    isDraft: pull_request.draft,
    merged: "merged" in pull_request ? pull_request.merged : undefined,
    repositoryId: repository.id,
  });

  // All reads and writes in a single transaction to avoid TOCTOU gaps
  await withDb.tx(async (tx) => {
    // Step 1: Find GitHubInstallationRepository by githubRepoId
    const repo = await tx.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: repository.id },
      select: { id: true },
    });

    if (!repo) {
      log.warn("[handlePullRequest] Repository not found in database", {
        githubRepoId: repository.id,
        repositoryFullName: repository.full_name,
        action,
        prNumber: pull_request.number,
      });
      return;
    }

    // Step 2: Find GitHubPullRequest by repositoryId + number
    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: repo.id,
          number: pull_request.number,
        },
      },
      select: {
        id: true,
        workstreamId: true,
        artifactId: true,
        artifact: { select: { slug: true } },
      },
    });

    if (!existingPr) {
      log.warn("[handlePullRequest] Pull request not found in database", {
        repositoryId: repo.id,
        prNumber: pull_request.number,
        action,
        reason: "PR may have been created outside Symphony workflow",
      });
      return;
    }

    // Step 3: Update PR record and create workstream event
    switch (action) {
      case "closed": {
        const closedEvent = event;
        const isMerged = closedEvent.pull_request.merged;
        const newState = isMerged ? "MERGED" : "CLOSED";

        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: {
            state: newState,
            closedAt: parseDateOrNow(pull_request.closed_at),
            mergedAt: pull_request.merged_at
              ? new Date(pull_request.merged_at)
              : null,
            mergeCommitSha: pull_request.merge_commit_sha,
          },
        });

        // Create workstream event
        await tx.workstreamEvent.create({
          data: {
            workstreamId: existingPr.workstreamId,
            type: isMerged ? "GITHUB_PR_MERGED" : "GITHUB_PR_CLOSED",
            actorType: "system",
            data: {
              prNumber: pull_request.number,
              prTitle: pull_request.title,
              prUrl: pull_request.html_url,
              artifactId: existingPr.artifactId,
              slug: existingPr.artifact?.slug,
              ...(isMerged
                ? {
                    mergedAt: pull_request.merged_at,
                    mergeCommitSha: pull_request.merge_commit_sha,
                  }
                : {}),
            },
          },
        });

        log.info("[handlePullRequest] PR closed", {
          prNumber: pull_request.number,
          newState,
          isMerged,
        });
        break;
      }

      case "reopened": {
        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: {
            state: "OPEN",
            closedAt: null,
          },
        });

        log.info("[handlePullRequest] PR reopened", {
          prNumber: pull_request.number,
        });
        break;
      }

      case "synchronize": {
        const syncEvent = event;
        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: {
            headSha: pull_request.head.sha,
          },
        });

        log.info("[handlePullRequest] PR synchronized", {
          prNumber: pull_request.number,
          before: syncEvent.before,
          after: syncEvent.after,
          newHeadSha: pull_request.head.sha,
        });
        break;
      }

      case "converted_to_draft": {
        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: {
            isDraft: true,
          },
        });

        log.info("[handlePullRequest] PR converted to draft", {
          prNumber: pull_request.number,
        });
        break;
      }

      case "ready_for_review": {
        await tx.gitHubPullRequest.update({
          where: { id: existingPr.id },
          data: {
            isDraft: false,
          },
        });

        log.info("[handlePullRequest] PR ready for review", {
          prNumber: pull_request.number,
        });
        break;
      }

      default:
        // Unreachable: HANDLED_ACTIONS guard above filters unhandled actions
        break;
    }
  });

  log.info("[handlePullRequest] Successfully processed pull_request event", {
    action,
    prNumber: pull_request.number,
    githubRepoId: repository.id,
  });

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}
