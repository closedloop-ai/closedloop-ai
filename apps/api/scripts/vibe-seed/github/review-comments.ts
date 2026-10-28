import { createHash } from "node:crypto";
import { GitHubDiffSide } from "@repo/api/src/types/branch-view";
import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { GitHubLegacyCommentState, ThreadStatus } from "@repo/database";
import type { ExternalGitHubUser } from "@/app/comments/external-authors";
import { applyExternal } from "@/app/comments/service/github/apply-external";
import {
  ApplyExternalOutcome,
  type GitHubExternalComment,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
} from "@/app/comments/service/github/apply-external-events";
import {
  GitHubBranchActivityAction,
  GitHubBranchActivityEventName,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import { vibeSeedAvatar } from "../core/person-avatars";
import type { VibeSeedContext } from "../stage";
import { deliverBranchActivity, seedDeliveryId } from "./branch-activity";
import type { SeededBranch } from "./seeded-branches";
import type { BranchWork, GitHubPerson, WorkPullRequest } from "./store-work";

/**
 * ISS-12017: a review conversation on each golden branch's latest pull
 * request, delivered as the GitHub comment webhooks deliver it: through
 * `applyExternal`, which projects the threads and comments, resolves each
 * GitHub author to an `ExternalCommentAuthor`, and through the Branch activity
 * producer for the same review-comment, issue-comment, and review events. A
 * teammate other than the branch's pusher reviews; the pusher replies.
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Each review comment with the pusher's reply to that comment. */
const REVIEW_THREADS = [
  {
    comment:
      "Could this get a focused test? The new path here isn't covered by the existing suite.",
    reply: "Good call, added a test that goes through the new path.",
  },
  {
    comment: "Nit: this reads more clearly as an early return.",
    reply: "Done, it's an early return now.",
  },
  {
    comment:
      "Is this safe when the value is unset? The caller upstream can pass it through empty.",
    reply:
      "It can't be empty here (the parser rejects it first), but I added a guard so that's explicit.",
  },
  {
    comment:
      "Can we keep the old name as an alias for one release so installed clients keep working?",
    reply:
      "Kept the old name as an alias, with a note to remove it next release.",
  },
  {
    comment:
      "This looks like the helper we already have in the shared module; worth importing that one instead?",
    reply: "Yes, switched to the shared helper and deleted this copy.",
  },
] as const;
const APPROVAL = "Looks good, thanks for keeping this one tight.";

export type ReviewConversation = {
  readonly branch: SeededBranch;
  readonly work: BranchWork;
  readonly pullRequest: WorkPullRequest;
  readonly pullRequestDetailId: string;
  readonly reviewer: GitHubPerson;
  readonly now: Date;
};

export async function replayReviewConversation(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork,
  cast: readonly GitHubPerson[]
): Promise<void> {
  const pullRequest = work.pullRequests.at(-1);
  const pullRequestDetailId =
    pullRequest === undefined
      ? undefined
      : branch.pullRequestIdsByNumber.get(pullRequest.number);
  const reviewer = pickReviewer(cast, work.author, pullRequest?.number ?? 0);
  if (
    pullRequest === undefined ||
    pullRequestDetailId === undefined ||
    reviewer === undefined
  ) {
    return;
  }
  const conversation: ReviewConversation = {
    branch,
    work,
    pullRequest,
    pullRequestDetailId,
    reviewer,
    now: new Date(context.now.getTime() - 5 * MINUTE_MS),
  };
  const events = [
    ...reviewThread(conversation),
    ...issueComment(conversation),
    ...reviewSummary(conversation),
  ];
  if (events.length === 0) {
    return;
  }
  const result = await applyExternal({
    provider: CommentSyncProvider.Github,
    organizationId: context.organizationId,
    branchArtifactId: branch.artifactId,
    pullRequestDetailId,
    fetchProvenance: githubAppWebhookFetchProvenance(conversation.now),
    events: events.map(({ event }) => event),
  });
  const refused = result.outcomes.filter(
    (outcome) =>
      outcome !== ApplyExternalOutcome.Applied &&
      outcome !== ApplyExternalOutcome.Unchanged
  );
  if (refused.length > 0) {
    throw new Error(
      `review comments on ${branch.branchName} #${pullRequest.number} were refused: ${refused.join(", ")}`
    );
  }
  for (const { activity } of events) {
    await deliverBranchActivity({
      ...activity,
      attribution: {
        organizationId: context.organizationId,
        branchArtifactId: branch.artifactId,
        pullRequestDetailId,
      },
    });
  }
}

type SeededEvent = {
  event: GitHubExternalEvent;
  activity: { eventName: string; deliveryId: string; payload: unknown };
};

export function reviewThread(conversation: ReviewConversation): SeededEvent[] {
  const { work, pullRequest, reviewer } = conversation;
  const file = work.files[pullRequest.number % Math.max(1, work.files.length)];
  const postedAt = at(conversation, 3 * HOUR_MS);
  const repliedAt = at(conversation, 3 * HOUR_MS + 50 * MINUTE_MS);
  const head = work.pushes.at(-1)?.afterSha ?? null;
  const thread = REVIEW_THREADS[pullRequest.number % REVIEW_THREADS.length];
  if (file === undefined || postedAt === null || thread === undefined) {
    return [];
  }
  const rootId = commentId(conversation, "review");
  const line =
    1 + (pullRequest.number % Math.max(1, Math.min(7, file.additions)));
  const comments = [
    externalComment(conversation, rootId, reviewer, postedAt, {
      body: thread.comment,
      anchor: `discussion_r${rootId}`,
    }),
  ];
  if (repliedAt !== null) {
    const replyId = commentId(conversation, "reply");
    comments.push({
      ...externalComment(conversation, replyId, work.author, repliedAt, {
        body: thread.reply,
        anchor: `discussion_r${replyId}`,
      }),
      githubInReplyToCommentId: rootId,
    });
  }
  return [
    {
      event: {
        kind: GitHubExternalEventKind.ReviewThreadUpsert,
        reviewThreadId: null,
        reviewId: null,
        rootCommentId: rootId,
        position: {
          path: file.path,
          line,
          originalLine: line,
          side: GitHubDiffSide.Right,
          commitSha: head,
        },
        htmlUrl: pullRequestUrl(conversation, `discussion_r${rootId}`),
        comments,
        ...(pullRequest.facts.state === GitHubPRState.Merged
          ? { resolutionStatus: ThreadStatus.RESOLVED }
          : {}),
      },
      activity: {
        eventName: GitHubBranchActivityEventName.PullRequestReviewComment,
        deliveryId: seedDeliveryId("review_comment", rootId),
        payload: {
          action: GitHubBranchActivityAction.Created,
          comment: { created_at: postedAt.toISOString() },
        },
      },
    },
  ];
}

function issueComment(conversation: ReviewConversation): SeededEvent[] {
  const postedAt = at(conversation, 5 * HOUR_MS);
  if (postedAt === null) {
    return [];
  }
  const id = commentId(conversation, "issue");
  const head = conversation.work.pushes.at(-1)?.afterSha.slice(0, 7) ?? "HEAD";
  return [
    {
      event: {
        kind: GitHubExternalEventKind.IssueCommentUpsert,
        htmlUrl: pullRequestUrl(conversation, `issuecomment-${id}`),
        legacyState: GitHubLegacyCommentState.PENDING,
        comment: externalComment(
          conversation,
          id,
          conversation.reviewer,
          postedAt,
          {
            body: `CI is green on ${head}. Approving once the thread above is settled.`,
            anchor: `issuecomment-${id}`,
          }
        ),
      },
      activity: {
        eventName: GitHubBranchActivityEventName.IssueComment,
        deliveryId: seedDeliveryId("issue_comment", id),
        payload: {
          action: GitHubBranchActivityAction.Created,
          issue: { pull_request: {} },
          comment: { created_at: postedAt.toISOString() },
        },
      },
    },
  ];
}

function reviewSummary(conversation: ReviewConversation): SeededEvent[] {
  const { mergedAt } = conversation.pullRequest.facts;
  if (mergedAt === undefined) {
    return [];
  }
  const submittedAt = new Date(Date.parse(mergedAt) - 20 * MINUTE_MS);
  if (submittedAt < conversation.pullRequest.openedAt) {
    return [];
  }
  const id = commentId(conversation, "approval");
  return [
    {
      event: {
        kind: GitHubExternalEventKind.ReviewSummaryUpsert,
        asSubmitted: true,
        reviewId: id,
        htmlUrl: pullRequestUrl(conversation, `pullrequestreview-${id}`),
        comment: externalComment(
          conversation,
          id,
          conversation.reviewer,
          submittedAt,
          { body: APPROVAL, anchor: `pullrequestreview-${id}` }
        ),
      },
      activity: {
        eventName: GitHubBranchActivityEventName.PullRequestReview,
        deliveryId: seedDeliveryId("review", id),
        payload: {
          action: GitHubBranchActivityAction.Submitted,
          review: { submitted_at: submittedAt.toISOString() },
        },
      },
    },
  ];
}

function externalComment(
  conversation: ReviewConversation,
  id: number,
  person: GitHubPerson,
  postedAt: Date,
  content: { body: string; anchor: string }
): GitHubExternalComment {
  return {
    githubCommentId: id,
    htmlUrl: pullRequestUrl(conversation, content.anchor),
    bodyMarkdown: content.body,
    author: externalUser(person),
    createdAt: postedAt,
    providerUpdatedAt: postedAt,
  };
}

function externalUser(person: GitHubPerson): ExternalGitHubUser {
  return {
    id: person.id,
    login: person.login,
    avatar_url: vibeSeedAvatar(person.login),
    html_url: `https://github.com/${person.login}`,
    type: GitHubActorType.User,
  };
}

/** An instant `offsetMs` after the PR opened, or null when that is not yet past. */
function at(conversation: ReviewConversation, offsetMs: number): Date | null {
  const instant = new Date(
    conversation.pullRequest.openedAt.getTime() + offsetMs
  );
  return instant <= conversation.now ? instant : null;
}

function pullRequestUrl(
  conversation: ReviewConversation,
  anchor: string
): string {
  return `https://github.com/${conversation.branch.repositoryFullName}/pull/${conversation.pullRequest.number}#${anchor}`;
}

/** A GitHub-sized numeric id, stable per pull request and comment role. */
function commentId(conversation: ReviewConversation, role: string): number {
  const digest = createHash("sha256")
    .update(
      `${conversation.branch.repositoryFullName}#${conversation.pullRequest.number}:${role}`
    )
    .digest();
  return 2_400_000_000 + (digest.readUInt32BE(0) % 100_000_000);
}

/** A teammate other than the pusher, chosen by the pull request number. */
function pickReviewer(
  cast: readonly GitHubPerson[],
  author: GitHubPerson,
  seed: number
): GitHubPerson | undefined {
  const others = cast.filter((person) => person.login !== author.login);
  return others[seed % Math.max(1, others.length)];
}
