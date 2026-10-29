import { ThreadSource, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  CommentDataInvalidReason,
  reportCommentDataInvalid,
} from "@/app/comments/comment-data-invalid";
import { createExternalGitHubAuthorResolutionCache } from "@/app/comments/external-author-resolution-cache";
import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";
import { commitThreadChanges } from "../comment-command-pipeline";
import { CommentArtifactType } from "../comment-target";
import { ThreadChangeKind } from "../comment-thread-signal";
import {
  resolveThreadByExternalId,
  unresolveThreadByExternalId,
} from "../thread-resolution";
import {
  type ApplyExternalContext,
  loadStoredGitHubComments,
  lockGitHubComments,
  markGitHubCommentSynced,
  recordThreadChange,
  storedCommentKey,
} from "./apply-external-context";
import {
  type ApplyExternalInput,
  ApplyExternalOutcome,
  type ApplyExternalResult,
  type GitHubCommentDeleteEvent,
  type GitHubExternalEvent,
  GitHubExternalEventKind,
  type GitHubListCleanupEvent,
  type GitHubThreadStatusEvent,
  type GitHubUpsertEvent,
} from "./apply-external-events";
import { applyUpsertEvent, upsertEventComments } from "./apply-external-upsert";
import {
  softDeleteAbsentGitHubComments,
  softDeleteGitHubCommentRowsByRemoteId,
} from "./github-projection-delete";
import {
  GitHubProjectionNoWriteError,
  requireRemoteCommentId,
} from "./github-projection-identity";

const LOG_PREFIX = "[comments/applyExternal]";

/**
 * The comment service's internal command for provider connectors (PLN-2122
 * Step 3). Every GitHub comment write the provider reports — webhook and
 * reconcile — comes through here, atomically per call: every event is held to the ordering
 * and terminal-delete rules (decisions 1 and 2). Connectors pass no viewer, so
 * there is no capability check; the organization, branch and pull request
 * scope every read and write, and every anchor is validated before it is
 * stored.
 */
export function applyExternal(
  input: ApplyExternalInput
): Promise<ApplyExternalResult> {
  return withDb.tx((tx) => applyExternalInTransaction(tx, input));
}

async function applyExternalInTransaction(
  tx: TransactionClient,
  input: ApplyExternalInput
): Promise<ApplyExternalResult> {
  const pullRequest = await tx.pullRequestDetail.findFirst({
    where: {
      id: input.pullRequestDetailId,
      branchArtifactId: input.branchArtifactId,
      organizationId: input.organizationId,
    },
    select: { number: true, repositoryId: true, repositoryFullName: true },
  });
  if (!pullRequest) {
    return {
      outcomes: input.events.map(() => ApplyExternalOutcome.NotFound),
      changedThreadIds: [],
    };
  }
  const remoteIds = input.events.flatMap(eventRemoteCommentIds);
  await lockGitHubComments(tx, input.organizationId, remoteIds);
  const ctx: ApplyExternalContext = {
    tx,
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
    pullNumber: pullRequest.number,
    repositoryId: pullRequest.repositoryId,
    repositoryFullName: pullRequest.repositoryFullName,
    fetchProvenance: input.fetchProvenance,
    now: new Date(),
    stored: await loadStoredGitHubComments(tx, input, remoteIds),
    changes: new Map(),
    retractedComments: 0,
  };
  const resolveAuthor = createExternalGitHubAuthorResolutionCache(
    tx,
    input.organizationId
  );

  const outcomes: ApplyExternalOutcome[] = [];
  for (const event of input.events) {
    outcomes.push(await applyEventOrSkip(ctx, event, resolveAuthor));
  }

  const changes = [...ctx.changes.values()];
  await commitThreadChanges(tx, {
    target: {
      organizationId: input.organizationId,
      artifactId: input.branchArtifactId,
      artifactType: CommentArtifactType.Branch,
    },
    outboundSyncProvider: null,
    changes,
  });
  return {
    outcomes,
    changedThreadIds: changes.map((c) => c.threadId),
    ...(ctx.retractedComments > 0
      ? { retractedComments: ctx.retractedComments }
      : {}),
  };
}

async function applyEventOrSkip(
  ctx: ApplyExternalContext,
  event: GitHubExternalEvent,
  resolveAuthor: ReturnType<typeof createExternalGitHubAuthorResolutionCache>
): Promise<ApplyExternalOutcome> {
  try {
    return await applyEvent(ctx, event, resolveAuthor);
  } catch (error) {
    if (!(error instanceof GitHubProjectionNoWriteError)) {
      throw error;
    }
    log.warn(`${LOG_PREFIX} Skipping projection no-write`, {
      code: error.code,
      details: error.details,
      eventKind: event.kind,
      organizationId: ctx.organizationId,
      branchArtifactId: ctx.branchArtifactId,
      pullRequestDetailId: ctx.pullRequestDetailId,
    });
    return ApplyExternalOutcome.NoWrite;
  }
}

function applyEvent(
  ctx: ApplyExternalContext,
  event: GitHubExternalEvent,
  resolveAuthor: ReturnType<typeof createExternalGitHubAuthorResolutionCache>
): Promise<ApplyExternalOutcome> {
  switch (event.kind) {
    case GitHubExternalEventKind.ReviewThreadUpsert:
    case GitHubExternalEventKind.IssueCommentUpsert:
    case GitHubExternalEventKind.ReviewSummaryUpsert:
      return applyUpsertEvent(ctx, event, resolveAuthor);
    case GitHubExternalEventKind.CommentDelete:
      return applyCommentDelete(ctx, event);
    case GitHubExternalEventKind.ListCleanup:
      return applyListCleanup(ctx, event);
    case GitHubExternalEventKind.ThreadStatus:
      return applyThreadStatus(ctx, event);
    default:
      return assertNever(event);
  }
}

/**
 * PLN-2122 decision 2: a delete of a stored comment is terminal and records
 * the payload's `comment.updated_at` as its key, so no later `created` or
 * `edited` delivery for the id can bring it back. A delete for an id not yet
 * stored records nothing, so a `created` delivered after it is written; the
 * next complete list removes it.
 */
async function applyCommentDelete(
  ctx: ApplyExternalContext,
  event: GitHubCommentDeleteEvent
): Promise<ApplyExternalOutcome> {
  const stored = ctx.stored.get(
    storedCommentKey(event.threadKind, event.githubCommentId)
  );
  if (!stored) {
    return ApplyExternalOutcome.NotFound;
  }
  if (stored.deleted) {
    return ApplyExternalOutcome.Unchanged;
  }
  if (
    event.providerUpdatedAt &&
    !isWithinTrustedFutureBoundary(event.providerUpdatedAt, ctx.now)
  ) {
    reportCommentDataInvalid({
      reason: CommentDataInvalidReason.ProviderTimestampInFuture,
      organizationId: ctx.organizationId,
      threadId: stored.threadId,
      providerObjectId: requireRemoteCommentId(event.githubCommentId),
    });
    return ApplyExternalOutcome.RejectedFuture;
  }
  const rows = await softDeleteGitHubCommentRowsByRemoteId(ctx.tx, {
    organizationId: ctx.organizationId,
    branchArtifactId: ctx.branchArtifactId,
    pullRequestDetailId: ctx.pullRequestDetailId,
    githubCommentId: event.githubCommentId,
    threadKind: event.threadKind,
    deletedAt: ctx.now,
    fetchProvenance: ctx.fetchProvenance,
  });
  if (rows.commentIds.length === 0) {
    return ApplyExternalOutcome.NotFound;
  }
  for (const commentId of rows.commentIds) {
    await markGitHubCommentSynced(ctx, {
      commentId,
      providerUpdatedAt: event.providerUpdatedAt ?? stored.key,
      syncedRevision: stored.revision,
    });
  }
  recordUpdatedThreads(ctx, rows.threadIds);
  return ApplyExternalOutcome.Applied;
}

/**
 * Reconcile Step 5: a complete provider list is evidence that every stored
 * comment of its kind missing from it, and older than the list, was deleted
 * upstream. The comments it deletes are locked like a webhook's, so a cleanup
 * is applied in a call of its own: those locks come after any the call
 * already holds.
 */
async function applyListCleanup(
  ctx: ApplyExternalContext,
  event: GitHubListCleanupEvent
): Promise<ApplyExternalOutcome> {
  const rows = await softDeleteAbsentGitHubComments(
    ctx.tx,
    {
      organizationId: ctx.organizationId,
      branchArtifactId: ctx.branchArtifactId,
      pullRequestDetailId: ctx.pullRequestDetailId,
      threadKind: event.threadKind,
      liveGithubCommentIds: event.liveGithubCommentIds,
      listedAt: event.listedAt,
      maxComments: event.maxComments,
      deletedAt: ctx.now,
      fetchProvenance: ctx.fetchProvenance,
    },
    (githubCommentIds) =>
      lockGitHubComments(ctx.tx, ctx.organizationId, githubCommentIds)
  );
  recordUpdatedThreads(ctx, rows.threadIds);
  ctx.retractedComments += rows.commentIds.length;
  return rows.threadIds.length > 0
    ? ApplyExternalOutcome.Applied
    : ApplyExternalOutcome.Unchanged;
}

/**
 * A `pull_request_review_thread` resolution the provider already confirmed:
 * applied as-is, with no ordering key (campaign ruling for PLN-2122).
 */
async function applyThreadStatus(
  ctx: ApplyExternalContext,
  event: GitHubThreadStatusEvent
): Promise<ApplyExternalOutcome> {
  const thread = await ctx.tx.commentThread.findFirst({
    where: {
      organizationId: ctx.organizationId,
      externalId: event.threadExternalId,
      artifactId: ctx.branchArtifactId,
      source: ThreadSource.GITHUB,
    },
    select: { id: true },
  });
  if (!thread) {
    return ApplyExternalOutcome.NotFound;
  }
  const result = event.resolved
    ? await resolveThreadByExternalId(
        ctx.organizationId,
        event.threadExternalId,
        event.resolvedAt,
        { resolvedById: event.resolvedById, attribution: event.attribution }
      )
    : await unresolveThreadByExternalId(
        ctx.organizationId,
        event.threadExternalId
      );
  if (!result || result.kind === "noop") {
    return ApplyExternalOutcome.Unchanged;
  }
  recordUpdatedThreads(ctx, [result.thread.id]);
  return ApplyExternalOutcome.Applied;
}

function recordUpdatedThreads(
  ctx: ApplyExternalContext,
  threadIds: readonly string[]
): void {
  for (const threadId of threadIds) {
    recordThreadChange(ctx, { threadId, kind: ThreadChangeKind.Updated });
  }
}

/**
 * The comment ids an event's locks cover. A review-thread event also locks its
 * root, the one id every writer of that thread names (a reply's root is its
 * `in_reply_to_id`), so writers that create or delete the same thread run one
 * at a time.
 */
function eventRemoteCommentIds(event: GitHubExternalEvent): string[] {
  if (isUpsertEvent(event)) {
    const ids = upsertEventComments(event).map((comment) =>
      requireRemoteCommentId(comment.githubCommentId)
    );
    if (event.kind === GitHubExternalEventKind.ReviewThreadUpsert) {
      ids.push(requireRemoteCommentId(event.rootCommentId));
    }
    return ids;
  }
  if (event.kind === GitHubExternalEventKind.CommentDelete) {
    return [requireRemoteCommentId(event.githubCommentId)];
  }
  return [];
}

function isUpsertEvent(event: GitHubExternalEvent): event is GitHubUpsertEvent {
  return (
    event.kind === GitHubExternalEventKind.ReviewThreadUpsert ||
    event.kind === GitHubExternalEventKind.IssueCommentUpsert ||
    event.kind === GitHubExternalEventKind.ReviewSummaryUpsert
  );
}

function assertNever(event: never): never {
  throw new Error(`Unhandled GitHub external event: ${JSON.stringify(event)}`);
}
