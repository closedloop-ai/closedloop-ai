import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import type {
  CommentAnchor,
  CommentAnchorState,
} from "@repo/api/src/types/comment-anchor";
import {
  COMMENT_SOURCE_POLICIES,
  CommentCapability,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { Result } from "@repo/api/src/types/result";
import type { TransactionClient } from "@repo/database";
import { branchHasCloudEligibility } from "@/app/branches/cloud-branch-eligibility";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  type CommentLiveState,
  type CommentSourcePolicies,
  type CommentViewer,
  createCommentLiveState,
  isItemGranted,
} from "./comment-capabilities";
import {
  type CommentPresenter,
  type EditableComment,
  findCommentOnTarget,
} from "./comment-command-lookup";
import {
  type CommentWrite,
  type CommentWritten,
  runCommentCommand,
} from "./comment-command-pipeline";
import {
  CommentArtifactType,
  type CommentTarget,
  commentPolicyKeyFor,
  commentThreadSources,
  nativeCommentPolicyKey,
  resolveThreadCommentTarget,
  type SourcedCommentTarget,
} from "./comment-target";
import { findThreadOrigin } from "./comment-thread-origin";
import { findArtifactThreadRow } from "./comment-thread-rows";
import { ThreadChangeKind } from "./comment-thread-signal";
import { commentAnchorToStoredJson } from "./trace-comment-anchor-json";
import {
  abandonTraceCommentSync,
  retryTraceCommentSync,
} from "./trace-comment-sync-state";

type CommandActor = {
  viewer: CommentViewer;
  target: CommentTarget;
  liveState?: CommentLiveState;
};

/** The dead-letter row names a root comment, or the thread that root opens. */
export type SyncStateLocator = { commentId: string } | { threadId: string };

/**
 * ISS-10382: records that the desktop outbox spent this root comment's
 * delivery budget. Author only and root only.
 */
export function markSyncAbandoned<T>(
  input: CommandActor & {
    comment: SyncStateLocator;
    present: CommentPresenter<T>;
  },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  return writeSyncState(input, recordWrite, (tx, comment) =>
    abandonTraceCommentSync(tx, {
      organizationId: input.target.organizationId,
      threadId: comment.threadId,
    })
  );
}

/** The author's recovery door: re-pends the dead letter so delivery re-runs. */
export function retrySync<T>(
  input: CommandActor & {
    comment: SyncStateLocator;
    present: CommentPresenter<T>;
  },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  return writeSyncState(input, recordWrite, (tx, comment) =>
    retryTraceCommentSync(tx, {
      threadId: comment.threadId,
      syncStates: comment.syncStates,
    })
  );
}

export function resolveCommentThread<T>(
  input: ThreadStatusInput<T>,
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  return setThreadStatus(input, ThreadStatus.Resolved, recordWrite);
}

export function reopenCommentThread<T>(
  input: ThreadStatusInput<T>,
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  return setThreadStatus(input, ThreadStatus.Open, recordWrite);
}

/**
 * Internal: replaces a thread's anchor and its placement. A connector calls it
 * when the provider reports the anchored position moved or went stale.
 */
export async function reanchor(input: {
  organizationId: string;
  threadId: string;
  anchor: CommentAnchor;
  anchorState: CommentAnchorState;
  liveState: CommentLiveState;
  policies?: CommentSourcePolicies;
}): Promise<Result<{ threadId: string }, CommentErrorCode>> {
  const located = await resolveThreadCommentTarget(input);
  if (!located.ok) {
    return located;
  }
  const { target, source } = located.value;
  const policyKey = commentPolicyKeyFor(target.artifactType, source);
  if (!policyKey) {
    return Result.err(CommentErrorCode.ArtifactTypeNotSupported);
  }
  return runCommentCommand({
    target,
    policyKey,
    liveState: input.liveState,
    capability: null,
    anchor: input.anchor,
    policies: input.policies,
    write: async (
      tx,
      { anchor }
    ): Promise<
      Result<CommentWrite<{ threadId: string }>, CommentErrorCode>
    > => {
      if (!anchor) {
        return Result.err(CommentErrorCode.AnchorInvalid);
      }
      const updated = await tx.commentThread.updateMany({
        where: {
          id: input.threadId,
          organizationId: target.organizationId,
          artifactId: target.artifactId,
        },
        data: {
          anchor: commentAnchorToStoredJson(anchor),
          anchorState: input.anchorState,
        },
      });
      if (updated.count === 0) {
        return Result.err(CommentErrorCode.NotFound);
      }
      return Result.ok({
        changes: [{ threadId: input.threadId, kind: ThreadChangeKind.Updated }],
        present: () => Promise.resolve({ threadId: input.threadId }),
      });
    },
  });
}

type ThreadStatusInput<T> = {
  viewer: CommentViewer;
  threadId: string;
  present: CommentPresenter<T>;
  /** The thread's target, when the caller already resolved it for this request. */
  located?: SourcedCommentTarget;
  liveState?: CommentLiveState;
  policies?: CommentSourcePolicies;
};

async function setThreadStatus<T>(
  input: ThreadStatusInput<T>,
  status: ThreadStatus,
  recordWrite: RecordWriteInTransaction<CommentWritten> | undefined
): Promise<Result<T, CommentErrorCode>> {
  const located: Result<SourcedCommentTarget, CommentErrorCode> = input.located
    ? Result.ok(input.located)
    : await resolveThreadCommentTarget({
        organizationId: input.viewer.organizationId,
        threadId: input.threadId,
      });
  if (!located.ok) {
    return located;
  }
  const { target, source } = located.value;
  const policyKey = commentPolicyKeyFor(target.artifactType, source);
  if (!policyKey) {
    return Result.err(CommentErrorCode.ArtifactTypeNotSupported);
  }
  const capability =
    status === ThreadStatus.Resolved
      ? CommentCapability.Resolve
      : CommentCapability.Reopen;
  const policies = input.policies ?? COMMENT_SOURCE_POLICIES;
  return runCommentCommand({
    target,
    policyKey,
    liveState: input.liveState ?? createCommentLiveState(input.viewer),
    capability,
    policies,
    recordWrite,
    write: async (tx): Promise<Result<CommentWrite<T>, CommentErrorCode>> => {
      const thread = await findArtifactThreadRow(tx, {
        organizationId: target.organizationId,
        artifactId: target.artifactId,
        threadId: input.threadId,
        sources: commentThreadSources(target.artifactType),
      });
      const origin = thread?.comments[0]
        ? await findThreadOrigin(tx, {
            organizationId: target.organizationId,
            threadId: thread.id,
          })
        : null;
      if (!(thread && origin)) {
        return Result.err(CommentErrorCode.NotFound);
      }
      const granted = isItemGranted(
        policies[policyKey].capabilities[capability],
        {
          viewerUserId: input.viewer.userId,
          commentAuthorId: origin.authorId,
          threadAuthorId: origin.authorId,
          threadParticipantIds: new Set(
            thread.comments.map((comment) => comment.authorId)
          ),
        }
      );
      if (!granted) {
        return Result.err(CommentErrorCode.CapabilityDenied);
      }
      // Guarded on the current status so a repeat keeps the first resolver and
      // signals nothing, as the document path's thread-resolution does.
      const { count } = await tx.commentThread.updateMany({
        where: { id: thread.id, status: { not: status } },
        data:
          status === ThreadStatus.Resolved
            ? {
                status,
                resolvedAt: new Date(),
                resolvedById: input.viewer.userId,
              }
            : { status, resolvedAt: null, resolvedById: null },
      });
      return Result.ok({
        changes:
          count === 0
            ? []
            : [{ threadId: thread.id, kind: ThreadChangeKind.Updated }],
        present: (client) => input.present(client, { threadId: thread.id }),
      });
    },
  });
}

/**
 * The dead-letter row's write, guarded alike for marking and retrying. The grant
 * is the thread author's, and the root comment's author is the thread's; the
 * targeted comment's author is checked before it is required to be the root,
 * so a reply id is `capability_denied` for anyone but its author and
 * `not_found` for its author, as the legacy routes answer. A branch that is
 * not cloud-eligible is `not_found`, checked before the write because the
 * transaction commits a callback that returns. A write that returns `false`
 * changed nothing, so the thread's revision stays where it was.
 */
function writeSyncState<T>(
  input: CommandActor & {
    comment: SyncStateLocator;
    present: CommentPresenter<T>;
  },
  recordWrite: RecordWriteInTransaction<CommentWritten> | undefined,
  write: (tx: TransactionClient, comment: EditableComment) => Promise<boolean>
): Promise<Result<T, CommentErrorCode>> {
  const { viewer, target } = input;
  const policyKey = nativeCommentPolicyKey(target.artifactType);
  return runCommentCommand({
    target,
    policyKey,
    liveState: input.liveState ?? createCommentLiveState(viewer),
    capability: CommentCapability.RetrySync,
    recordWrite,
    write: async (tx): Promise<Result<CommentWrite<T>, CommentErrorCode>> => {
      const found = await findSyncStateComment(tx, target, input.comment);
      if (!found.ok) {
        return found;
      }
      const comment = found.value;
      if (comment.authorId !== viewer.userId) {
        return Result.err(CommentErrorCode.CapabilityDenied);
      }
      if (!comment.isRoot) {
        return Result.err(CommentErrorCode.NotFound);
      }
      if (!(await isTargetStillServed(tx, target))) {
        return Result.err(CommentErrorCode.NotFound);
      }
      const changed = await write(tx, comment);
      return Result.ok({
        changes: changed
          ? [{ threadId: comment.threadId, kind: ThreadChangeKind.Updated }]
          : [],
        commentId: comment.commentId,
        present: (client) =>
          input.present(client, { threadId: comment.threadId }),
      });
    },
  });
}

/** A branch's comments are served only while it is cloud-eligible. */
async function isTargetStillServed(
  tx: TransactionClient,
  target: CommentTarget
): Promise<boolean> {
  return (
    target.artifactType !== CommentArtifactType.Branch ||
    (await branchHasCloudEligibility(
      tx,
      target.organizationId,
      target.artifactId
    ))
  );
}

async function findSyncStateComment(
  tx: TransactionClient,
  target: CommentTarget,
  locator: SyncStateLocator
): Promise<Result<EditableComment, CommentErrorCode>> {
  if ("commentId" in locator) {
    return findCommentOnTarget(tx, target, locator.commentId);
  }
  const thread = await findArtifactThreadRow(tx, {
    organizationId: target.organizationId,
    artifactId: target.artifactId,
    threadId: locator.threadId,
  });
  const rootId =
    thread?.source === ThreadSource.Native ? thread.comments[0]?.id : undefined;
  return rootId
    ? findCommentOnTarget(tx, target, rootId)
    : Result.err(CommentErrorCode.NotFound);
}
