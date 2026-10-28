import type { ThreadData } from "@repo/collaboration/server/webhook";
import { getLiveblocksApiClient } from "@repo/collaboration/server/webhook";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { findArtifactForRoom } from "./artifact-for-room";
import {
  completeUpload,
  createUpload,
} from "./service/comment-attachment-commands";
import { createThread, reply } from "./service/comment-commands";
import { deleteComment, editComment } from "./service/comment-edit-commands";
import {
  addReaction,
  removeReaction,
} from "./service/comment-reaction-commands";
import { getThread, listArtifactComments } from "./service/comment-read";
import {
  markSyncAbandoned,
  reanchor,
  reopenCommentThread,
  resolveCommentThread,
  retrySync,
} from "./service/comment-thread-state-commands";
import { createDocumentThreadMutations } from "./service/document-thread-mutations";
import { applyExternal } from "./service/github/apply-external";
import { liveblocksProjectionWriters } from "./service/liveblocks-projection";
import { liveblocksThreadReads } from "./service/liveblocks-thread-read";
import {
  type CommentThreadResolutionMutationResult,
  type GitHubReviewThreadResolutionInput,
  type RecordThreadResolution,
  resolveThreadByExternalId,
  unresolveThreadByExternalId,
} from "./service/thread-resolution";
import { listAllTraceComments } from "./service/trace-comment-aggregate-read";
import { unifiedCommentRequests } from "./service/unified-comment-requests";

/**
 * Document-thread reply/resolve/unresolve mutation surface (FEA-3950). Built as
 * an internal module (`service/document-thread-mutations.ts`) that receives its
 * projection/lookup dependencies here rather than importing the `commentsService`
 * composition root, per the API service conventions. The dep closures reference
 * `commentsService.*` lazily — they run only at request time, after this module
 * has finished initializing.
 */
const documentThreadMutations = createDocumentThreadMutations({
  findArtifactForRoom,
  upsertThreadFromLiveblocks: (organizationId, thread) =>
    commentsService.upsertThreadFromLiveblocks(organizationId, thread),
  upsertCommentFromLiveblocks: (organizationId, threadExternalId, comment) =>
    commentsService.upsertCommentFromLiveblocks(
      organizationId,
      threadExternalId,
      comment
    ),
  syncThreadFromProvider: (organizationId, artifactId, threadExternalId) =>
    commentsService.syncDocumentThreadFromProvider(
      organizationId,
      artifactId,
      threadExternalId
    ),
  resolveThread: (
    organizationId,
    threadExternalId,
    resolvedAt,
    options,
    recordWrite
  ) =>
    commentsService.resolveThread(
      organizationId,
      threadExternalId,
      resolvedAt,
      options,
      recordWrite
    ),
  unresolveThread: (organizationId, threadExternalId, recordWrite) =>
    commentsService.unresolveThread(
      organizationId,
      threadExternalId,
      recordWrite
    ),
});

export const commentsService = {
  ...liveblocksProjectionWriters,
  /**
   * Mark a thread as resolved and return whether durable state changed.
   * GitHub review-thread webhooks pass attribution metadata; Liveblocks callers
   * keep the legacy behavior by omitting it.
   */
  resolveThread(
    organizationId: string,
    threadExternalId: string,
    resolvedAt: Date,
    options?: Omit<GitHubReviewThreadResolutionInput, "resolvedAt">,
    recordWrite?: RecordThreadResolution
  ): Promise<CommentThreadResolutionMutationResult> {
    return resolveThreadByExternalId(
      organizationId,
      threadExternalId,
      resolvedAt,
      options,
      recordWrite
    );
  },
  /**
   * Mark a thread as unresolved, clearing resolution attribution without
   * disturbing unrelated thread metadata.
   */
  unresolveThread(
    organizationId: string,
    threadExternalId: string,
    recordWrite?: RecordThreadResolution
  ): Promise<CommentThreadResolutionMutationResult> {
    return unresolveThreadByExternalId(
      organizationId,
      threadExternalId,
      recordWrite
    );
  },

  /**
   * Best-effort read-after-write fallback (FEA-3950): pull a Liveblocks thread
   * and its comments from the provider and project them into the local DB when
   * the create webhook has not landed yet. The Composer publishes straight to
   * Liveblocks and renders from `useThreads` immediately, so a reply/resolve
   * fired right after creation can beat the `threadCreated` webhook — without
   * this, the mutation lookup would 404 a thread that genuinely exists.
   *
   * Scoped to the caller's org + artifact: resolves the artifact's slug to build
   * the room id, so a thread id cannot be synced against the wrong document.
   * Returns `true` when a thread was fetched and projected, `false` when the
   * artifact/slug is unknown, Liveblocks is not configured, or the provider has
   * no such thread. Never throws for the not-found/misconfigured cases so the
   * caller can fall through to its own not-found handling.
   */
  async syncDocumentThreadFromProvider(
    organizationId: string,
    artifactId: string,
    threadExternalId: string
  ): Promise<boolean> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: artifactId, organizationId },
        select: { slug: true },
      })
    );
    if (!artifact?.slug) {
      return false;
    }

    const client = getLiveblocksApiClient();
    if (!client) {
      return false;
    }

    const roomId = generateDocumentRoomId(organizationId, artifact.slug);
    let thread: ThreadData;
    try {
      thread = await client.getThread({ roomId, threadId: threadExternalId });
    } catch (error) {
      // Unknown thread / room at the provider is an expected miss, not a 500.
      log.info(
        "[commentThreadsService] Provider thread fetch failed during read-after-write fallback",
        {
          organizationId,
          artifactId,
          threadExternalId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return false;
    }

    await withDb.tx(async () => {
      await commentsService.upsertThreadFromLiveblocks(organizationId, thread);
      for (const comment of thread.comments) {
        await commentsService.upsertCommentFromLiveblocks(
          organizationId,
          thread.id,
          comment
        );
      }
    });

    return true;
  },

  ...liveblocksThreadReads,
  ...documentThreadMutations,

  createThread,
  reply,
  editComment,
  deleteComment,
  addReaction,
  removeReaction,
  createUpload,
  completeUpload,
  resolveCommentThread,
  reopenCommentThread,
  retrySync,
  markSyncAbandoned,
  reanchor,
  applyExternal,
  listArtifactComments,
  getThread,
  listAllTraceComments,
  ...unifiedCommentRequests,
};
