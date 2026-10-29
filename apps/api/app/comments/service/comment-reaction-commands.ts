import { CommentCapability } from "@repo/api/src/types/comment-capabilities";
import type { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import type { CommentReactionEmoji } from "@repo/api/src/types/comment-thread-dto";
import { Result } from "@repo/api/src/types/result";
import type { TransactionClient } from "@repo/database";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  type CommentLiveState,
  type CommentSourcePolicies,
  type CommentViewer,
  createCommentLiveState,
} from "./comment-capabilities";
import {
  type CommentPresenter,
  findCommentOnTarget,
} from "./comment-command-lookup";
import {
  type CommentWrite,
  type CommentWritten,
  runCommentCommand,
} from "./comment-command-pipeline";
import { type CommentTarget, nativeCommentPolicyKey } from "./comment-target";
import { ThreadChangeKind } from "./comment-thread-signal";

type ReactionInput<T> = {
  viewer: CommentViewer;
  target: CommentTarget;
  commentId: string;
  emoji: CommentReactionEmoji;
  present: CommentPresenter<T>;
  liveState?: CommentLiveState;
  policies?: CommentSourcePolicies;
};

/**
 * PLN-2187 T-2.2: the viewer reacts to a live comment with `emoji`. A repeat
 * changes nothing, so the thread's revision moves only when a row is added.
 * Reactions send no notification (ISS-11216 Q-002).
 */
export function addReaction<T>(
  input: ReactionInput<T>,
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  return writeReaction(input, recordWrite, async (tx, commentId) => {
    const { count } = await tx.commentReaction.createMany({
      data: [{ commentId, userId: input.viewer.userId, emoji: input.emoji }],
      skipDuplicates: true,
    });
    return count > 0;
  });
}

/** The viewer's own `emoji` reaction comes off; removing none changes nothing. */
export function removeReaction<T>(
  input: ReactionInput<T>,
  recordWrite?: RecordWriteInTransaction<CommentWritten>
): Promise<Result<T, CommentErrorCode>> {
  return writeReaction(input, recordWrite, async (tx, commentId) => {
    const { count } = await tx.commentReaction.deleteMany({
      where: { commentId, userId: input.viewer.userId, emoji: input.emoji },
    });
    return count > 0;
  });
}

function writeReaction<T>(
  input: ReactionInput<T>,
  recordWrite: RecordWriteInTransaction<CommentWritten> | undefined,
  write: (tx: TransactionClient, commentId: string) => Promise<boolean>
): Promise<Result<T, CommentErrorCode>> {
  const { viewer, target } = input;
  return runCommentCommand({
    target,
    policyKey: nativeCommentPolicyKey(target.artifactType),
    liveState: input.liveState ?? createCommentLiveState(viewer),
    capability: CommentCapability.React,
    policies: input.policies,
    recordWrite,
    write: async (tx): Promise<Result<CommentWrite<T>, CommentErrorCode>> => {
      const found = await findCommentOnTarget(tx, target, input.commentId);
      if (!found.ok) {
        return found;
      }
      const { threadId, commentId } = found.value;
      const changed = await write(tx, commentId);
      return Result.ok({
        changes: changed ? [{ threadId, kind: ThreadChangeKind.Updated }] : [],
        commentId,
        present: (client) => input.present(client, { threadId }),
      });
    },
  });
}
