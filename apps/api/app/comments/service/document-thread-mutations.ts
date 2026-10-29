import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { type Result, Status } from "@repo/api/src/types/result";
import {
  createArtifactLevelThread as createLiveblocksArtifactLevelThread,
  createArtifactThread as createLiveblocksThread,
  deleteArtifactComment as deleteLiveblocksArtifactComment,
  deleteArtifactThread as deleteLiveblocksArtifactThread,
  markArtifactThreadResolved as markLiveblocksThreadResolved,
  markArtifactThreadUnresolved as markLiveblocksThreadUnresolved,
  replyToArtifactThread as replyToLiveblocksArtifactThread,
} from "@repo/collaboration/server/room-management";
import type {
  CommentData,
  ThreadData,
} from "@repo/collaboration/server/webhook";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  type RecordWriteInTransaction,
  writeInShape,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { deriveThreadAuthorship } from "../thread-participants";
import type { RecordThreadResolution } from "./thread-resolution";

/** The thread and comment a document-thread write produced. */
/**
 * A thread or reply the service wrote: the Liveblocks thread and comment ids
 * for the response, and the comment's own row id for a receipt (the
 * Liveblocks id is not a UUID).
 */
export type DocumentThreadWrite = DocumentThreadCreated & {
  commentRowId: string;
};

/** The Liveblocks thread and comment ids a create or reply answers with. */
type DocumentThreadCreated = { threadId: string; commentId: string };

/**
 * Result of a permission-guarded document-thread mutation. Reuses the canonical
 * `Result<T>` from `@repo/api/src/types/result`: the error channel carries a
 * `StatusCode` (`Status.NotFound` when the thread is missing / cross-doc /
 * non-Liveblocks, `Status.Forbidden` when the caller is not permitted to perform
 * the mutation). Routes translate the status straight into the matching HTTP
 * response, so this path no longer defines a second service-result vocabulary.
 * (FEA-3950, FEA-4092)
 */
export type DocumentThreadMutationResult<T> = Result<T>;

/**
 * The resolution-projection shape a projection function returns. `null` means
 * the local DB row does not exist yet (webhook projection hasn't landed).
 */
type ResolutionProjection = {
  thread: { status: ThreadStatus };
} | null;

/** The route's in-transaction record of a resolve or reopen (ISS-12552). */
type RecordResolution = RecordThreadResolution;

/** Liveblocks' resolve or reopen call, and the one that undoes it. */
type LiveblocksResolutionMutation = (options: {
  roomId: string;
  threadId: string;
  userId: string;
}) => Promise<ThreadData>;

/**
 * Projection + lookup dependencies the document-thread mutations need from the
 * `commentsService` composition root. Injected (rather than imported) so this
 * internal module never imports its own composition root, per the API service
 * conventions.
 */
export type DocumentThreadMutationDeps = {
  findArtifactForRoom: (
    organizationId: string,
    roomId: string
  ) => Promise<{ artifactId: string; latestVersion: number | null } | null>;
  /** Resolves `null` when nothing was stored (ISS-11212: no artifact). */
  upsertThreadFromLiveblocks: (
    organizationId: string,
    thread: ThreadData
  ) => Promise<StoredProjectionRow | null>;
  /** Resolves `null` when nothing was stored (the thread row is missing). */
  upsertCommentFromLiveblocks: (
    organizationId: string,
    threadExternalId: string,
    comment: CommentData
  ) => Promise<StoredProjectionRow | null>;
  /**
   * Best-effort read-after-write fallback: project a provider thread into the DB
   * when the create webhook has not landed yet. Returns `true` when a thread was
   * fetched and projected. Called once, only on an initial projection miss.
   */
  syncThreadFromProvider: (
    organizationId: string,
    artifactId: string,
    threadExternalId: string
  ) => Promise<boolean>;
  resolveThread: (
    organizationId: string,
    threadExternalId: string,
    resolvedAt: Date,
    options?: { resolvedById?: string | null },
    recordWrite?: RecordResolution
  ) => Promise<ResolutionProjection>;
  unresolveThread: (
    organizationId: string,
    threadExternalId: string,
    recordWrite?: RecordResolution
  ) => Promise<ResolutionProjection>;
};

/**
 * The document-thread mutation surface consumed by the reply/resolve/unresolve
 * routes. Built by {@link createDocumentThreadMutations} and spread onto the
 * `commentsService` object in the composition root.
 */
export type DocumentThreadMutations = {
  createDocumentThread: (
    organizationId: string,
    documentSlug: string,
    userId: string,
    bodyText: string,
    anchorText: string,
    recordCreated?: RecordWriteInTransaction<DocumentThreadWrite>
  ) => Promise<DocumentThreadCreated>;
  createArtifactLevelDocumentThread: (
    organizationId: string,
    documentSlug: string,
    userId: string,
    bodyText: string,
    recordCreated?: RecordWriteInTransaction<DocumentThreadWrite>
  ) => Promise<DocumentThreadCreated>;
  replyToDocumentThread: (
    organizationId: string,
    artifactId: string,
    threadExternalId: string,
    userId: string,
    bodyText: string,
    recordCreated?: RecordWriteInTransaction<DocumentThreadWrite>
  ) => Promise<DocumentThreadMutationResult<DocumentThreadCreated>>;
  resolveDocumentThread: (
    organizationId: string,
    artifactId: string,
    threadExternalId: string,
    userId: string,
    resolvedAt: Date,
    recordResolved?: RecordResolution
  ) => Promise<DocumentThreadMutationResult<{ status: ThreadStatus }>>;
  reopenDocumentThreadAsAuthor: (
    organizationId: string,
    artifactId: string,
    threadExternalId: string,
    userId: string,
    recordReopened?: RecordResolution
  ) => Promise<DocumentThreadMutationResult<{ status: ThreadStatus }>>;
};

/**
 * A resolved, org+artifact-scoped document thread row. `authorId` is the thread
 * creator (null when unattributable); `participantIds` is the set of everyone
 * who authored a comment on the thread (including the author). Used by the
 * permission guards: participant-resolve accepts any `participantIds` member;
 * author-only reopen accepts only a non-null `authorId`. (FEA-4092)
 */
type DocumentThreadRow = {
  roomId: string;
  externalId: string;
  /** The projected status, read before the provider mutation. */
  status: ThreadStatus;
  authorId: string | null;
  participantIds: Set<string>;
};

/**
 * Sentinel distinguishing "thread exists but caller is not permitted" (→ 403)
 * from "thread not found" (`null` → 404) in the internal permission-resolution
 * helper, so the guard can map each to the right HTTP status. (FEA-4092)
 */
const FORBIDDEN = Symbol("forbidden");

/**
 * Build the document-thread mutation surface. All Liveblocks-source-of-truth
 * writes go through the injected projection deps so read-after-write REST/MCP
 * paths see the change before the webhook lands.
 */
export function createDocumentThreadMutations(
  deps: DocumentThreadMutationDeps
): DocumentThreadMutations {
  /**
   * Load a document (Liveblocks-projected) comment thread by its Liveblocks
   * external id, scoped to the caller's org and the resolved artifact. Returns
   * `null` when the thread is missing, belongs to another org, is anchored to a
   * different artifact, or is not a document-sourced thread — defense-in-depth so
   * a valid-in-org thread id on the wrong document never leaks. `authorId` is the
   * thread creator (`createdById` when the create webhook has populated it, else
   * the oldest comment's author). `participantIds` is the set of every comment
   * author on the thread (org+artifact scoped by the enclosing lookup), which the
   * participant-resolve guard permits alongside the author. Threads whose author
   * cannot be determined return `authorId: null` so the author-only reopen guard
   * fails closed; an empty `participantIds` fails the resolve guard closed too.
   * (FEA-4092)
   */
  async function readDocumentThreadRow(
    organizationId: string,
    artifactId: string,
    threadExternalId: string
  ): Promise<DocumentThreadRow | null> {
    const thread = await withDb((db) =>
      db.commentThread.findUnique({
        where: {
          organizationId_externalId: {
            organizationId,
            externalId: threadExternalId,
          },
        },
        select: {
          externalId: true,
          roomId: true,
          artifactId: true,
          source: true,
          status: true,
          createdById: true,
          comments: {
            orderBy: { createdAt: "asc" },
            select: { authorId: true },
          },
        },
      })
    );

    if (
      !thread ||
      thread.artifactId !== artifactId ||
      thread.source !== ThreadSource.Liveblocks ||
      !thread.externalId ||
      !thread.roomId
    ) {
      return null;
    }

    const { authorId, participantIds } = deriveThreadAuthorship(thread);

    return {
      roomId: thread.roomId,
      externalId: thread.externalId,
      status: thread.status as ThreadStatus,
      authorId,
      participantIds,
    };
  }

  async function findDocumentThreadForMutation(
    organizationId: string,
    artifactId: string,
    threadExternalId: string
  ): Promise<{ thread: DocumentThreadRow | null; synced: boolean }> {
    const existing = await readDocumentThreadRow(
      organizationId,
      artifactId,
      threadExternalId
    );
    if (existing) {
      return { thread: existing, synced: false };
    }

    // Read-after-write fallback: the Composer publishes straight to Liveblocks
    // and renders immediately, so a reply/resolve fired right after creation can
    // beat the `threadCreated` webhook that projects the DB row. Sync the thread
    // from the provider once, then re-read; a genuine miss still returns null.
    const synced = await deps.syncThreadFromProvider(
      organizationId,
      artifactId,
      threadExternalId
    );
    if (!synced) {
      return { thread: null, synced: true };
    }
    const thread = await readDocumentThreadRow(
      organizationId,
      artifactId,
      threadExternalId
    );
    return { thread, synced: true };
  }

  async function syncCreatedLiveblocksDocumentThread(
    organizationId: string,
    threadData: ThreadData,
    recordCreated?: RecordWriteInTransaction<DocumentThreadWrite>
  ): Promise<DocumentThreadCreated> {
    let commentId: string;
    try {
      const firstComment = threadData.comments[0];
      if (!firstComment) {
        throw new Error("Thread created but returned no comment");
      }
      commentId = firstComment.id;

      await withDb.tx(async (tx) => {
        const thread = await deps.upsertThreadFromLiveblocks(
          organizationId,
          threadData
        );
        if (thread === null) {
          throw new Error("Thread created but its projection stored nothing");
        }
        const comment = await deps.upsertCommentFromLiveblocks(
          organizationId,
          threadData.id,
          firstComment
        );
        if (comment === null) {
          throw new Error("Comment created but its projection stored nothing");
        }
        await recordCreated?.(tx, {
          threadId: threadData.id,
          commentId,
          commentRowId: comment.id,
        });
      });
    } catch (projectionError) {
      await deleteLiveblocksArtifactThread({
        roomId: threadData.roomId,
        threadId: threadData.id,
      }).catch((cleanupError) => {
        log.warn(
          "[commentThreadsService] Failed to delete Liveblocks thread after projection sync failure",
          {
            roomId: threadData.roomId,
            threadId: threadData.id,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          }
        );
      });
      throw projectionError;
    }

    return { threadId: threadData.id, commentId };
  }

  async function createDocumentThread(
    organizationId: string,
    documentSlug: string,
    userId: string,
    bodyText: string,
    anchorText: string,
    recordCreated?: RecordWriteInTransaction<DocumentThreadWrite>
  ): Promise<DocumentThreadCreated> {
    const roomId = generateDocumentRoomId(organizationId, documentSlug);
    const artifact = await deps.findArtifactForRoom(organizationId, roomId);

    const threadData = await createLiveblocksThread({
      roomId,
      userId,
      bodyText,
      anchorText,
      version: artifact?.latestVersion ?? undefined,
    });

    return syncCreatedLiveblocksDocumentThread(
      organizationId,
      threadData,
      recordCreated
    );
  }

  async function createArtifactLevelDocumentThread(
    organizationId: string,
    documentSlug: string,
    userId: string,
    bodyText: string,
    recordCreated?: RecordWriteInTransaction<DocumentThreadWrite>
  ): Promise<DocumentThreadCreated> {
    const roomId = generateDocumentRoomId(organizationId, documentSlug);
    const artifact = await deps.findArtifactForRoom(organizationId, roomId);

    const threadData = await createLiveblocksArtifactLevelThread({
      roomId,
      userId,
      bodyText,
      version: artifact?.latestVersion ?? undefined,
    });

    return syncCreatedLiveblocksDocumentThread(
      organizationId,
      threadData,
      recordCreated
    );
  }

  /**
   * Reply to a document comment thread (FEA-3950). Anyone with view access may
   * reply (the route enforces org+artifact resolution); no author gate.
   * Liveblocks is the source of truth: the reply is created there, then the DB
   * projection is applied. If the projection throws or stores nothing after the
   * Liveblocks write succeeds, the just-created Liveblocks comment is
   * compensated (deleted) so a client retry cannot leave a duplicate visible
   * reply — the create-thread path uses the same compensation.
   */
  async function replyToDocumentThread(
    organizationId: string,
    artifactId: string,
    threadExternalId: string,
    userId: string,
    bodyText: string,
    recordCreated?: RecordWriteInTransaction<DocumentThreadWrite>
  ): Promise<DocumentThreadMutationResult<DocumentThreadCreated>> {
    const { thread } = await findDocumentThreadForMutation(
      organizationId,
      artifactId,
      threadExternalId
    );
    if (!thread) {
      return { ok: false, error: Status.NotFound };
    }

    const comment = await replyToLiveblocksArtifactThread({
      roomId: thread.roomId,
      threadId: thread.externalId,
      userId,
      bodyText,
    });

    try {
      // No outer transaction unless the reply is recorded (ISS-12552 parity).
      await writeRecorded(
        recordCreated,
        async () => {
          const stored = await deps.upsertCommentFromLiveblocks(
            organizationId,
            thread.externalId,
            comment
          );
          if (stored === null) {
            throw new Error("Reply created but its projection stored nothing");
          }
          return stored;
        },
        (stored) => ({
          threadId: thread.externalId,
          commentId: comment.id,
          commentRowId: stored.id,
        })
      );
    } catch (projectionError) {
      await deleteLiveblocksArtifactComment({
        roomId: thread.roomId,
        threadId: thread.externalId,
        commentId: comment.id,
      }).catch((cleanupError) => {
        log.warn(
          "[commentThreadsService] Failed to delete Liveblocks reply after projection sync failure",
          {
            roomId: thread.roomId,
            threadId: thread.externalId,
            commentId: comment.id,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          }
        );
      });
      throw projectionError;
    }

    return {
      ok: true,
      value: { threadId: thread.externalId, commentId: comment.id },
    };
  }

  /**
   * Resolve a document comment thread — PARTICIPANT-resolve (FEA-4092, was
   * author-only in FEA-3950). Permitted for the thread author OR anyone who
   * authored a comment on the thread (a participant); every other caller gets
   * `Status.Forbidden`. On a review doc, whoever addressed the feedback is
   * usually the one who closes it. Fails closed when no participant identity can
   * be determined. Enforced here, not just in the UI.
   */
  function resolveDocumentThread(
    organizationId: string,
    artifactId: string,
    threadExternalId: string,
    userId: string,
    resolvedAt: Date,
    recordResolved?: RecordResolution
  ): Promise<DocumentThreadMutationResult<{ status: ThreadStatus }>> {
    return runGuardedResolution({
      organizationId,
      artifactId,
      threadExternalId,
      userId,
      isPermitted: (thread) => thread.participantIds.has(userId),
      targetStatus: ThreadStatus.Resolved,
      liveblocksMutation: markLiveblocksThreadResolved,
      revertLiveblocksMutation: markLiveblocksThreadUnresolved,
      record: recordResolved,
      projection: (record) =>
        deps.resolveThread(
          organizationId,
          threadExternalId,
          resolvedAt,
          { resolvedById: userId },
          record
        ),
    });
  }

  /**
   * Reopen (unresolve) a resolved document comment thread — AUTHOR ONLY
   * (FEA-3950, unchanged by FEA-4092). Only the thread creator may reopen; every
   * other caller (including a non-author participant) gets `Status.Forbidden`.
   * Fails closed when authorship is unknown.
   */
  function reopenDocumentThreadAsAuthor(
    organizationId: string,
    artifactId: string,
    threadExternalId: string,
    userId: string,
    recordReopened?: RecordResolution
  ): Promise<DocumentThreadMutationResult<{ status: ThreadStatus }>> {
    return runGuardedResolution({
      organizationId,
      artifactId,
      threadExternalId,
      userId,
      isPermitted: (thread) =>
        thread.authorId !== null && thread.authorId === userId,
      targetStatus: ThreadStatus.Open,
      liveblocksMutation: markLiveblocksThreadUnresolved,
      revertLiveblocksMutation: markLiveblocksThreadResolved,
      record: recordReopened,
      projection: (record) =>
        deps.unresolveThread(organizationId, threadExternalId, record),
    });
  }

  /**
   * Shared permission-guarded resolve/reopen path. Loads + org/artifact-scopes
   * the thread, runs the caller-supplied `isPermitted` predicate against the
   * resolved row (participant-set for resolve, author-only for reopen), applies
   * the Liveblocks mutation (source of truth), then re-projects the resolution
   * state locally. The predicate fails closed on an unattributable thread
   * (empty participant set / null author). When the local projection has not
   * landed yet (`null`), the caller's own `targetStatus` is reported rather than
   * defaulting to `Open`, which would be wrong for a resolve.
   *
   * When the row already existed but the predicate fails, the caller's reply may
   * only be at Liveblocks (its `commentCreated` projection lagging), which would
   * 403 a real participant. If no provider sync happened during the lookup, sync
   * once and re-evaluate against the freshly-projected participant set before
   * returning `Forbidden` (FEA-4092 review).
   */
  async function runGuardedResolution(input: {
    organizationId: string;
    artifactId: string;
    threadExternalId: string;
    userId: string;
    isPermitted: (thread: DocumentThreadRow) => boolean;
    targetStatus: ThreadStatus;
    liveblocksMutation: LiveblocksResolutionMutation;
    revertLiveblocksMutation: LiveblocksResolutionMutation;
    record: RecordResolution | undefined;
    projection: (
      record: RecordResolution | undefined
    ) => Promise<ResolutionProjection>;
  }): Promise<DocumentThreadMutationResult<{ status: ThreadStatus }>> {
    const thread = await resolvePermittedThread(input);
    if (!thread) {
      return { ok: false, error: Status.NotFound };
    }
    if (thread === FORBIDDEN) {
      return { ok: false, error: Status.Forbidden };
    }

    const target = {
      roomId: thread.roomId,
      threadId: thread.externalId,
      userId: input.userId,
    };
    await input.liveblocksMutation(target);

    // Unrecorded is main's shape: a failed projection leaves the Liveblocks
    // change in place (ISS-12552 flag-off parity).
    const projected = await writeInShape(input.record, {
      unrecorded: () => input.projection(undefined),
      recorded: async (record) => {
        try {
          return await input.projection(record);
        } catch (projectionError) {
          // ISS-12552: the projection carries the write's receipt, so when it
          // fails the Liveblocks change is undone, as create and reply delete
          // theirs. A thread already in the target state was not changed
          // there.
          if (thread.status !== input.targetStatus) {
            await revertLiveblocksResolution(
              input.revertLiveblocksMutation,
              target
            );
          }
          throw projectionError;
        }
      },
    });
    return {
      ok: true,
      value: { status: projected?.thread.status ?? input.targetStatus },
    };
  }

  /**
   * Load the thread and evaluate the permission predicate, with a single
   * provider re-sync + re-read when the predicate fails on an already-projected
   * row that was not just synced (a participant whose reply is only at
   * Liveblocks). Returns the permitted row, `null` for not-found, or the
   * `FORBIDDEN` sentinel when the caller genuinely may not perform the mutation.
   */
  async function resolvePermittedThread(input: {
    organizationId: string;
    artifactId: string;
    threadExternalId: string;
    isPermitted: (thread: DocumentThreadRow) => boolean;
  }): Promise<DocumentThreadRow | null | typeof FORBIDDEN> {
    const { thread, synced } = await findDocumentThreadForMutation(
      input.organizationId,
      input.artifactId,
      input.threadExternalId
    );
    if (!thread) {
      return null;
    }
    if (input.isPermitted(thread)) {
      return thread;
    }
    if (synced) {
      // The row is already the freshest provider projection; the caller really
      // is not permitted.
      return FORBIDDEN;
    }

    const didSync = await deps.syncThreadFromProvider(
      input.organizationId,
      input.artifactId,
      input.threadExternalId
    );
    if (!didSync) {
      return FORBIDDEN;
    }
    const refreshed = await readDocumentThreadRow(
      input.organizationId,
      input.artifactId,
      input.threadExternalId
    );
    if (!refreshed) {
      return FORBIDDEN;
    }
    return input.isPermitted(refreshed) ? refreshed : FORBIDDEN;
  }

  return {
    createDocumentThread,
    createArtifactLevelDocumentThread,
    replyToDocumentThread,
    resolveDocumentThread,
    reopenDocumentThreadAsAuthor,
  };
}

/** The row a projection upsert stored; its absence is `null`, never `undefined`. */
type StoredProjectionRow = { id: string };

/** Best effort: a failed undo is logged, and the projection's error stands. */
async function revertLiveblocksResolution(
  revert: LiveblocksResolutionMutation,
  target: { roomId: string; threadId: string; userId: string }
): Promise<void> {
  await revert(target).catch((cleanupError) => {
    log.warn(
      "[commentThreadsService] Failed to revert Liveblocks resolution after projection sync failure",
      {
        roomId: target.roomId,
        threadId: target.threadId,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      }
    );
  });
}
