import type { CommentAnchor } from "@repo/api/src/types/comment-anchor";
import {
  COMMENT_SOURCE_POLICIES,
  type CommentCapability,
  CommentPolicyKey,
} from "@repo/api/src/types/comment-capabilities";
import { CommentErrorCode } from "@repo/api/src/types/comment-error-code";
import {
  CommentSyncDirection,
  type CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import { Result } from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { validateCommentAnchor } from "./comment-anchor-validation";
import {
  type CommentLiveState,
  type CommentSourcePolicies,
  isCapabilityAvailable,
} from "./comment-capabilities";
import type { CommentTarget } from "./comment-target";
import {
  emitThreadChangeSignal,
  type ThreadChange,
  ThreadChangeKind,
} from "./comment-thread-signal";
import { runIdempotentTraceWrite } from "./trace-comment-write-idempotency";

/**
 * The provider each source syncs its writes out to. None does: document
 * comments are Postgres-only (ISS-11216).
 */
export const COMMENT_OUTBOUND_SYNC_PROVIDERS = {
  [CommentPolicyKey.NativeSession]: null,
  [CommentPolicyKey.NativeBranch]: null,
  [CommentPolicyKey.GithubBranch]: null,
  [CommentPolicyKey.NativeDocument]: null,
} as const satisfies Record<CommentPolicyKey, CommentSyncProvider | null>;

export type CommentOutboundSyncProviders = Record<
  CommentPolicyKey,
  CommentSyncProvider | null
>;

export type CommentWrite<T> = {
  /** Every thread the write changed; empty for an idempotent replay. */
  changes: ThreadChange[];
  /** Reads the result inside the transaction, after revisions are bumped. */
  present: (tx: TransactionClient) => Promise<T | null>;
  /** Mention notifications and search-index hooks; a replay has none. */
  afterCommit?: () => Promise<void>;
  /** The comment the write made or acted on, named on its receipt. */
  commentId?: string;
  /**
   * Whether the write stored anything. Defaults to whether a thread changed;
   * a write that stores a row no reader sees yet says so here.
   */
  stored?: boolean;
};

/** What a comment write did, for the caller's in-transaction receipt (ISS-12552). */
export type CommentWritten = {
  target: CommentTarget;
  commentId: string | null;
  changed: boolean;
};

export type CommentCommand<T> = {
  target: CommentTarget;
  policyKey: CommentPolicyKey;
  liveState: CommentLiveState;
  /** `null` for internal commands no viewer invokes. */
  capability: CommentCapability | null;
  anchor?: unknown;
  /** A client idempotency key; a unique race on it re-runs the command once. */
  clientId?: string | null;
  write: (
    tx: TransactionClient,
    context: { anchor: CommentAnchor | null }
  ) => Promise<Result<CommentWrite<T>, CommentErrorCode>>;
  policies?: CommentSourcePolicies;
  outboundSyncProviders?: CommentOutboundSyncProviders;
  /** Runs inside the transaction once the write is presented (ISS-12552). */
  recordWrite?: RecordWriteInTransaction<CommentWritten>;
};

/**
 * The one path every comment write takes (PLN-2121): capabilities, then the
 * anchor, then one transaction that writes, bumps each changed thread's
 * revision, signals it and marks outbound sync, then the fail-open after-commit hooks.
 * The target is resolved and org-scoped by the caller, outside the
 * transaction. A write that fails must fail before it writes: the
 * transaction commits whatever a returning callback left behind.
 */
export async function runCommentCommand<T>(
  command: CommentCommand<T>
): Promise<Result<T, CommentErrorCode>> {
  const policies = command.policies ?? COMMENT_SOURCE_POLICIES;
  if (
    command.capability &&
    !(await isCapabilityAvailable(
      command.policyKey,
      command.capability,
      command.liveState,
      policies
    ))
  ) {
    return Result.err(CommentErrorCode.CapabilityDenied);
  }

  let anchor: CommentAnchor | null = null;
  if (command.anchor !== undefined) {
    const validated = validateCommentAnchor(
      command.policyKey,
      command.anchor,
      policies
    );
    if (!validated.ok) {
      return validated;
    }
    anchor = validated.value;
  }

  const outcome = await runIdempotentTraceWrite(command.clientId ?? null, () =>
    withDb.tx(async (tx) => {
      const written = await command.write(tx, { anchor });
      if (!written.ok) {
        return { result: written, afterCommit: undefined };
      }
      await commitThreadChanges(tx, {
        target: command.target,
        outboundSyncProvider: (command.outboundSyncProviders ??
          COMMENT_OUTBOUND_SYNC_PROVIDERS)[command.policyKey],
        changes: written.value.changes,
      });
      const value = await written.value.present(tx);
      if (value === null) {
        return {
          result: Result.err<T, CommentErrorCode>(CommentErrorCode.NotFound),
          afterCommit: undefined,
        };
      }
      await command.recordWrite?.(tx, {
        target: command.target,
        commentId: written.value.commentId ?? null,
        changed: written.value.stored ?? written.value.changes.length > 0,
      });
      return {
        result: Result.ok<T, CommentErrorCode>(value),
        afterCommit: written.value.afterCommit,
      };
    })
  );

  if (outcome.afterCommit) {
    await outcome.afterCommit();
  }
  return outcome.result;
}

/**
 * Inside the command's transaction: one revision per changed thread (a new
 * thread keeps the revision it was created with), one realtime signal per
 * changed thread carrying that revision, and a `PENDING` outbound row when its
 * source syncs out.
 */
export async function commitThreadChanges(
  tx: TransactionClient,
  input: {
    target: CommentTarget;
    outboundSyncProvider: CommentSyncProvider | null;
    changes: readonly ThreadChange[];
  }
): Promise<void> {
  for (const change of input.changes) {
    const threadRevision =
      change.kind === ThreadChangeKind.Updated
        ? (
            await tx.commentThread.update({
              where: { id: change.threadId },
              data: { revision: { increment: 1 } },
              select: { revision: true },
            })
          ).revision
        : change.revision;
    await emitThreadChangeSignal(tx, input.target, change.kind, {
      threadId: change.threadId,
      threadRevision,
    });
    if (input.outboundSyncProvider) {
      await markOutboundSyncPending(tx, {
        organizationId: input.target.organizationId,
        threadId: change.threadId,
        provider: input.outboundSyncProvider,
      });
    }
  }
}

function markOutboundSyncPending(
  tx: TransactionClient,
  input: {
    organizationId: string;
    threadId: string;
    provider: CommentSyncProvider;
  }
) {
  return tx.commentSyncState.upsert({
    where: {
      threadId_provider_direction: {
        threadId: input.threadId,
        provider: input.provider,
        direction: CommentSyncDirection.Outbound,
      },
    },
    create: {
      organizationId: input.organizationId,
      threadId: input.threadId,
      provider: input.provider,
      direction: CommentSyncDirection.Outbound,
      state: CommentSyncStatus.Pending,
    },
    update: { state: CommentSyncStatus.Pending },
    select: { id: true },
  });
}
