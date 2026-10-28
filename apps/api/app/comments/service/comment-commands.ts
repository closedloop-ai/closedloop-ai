import {
  type CommentSurface,
  ThreadSource,
  ThreadStatus,
  type TraceCommentKind,
} from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentCapability } from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { Result } from "@repo/api/src/types/result";
import type { TransactionClient } from "@repo/database";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { textBody } from "../mention-body";
import {
  type CommentLiveState,
  type CommentViewer,
  createCommentLiveState,
  isCommentKindAvailable,
} from "./comment-capabilities";
import type { CommentPresenter } from "./comment-command-lookup";
import { isThreadOnTargetSurface } from "./comment-command-lookup";
import {
  type CommentWrite,
  type CommentWritten,
  runCommentCommand,
} from "./comment-command-pipeline";
import {
  type CommentTarget,
  commentTargetTypeFor,
  commentThreadSources,
  defaultCommentSurface,
  isSurfaceOnArtifactType,
  nativeCommentPolicyKey,
} from "./comment-target";
import {
  type CommentThreadRow,
  commentThreadRowSelect,
  findArtifactThreadRow,
  findArtifactThreadRowForComment,
} from "./comment-thread-rows";
import { ThreadChangeKind } from "./comment-thread-signal";
import { commentAnchorToStoredJson } from "./trace-comment-anchor-json";
import {
  notifyTraceMentions,
  scopeMentionsToOrg,
} from "./trace-comment-mentions";
import { buildTraceCommentMetadata } from "./trace-comment-metadata";
import { indexTraceCommentAfterCommit } from "./trace-comment-search-index";

type CommandActor = {
  viewer: CommentViewer;
  target: CommentTarget;
  liveState?: CommentLiveState;
};

/** Where a reply lands: a thread by id, or the thread a root comment opens. */
export type ReplyLocator = { threadId: string } | { rootCommentId: string };

/**
 * Opens a native thread with its root comment. A `clientId` already used for
 * a thread in the org replays that thread, with no second row, revision or
 * after-commit hook (PLN-2121 decision 8).
 */
export async function createThread<T>(
  input: CommandActor & {
    surface?: CommentSurface;
    anchor: unknown;
    body: string;
    mentions?: readonly string[];
    kind?: TraceCommentKind;
    clientId: string | null;
    present: CommentPresenter<T>;
  },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  const { viewer, target } = input;
  const policyKey = nativeCommentPolicyKey(target.artifactType);
  const liveState = input.liveState ?? createCommentLiveState(viewer);
  const surface = input.surface ?? defaultCommentSurface(target.artifactType);
  if (!isSurfaceOnArtifactType(surface, target.artifactType)) {
    return Result.err(CommentErrorCode.AnchorInvalid);
  }
  if (
    input.kind &&
    !(await isCommentKindAvailable(policyKey, input.kind, liveState))
  ) {
    return Result.err(CommentErrorCode.CapabilityDenied);
  }
  const targetRecord = {
    artifactId: target.artifactId,
    target: {
      type: commentTargetTypeFor(target.artifactType),
      id: target.artifactId,
    },
    surface,
  };

  return runCommentCommand({
    target,
    policyKey,
    liveState,
    capability: CommentCapability.CreateThread,
    anchor: input.anchor,
    clientId: input.clientId,
    recordWrite,
    write: async (
      tx,
      { anchor }
    ): Promise<Result<CommentWrite<T>, CommentErrorCode>> => {
      if (input.clientId) {
        const existing = await tx.commentThread.findUnique({
          where: {
            organizationId_externalId: {
              organizationId: target.organizationId,
              externalId: input.clientId,
            },
          },
          select: commentThreadRowSelect,
        });
        if (existing) {
          return Result.ok(presentThread(existing, input.present));
        }
      }
      if (!anchor) {
        return Result.err(CommentErrorCode.AnchorInvalid);
      }
      const mentions = await scopeMentionsToOrg(
        tx,
        target.organizationId,
        input.mentions
      );
      const thread = await tx.commentThread.create({
        data: {
          organizationId: target.organizationId,
          artifactId: target.artifactId,
          source: ThreadSource.Native,
          status: ThreadStatus.Open,
          metadata: buildTraceCommentMetadata(targetRecord, input.kind),
          anchor: commentAnchorToStoredJson(anchor),
          anchorState: CommentAnchorState.Anchored,
          createdById: viewer.userId,
          ...(input.clientId ? { externalId: input.clientId } : {}),
          comments: {
            create: {
              authorId: viewer.userId,
              body: textBody(input.body, mentions),
              bodyFormat: CommentBodyFormat.RichV1,
              plainText: input.body,
            },
          },
        },
        select: commentThreadRowSelect,
      });
      const root = thread.comments[0];
      return Result.ok({
        ...presentThread(thread, input.present),
        changes: [
          {
            threadId: thread.id,
            kind: ThreadChangeKind.Created,
            revision: thread.revision,
          },
        ],
        afterCommit: async () => {
          if (!root) {
            return;
          }
          indexTraceCommentAfterCommit({
            organizationId: target.organizationId,
            commentId: root.id,
            body: input.body,
            authorId: viewer.userId,
            anchorArtifactId: target.artifactId,
            targetType: targetRecord.target.type,
            updatedAt: new Date(),
          });
          await notifyTraceMentions({
            resolved: targetRecord,
            organizationId: target.organizationId,
            actorUserId: viewer.userId,
            nextMentions: mentions,
            previousMentions: [],
            commentId: root.id,
            commentBody: input.body,
          });
        },
      });
    },
  });
}

/**
 * Adds a reply. A `clientId` that matches a reply on the same thread replays
 * it; one already used on a different thread is `client_id_conflict`
 * (PLN-2121 decision 8).
 */
export function reply<T>(
  input: CommandActor & {
    thread: ReplyLocator;
    body: string;
    mentions?: readonly string[];
    clientId: string | null;
    present: CommentPresenter<T>;
  },
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  const { viewer, target } = input;
  const surface = target.surface ?? defaultCommentSurface(target.artifactType);
  return runCommentCommand({
    target,
    policyKey: nativeCommentPolicyKey(target.artifactType),
    liveState: input.liveState ?? createCommentLiveState(viewer),
    capability: CommentCapability.Reply,
    clientId: input.clientId,
    recordWrite,
    write: async (tx): Promise<Result<CommentWrite<T>, CommentErrorCode>> => {
      const thread = await findReplyThread(tx, target, input.thread);
      if (!thread) {
        return Result.err(CommentErrorCode.NotFound);
      }
      const existingReply = input.clientId
        ? await tx.comment.findUnique({
            where: { externalId: input.clientId },
            select: { id: true, threadId: true },
          })
        : null;
      if (existingReply && existingReply.threadId !== thread.id) {
        return Result.err(CommentErrorCode.ClientIdConflict);
      }
      if (existingReply) {
        return Result.ok({
          changes: [],
          commentId: existingReply.id,
          present: (client) => input.present(client, { threadId: thread.id }),
        });
      }
      const mentions = await scopeMentionsToOrg(
        tx,
        target.organizationId,
        input.mentions
      );
      const created = await tx.comment.create({
        data: {
          threadId: thread.id,
          authorId: viewer.userId,
          body: textBody(input.body, mentions),
          bodyFormat: CommentBodyFormat.RichV1,
          plainText: input.body,
          ...(input.clientId ? { externalId: input.clientId } : {}),
        },
        select: { id: true },
      });
      return Result.ok({
        changes: [{ threadId: thread.id, kind: ThreadChangeKind.Updated }],
        commentId: created.id,
        present: (client) => input.present(client, { threadId: thread.id }),
        afterCommit: async () => {
          indexTraceCommentAfterCommit({
            organizationId: target.organizationId,
            commentId: created.id,
            body: input.body,
            authorId: viewer.userId,
            anchorArtifactId: target.artifactId,
            targetType: commentTargetTypeFor(target.artifactType),
            updatedAt: new Date(),
          });
          await notifyTraceMentions({
            resolved: { artifactId: target.artifactId, surface },
            organizationId: target.organizationId,
            actorUserId: viewer.userId,
            nextMentions: mentions,
            previousMentions: [],
            commentId: created.id,
            commentBody: input.body,
          });
        },
      });
    },
  });
}

function presentThread<T>(
  row: CommentThreadRow,
  present: CommentPresenter<T>
): CommentWrite<T> {
  return {
    changes: [],
    commentId: row.comments[0]?.id,
    present: (tx) => present(tx, { threadId: row.id, row }),
  };
}

/**
 * The thread a reply is for. Addressed by root comment id (the legacy routes),
 * the id must be the thread's live root, so replies never become reply parents.
 */
async function findReplyThread(
  tx: TransactionClient,
  target: CommentTarget,
  locator: ReplyLocator
): Promise<CommentThreadRow | null> {
  const scope = {
    organizationId: target.organizationId,
    artifactId: target.artifactId,
    sources: commentThreadSources(target.artifactType),
  };
  const thread =
    "threadId" in locator
      ? await findArtifactThreadRow(tx, {
          ...scope,
          threadId: locator.threadId,
        })
      : await findArtifactThreadRowForComment(tx, {
          ...scope,
          commentId: locator.rootCommentId,
        });
  if (!(thread && isThreadOnTargetSurface(thread, target))) {
    return null;
  }
  const root = thread.comments[0];
  if (!root) {
    return null;
  }
  return "rootCommentId" in locator && root.id !== locator.rootCommentId
    ? null
    : thread;
}
