import { GitHubCommentThreadKind } from "@repo/database";
import {
  CommentDataInvalidReason,
  reportCommentDataInvalid,
} from "@/app/comments/comment-data-invalid";
import type { createExternalGitHubAuthorResolutionCache } from "@/app/comments/external-author-resolution-cache";
import type { ExternalGitHubAuthorSource } from "@/app/comments/external-authors";
import { ThreadChangeKind } from "../comment-thread-signal";
import {
  type ApplyExternalContext,
  markGitHubCommentSynced,
  recordThreadChange,
  type StoredGitHubCommentWithThread,
  type StoredGitHubThread,
  storedCommentKey,
} from "./apply-external-context";
import {
  ApplyExternalOutcome,
  type GitHubExternalComment,
  GitHubExternalEventKind,
  type GitHubUpsertEvent,
} from "./apply-external-events";
import {
  CommentWriteVerdict,
  decideCommentWrite,
  isAcceptedVerdict,
  strongestRejection,
} from "./apply-external-ordering";
import {
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
  upsertGitHubReviewSummaryThread,
} from "./github-projection";
import type {
  BaseGitHubThreadProjectionInput,
  GitHubProjectionCommentInput,
  GitHubReviewThreadPosition,
  UpsertGitHubProjectionResult,
} from "./github-projection-contract";
import { linkUnparentedGitHubReplies } from "./github-projection-reply-links";
import {
  githubThreadAnchor,
  writeGitHubThreadAnchor,
} from "./github-thread-anchor";

type JudgedComment = {
  comment: GitHubExternalComment;
  stored: StoredGitHubCommentWithThread | null;
  verdict: CommentWriteVerdict;
};

const AUTHOR_SOURCE_KIND_BY_EVENT = {
  [GitHubExternalEventKind.ReviewThreadUpsert]: "review_comment",
  [GitHubExternalEventKind.IssueCommentUpsert]: "issue_comment",
  [GitHubExternalEventKind.ReviewSummaryUpsert]: "review",
} as const satisfies Record<
  GitHubUpsertEvent["kind"],
  ExternalGitHubAuthorSource["sourceKind"]
>;

const REJECTION_OUTCOME = {
  [CommentWriteVerdict.RejectOlder]: ApplyExternalOutcome.RejectedOlder,
  [CommentWriteVerdict.RejectDeleted]: ApplyExternalOutcome.RejectedDeleted,
  [CommentWriteVerdict.RejectFuture]: ApplyExternalOutcome.RejectedFuture,
  [CommentWriteVerdict.Apply]: ApplyExternalOutcome.Applied,
  [CommentWriteVerdict.Same]: ApplyExternalOutcome.Unchanged,
} as const satisfies Record<CommentWriteVerdict, ApplyExternalOutcome>;

/** The comments an upsert event carries, under the remote ids they are stored at. */
export function upsertEventComments(
  event: GitHubUpsertEvent
): GitHubExternalComment[] {
  switch (event.kind) {
    case GitHubExternalEventKind.ReviewThreadUpsert:
      return event.comments;
    case GitHubExternalEventKind.ReviewSummaryUpsert:
      return [{ ...event.comment, githubCommentId: event.reviewId }];
    case GitHubExternalEventKind.IssueCommentUpsert:
      return [event.comment];
    default:
      return assertNeverEvent(event);
  }
}

function upsertEventThreadKind(
  event: GitHubUpsertEvent
): GitHubCommentThreadKind {
  switch (event.kind) {
    case GitHubExternalEventKind.ReviewThreadUpsert:
      return GitHubCommentThreadKind.REVIEW_THREAD;
    case GitHubExternalEventKind.IssueCommentUpsert:
      return GitHubCommentThreadKind.ISSUE_COMMENT;
    case GitHubExternalEventKind.ReviewSummaryUpsert:
      return GitHubCommentThreadKind.REVIEW_SUMMARY;
    default:
      return assertNeverEvent(event);
  }
}

function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled GitHub upsert event: ${JSON.stringify(event)}`);
}

/**
 * Steps 2 to 5 for one upsert event. Returns the strongest rejection when no
 * comment passes the ordering rules and `Unchanged` when neither a comment nor
 * the thread differs from what is stored; otherwise the event is written and
 * its thread recorded for its signal.
 */
export async function applyUpsertEvent(
  ctx: ApplyExternalContext,
  incoming: GitHubUpsertEvent,
  resolveAuthor: ReturnType<typeof createExternalGitHubAuthorResolutionCache>
): Promise<ApplyExternalOutcome> {
  const threadKind = upsertEventThreadKind(incoming);
  const judged = upsertEventComments(incoming).map((comment) =>
    judgeComment(ctx, incoming, threadKind, comment)
  );
  reportFutureKeys(ctx, judged);
  const accepted = judged.filter((entry) => isAcceptedVerdict(entry.verdict));
  if (accepted.length === 0) {
    return REJECTION_OUTCOME[
      strongestRejection(judged.map((entry) => entry.verdict))
    ];
  }
  const applied = accepted.filter(
    (entry) => entry.verdict === CommentWriteVerdict.Apply
  );
  const storedThread = accepted.find((entry) => entry.stored)?.stored?.thread;
  const event = withoutThreadFieldsOlderThan(
    incoming,
    storedThread,
    isRootApplied(incoming, judged)
  );
  if (applied.length === 0 && !threadFieldsChanged(storedThread, event)) {
    return await linkRepliesOfUnchangedEvent(ctx, accepted);
  }

  const comments: GitHubProjectionCommentInput[] = [];
  for (const entry of accepted) {
    comments.push(
      await projectionComment(ctx, event, entry.comment, resolveAuthor)
    );
  }
  const result = await writeUpsert(ctx, event, comments);
  await confirmAppliedComments(ctx, accepted, result);
  if (event.kind === GitHubExternalEventKind.ReviewThreadUpsert) {
    await linkUnparentedGitHubReplies(ctx.tx, result.threadId);
  }
  if (result.createdThread || !isReplyThreadEvent(event)) {
    await keepThreadAnchorCurrent(ctx, event, result.threadId);
  }
  recordThreadChange(
    ctx,
    result.createdThread
      ? {
          threadId: result.createdThread.id,
          kind: ThreadChangeKind.Created,
          revision: result.createdThread.revision,
        }
      : { threadId: result.threadId, kind: ThreadChangeKind.Updated }
  );
  return ApplyExternalOutcome.Applied;
}

function judgeComment(
  ctx: ApplyExternalContext,
  event: GitHubUpsertEvent,
  threadKind: GitHubCommentThreadKind,
  comment: GitHubExternalComment
): JudgedComment {
  const stored =
    ctx.stored.get(storedCommentKey(threadKind, comment.githubCommentId)) ??
    null;
  return {
    comment,
    stored,
    verdict: decideCommentWrite({
      stored,
      incomingKey: comment.providerUpdatedAt,
      incomingBody: comment.bodyMarkdown,
      reviveDeletedBefore: event.reviveDeletedBefore ?? null,
      listedAt: event.listedAt ?? null,
      firstVersion:
        event.kind === GitHubExternalEventKind.ReviewSummaryUpsert &&
        event.asSubmitted === true,
      now: ctx.now,
    }),
  };
}

/**
 * An event that changes nothing still fills a reply's missing parent link once
 * the comment it answers is stored (a reply delivered before its root).
 */
async function linkRepliesOfUnchangedEvent(
  ctx: ApplyExternalContext,
  accepted: readonly JudgedComment[]
): Promise<ApplyExternalOutcome> {
  const unlinked = accepted.find(
    (entry) =>
      entry.comment.githubInReplyToCommentId != null &&
      entry.stored?.parentCommentId === null
  );
  if (!unlinked?.stored) {
    return ApplyExternalOutcome.Unchanged;
  }
  const threadId = unlinked.stored.threadId;
  if ((await linkUnparentedGitHubReplies(ctx.tx, threadId)) === 0) {
    return ApplyExternalOutcome.Unchanged;
  }
  recordThreadChange(ctx, { threadId, kind: ThreadChangeKind.Updated });
  return ApplyExternalOutcome.Applied;
}

function reportFutureKeys(
  ctx: ApplyExternalContext,
  judged: readonly JudgedComment[]
): void {
  for (const entry of judged) {
    if (entry.verdict === CommentWriteVerdict.RejectFuture) {
      reportCommentDataInvalid({
        reason: CommentDataInvalidReason.ProviderTimestampInFuture,
        organizationId: ctx.organizationId,
        providerObjectId: String(entry.comment.githubCommentId),
        ...(entry.stored ? { threadId: entry.stored.threadId } : {}),
      });
    }
  }
}

/**
 * Whether the thread-level fields of an event differ from what is stored, so a
 * moved position or a changed resolution is written even when every comment
 * is unchanged. A thread with no stored comment is always new.
 */
function threadFieldsChanged(
  stored: StoredGitHubThread | undefined,
  event: GitHubUpsertEvent
): boolean {
  if (!stored || stored.deleted) {
    return true;
  }
  if (
    event.resolutionStatus != null &&
    event.resolutionStatus !== stored.status
  ) {
    return true;
  }
  if (event.legacyState != null && event.legacyState !== stored.legacyState) {
    return true;
  }
  if (isReplyThreadEvent(event)) {
    return false;
  }
  if (event.htmlUrl !== undefined && event.htmlUrl !== stored.htmlUrl) {
    return true;
  }
  if (event.kind !== GitHubExternalEventKind.ReviewThreadUpsert) {
    return false;
  }
  return (
    (event.reviewThreadId !== null &&
      event.reviewThreadId !== stored.reviewThreadId) ||
    (event.reviewId ?? null) !== stored.reviewId ||
    positionChanged(event.position, stored)
  );
}

const POSITION_FIELDS = [
  "path",
  "line",
  "originalLine",
  "side",
  "startLine",
  "startSide",
  "commitSha",
] as const satisfies readonly (keyof GitHubReviewThreadPosition)[];

function positionChanged(
  incoming: GitHubReviewThreadPosition,
  stored: GitHubReviewThreadPosition
): boolean {
  return POSITION_FIELDS.some(
    (field) => (incoming[field] ?? null) !== (stored[field] ?? null)
  );
}

async function projectionComment(
  ctx: ApplyExternalContext,
  event: GitHubUpsertEvent,
  comment: GitHubExternalComment,
  resolveAuthor: ReturnType<typeof createExternalGitHubAuthorResolutionCache>
): Promise<GitHubProjectionCommentInput> {
  const author = await resolveAuthor(comment.author, {
    sourceKind: AUTHOR_SOURCE_KIND_BY_EVENT[event.kind],
    githubObjectId: String(comment.githubCommentId),
    ...(ctx.repositoryId ? { repositoryId: ctx.repositoryId } : {}),
    pullNumber: ctx.pullNumber,
  });
  return {
    githubCommentId: comment.githubCommentId,
    githubInReplyToCommentId: comment.githubInReplyToCommentId ?? null,
    githubHtmlUrl: comment.htmlUrl,
    githubUpdatedAt: comment.providerUpdatedAt,
    bodyMarkdown: comment.bodyMarkdown,
    author: {
      userId: author.user.id,
      externalAuthorId: author.externalAuthor.id,
    },
    createdAt: comment.createdAt,
  };
}

function writeUpsert(
  ctx: ApplyExternalContext,
  event: GitHubUpsertEvent,
  comments: GitHubProjectionCommentInput[]
): Promise<UpsertGitHubProjectionResult> {
  const base: BaseGitHubThreadProjectionInput = {
    organizationId: ctx.organizationId,
    branchArtifactId: ctx.branchArtifactId,
    pullRequestDetailId: ctx.pullRequestDetailId,
    htmlUrl: event.htmlUrl ?? comments[0]?.githubHtmlUrl ?? null,
    legacyState: event.legacyState ?? null,
    resolutionStatus: event.resolutionStatus ?? null,
    ...(event.listedAt ? { resolutionReadAt: event.listedAt } : {}),
    lastSyncedAt: ctx.now,
    fetchProvenance: ctx.fetchProvenance,
    revive: event.reviveDeletedBefore !== undefined,
  };
  if (event.kind === GitHubExternalEventKind.ReviewThreadUpsert) {
    return upsertGitHubReviewCommentThread(ctx.tx, {
      ...base,
      ...event.position,
      reviewThreadId: event.reviewThreadId,
      reviewId: event.reviewId,
      rootCommentId: event.rootCommentId,
      comments,
      threadFieldsFromReply: isReplyThreadEvent(event),
    });
  }
  const [comment] = comments;
  if (!comment) {
    throw new Error("GitHub comment upsert requires its comment");
  }
  switch (event.kind) {
    case GitHubExternalEventKind.ReviewSummaryUpsert:
      return upsertGitHubReviewSummaryThread(ctx.tx, {
        ...base,
        reviewId: event.reviewId,
        comment,
      });
    case GitHubExternalEventKind.IssueCommentUpsert:
      return upsertGitHubIssueCommentThread(ctx.tx, { ...base, comment });
    default:
      return assertNeverEvent(event);
  }
}

/**
 * Step 4: each applied comment's revision moves on once (a new one keeps the
 * revision it was created at) and its GitHub sync state is confirmed at the
 * key that was written. A comment judged the same as stored is left alone.
 */
async function confirmAppliedComments(
  ctx: ApplyExternalContext,
  accepted: readonly JudgedComment[],
  result: UpsertGitHubProjectionResult
): Promise<void> {
  const updatedIds: string[] = [];
  const synced: { commentId: string; key: Date; revision: number }[] = [];
  for (const [index, entry] of accepted.entries()) {
    const commentId = result.commentIds[index];
    if (!commentId || entry.verdict !== CommentWriteVerdict.Apply) {
      continue;
    }
    const revision = entry.stored ? entry.stored.revision + 1 : 0;
    if (entry.stored) {
      updatedIds.push(commentId);
    }
    synced.push({ commentId, key: entry.comment.providerUpdatedAt, revision });
  }
  if (updatedIds.length > 0) {
    await ctx.tx.comment.updateMany({
      where: { id: { in: updatedIds } },
      data: { revision: { increment: 1 } },
    });
  }
  for (const entry of synced) {
    await markGitHubCommentSynced(ctx, {
      commentId: entry.commentId,
      providerUpdatedAt: entry.key,
      syncedRevision: entry.revision,
    });
  }
}

async function keepThreadAnchorCurrent(
  ctx: ApplyExternalContext,
  event: GitHubUpsertEvent,
  threadId: string
): Promise<void> {
  const position =
    event.kind === GitHubExternalEventKind.ReviewThreadUpsert
      ? event.position
      : null;
  const anchor = githubThreadAnchor(position, ctx.repositoryFullName);
  if (!anchor) {
    reportCommentDataInvalid({
      reason: CommentDataInvalidReason.ProviderAnchorInvalid,
      organizationId: ctx.organizationId,
      threadId,
    });
    return;
  }
  await writeGitHubThreadAnchor(ctx.tx, threadId, anchor);
}

function isReplyThreadEvent(event: GitHubUpsertEvent): boolean {
  return (
    event.kind === GitHubExternalEventKind.ReviewThreadUpsert &&
    event.threadFieldsFromReply === true
  );
}

/**
 * A list's thread fields have no provider key, so they lose to any local
 * write to the thread after the list was read: a resolve or unresolve webhook,
 * or a root edit that moved the position, committed in between is newer than
 * the list. A review thread's position, URL, review and anchor are then kept
 * as stored, as a reply's are, unless the list's root is newer than the stored
 * root: the position is the root's, so it moves with the root.
 */
function withoutThreadFieldsOlderThan(
  event: GitHubUpsertEvent,
  storedThread: StoredGitHubThread | undefined,
  rootApplied: boolean
): GitHubUpsertEvent {
  if (
    !(event.listedAt && storedThread) ||
    storedThread.updatedAt.getTime() < event.listedAt.getTime()
  ) {
    return event;
  }
  const listed = { resolutionStatus: null, legacyState: null } as const;
  return event.kind === GitHubExternalEventKind.ReviewThreadUpsert &&
    !rootApplied
    ? { ...event, ...listed, threadFieldsFromReply: true }
    : { ...event, ...listed };
}

function isRootApplied(
  event: GitHubUpsertEvent,
  judged: readonly JudgedComment[]
): boolean {
  if (event.kind !== GitHubExternalEventKind.ReviewThreadUpsert) {
    return false;
  }
  const rootCommentId = String(event.rootCommentId);
  return judged.some(
    (entry) =>
      String(entry.comment.githubCommentId) === rootCommentId &&
      entry.verdict === CommentWriteVerdict.Apply
  );
}
