import "server-only";
import { Liveblocks } from "@liveblocks/node";
import { withProsemirrorDocument } from "@liveblocks/node-prosemirror";
import {
  DocumentThreadAnchorStatus,
  type DocumentThreadAnchorStatus as DocumentThreadAnchorStatusType,
} from "@repo/api/src/types/comment";
import type { DocumentVersionPublishedEvent } from "../shared/room-events";
import { keys } from "./keys";
import type { CommentBody, CommentData, ThreadData } from "./webhook";
import { anchorThreadToText, findAnchorText } from "./yjs-anchor";

/**
 * The union of all typed room events. Mirrors the global
 * `Liveblocks.RoomEvent` declaration in `config.ts`; we import the
 * payload types directly here because the global interface is shadowed
 * inside this module by the `Liveblocks` class import from `@liveblocks/node`.
 */
export type RoomEventPayload = DocumentVersionPublishedEvent;

export type CreateRoomOptions = {
  roomId: string;
  tenantId: string;
  metadata?: Record<string, string>;
};

/**
 * Create a Liveblocks room with tenant isolation (idempotent).
 * This function handles errors gracefully and will not throw.
 *
 * @param options - Room creation options including roomId, tenantId, and optional metadata
 * @returns Promise that resolves with success status and optional error message
 */
export async function createRoom(
  options: CreateRoomOptions
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const liveblocks = getLiveblocksClient();
    if (!liveblocks) {
      // Not configured - skip room creation (RoomProvider will auto-create)
      return { success: true };
    }

    // Use getOrCreateRoom for idempotency - safe to retry
    await liveblocks.getOrCreateRoom(options.roomId, {
      defaultAccesses: [], // Private - require authentication via auth endpoint
      tenantId: options.tenantId,
      metadata: options.metadata,
      engine: 2,
    });

    return { success: true };
  } catch (error) {
    // Return error without throwing - if this fails, RoomProvider will auto-create the room
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Reset a Liveblocks room.
 * This function clears the room's content.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to reset
 * @returns Promise that resolves with success status and optional error message
 */
export async function resetRoom(
  roomId: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const liveblocks = getLiveblocksClient();
    if (!liveblocks) {
      return { success: true };
    }

    await withProsemirrorDocument({ roomId, client: liveblocks }, (api) =>
      api.clearContent()
    );

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Delete a Liveblocks room.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to delete
 * @returns Promise that resolves with success status and optional error message
 */
export async function deleteRoom(
  roomId: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const liveblocks = getLiveblocksClient();
    if (!liveblocks) {
      // Not an error - just not configured
      return { success: true };
    }

    // Delete the room using Liveblocks API
    await liveblocks.deleteRoom(roomId);

    return { success: true };
  } catch (error) {
    // Return error without throwing - we don't want room deletion failures to block operations
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Broadcast a typed room event to every connected client in the room.
 * Used to notify subscribers of out-of-band changes (e.g. a new document
 * version published server-side). This function handles errors gracefully
 * and will not throw.
 *
 * @param roomId - The ID of the room to broadcast into
 * @param event - The event payload (must match the global `Liveblocks.RoomEvent` union)
 * @returns Promise that resolves with success status and optional error message
 */
export async function broadcastRoomEvent(
  roomId: string,
  event: RoomEventPayload
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const liveblocks = getLiveblocksClient();
    if (!liveblocks) {
      // Not configured — broadcasting is a best-effort signal, so no-op.
      return { success: true };
    }

    await liveblocks.broadcastEvent(roomId, event);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Update metadata on an existing Liveblocks room.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to update
 * @param metadata - Key-value pairs to merge into existing metadata (null deletes a key)
 * @returns Promise that resolves with success status and optional error message
 */
export async function updateRoomMetadata(
  roomId: string,
  metadata: Record<string, string | null>
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const liveblocks = getLiveblocksClient();
    if (!liveblocks) {
      return { success: true };
    }

    await liveblocks.updateRoom(roomId, { metadata });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

export type CreateArtifactThreadOptions = {
  roomId: string;
  userId: string;
  bodyText: string;
  anchorText: string;
  /**
   * The artifact's `latestVersion` at the time of creation. Stamped into
   * Liveblocks `ThreadMetadata.version` so the Feed sidebar can render a
   * "from v{N}" attribution badge once the artifact advances past this
   * value. Omit for non-document rooms or when the caller cannot resolve a
   * version.
   */
  version?: number;
};

export type CreateArtifactLevelThreadOptions = Omit<
  CreateArtifactThreadOptions,
  "anchorText"
>;

export type DeleteArtifactThreadOptions = {
  roomId: string;
  threadId: string;
};

export type DeleteArtifactCommentOptions = {
  roomId: string;
  threadId: string;
  commentId: string;
};

export type ReplyToArtifactThreadOptions = {
  roomId: string;
  threadId: string;
  userId: string;
  bodyText: string;
};

export type MarkArtifactThreadResolutionOptions = {
  roomId: string;
  threadId: string;
  userId: string;
};

export async function createArtifactThread({
  roomId,
  userId,
  bodyText,
  anchorText,
  version,
}: CreateArtifactThreadOptions): Promise<ThreadData> {
  const liveblocks = getLiveblocksClient();

  if (!liveblocks) {
    throw new Error("LIVEBLOCKS_SECRET is not configured");
  }

  // Pre-validate anchor text exists and is unique before creating thread
  try {
    await findAnchorText(liveblocks, roomId, anchorText);
  } catch (error) {
    // Re-throw structured 400 errors (anchor not found / duplicate) as-is
    if (error != null && typeof error === "object" && "status" in error) {
      throw error;
    }
    throw new Error("Failed to validate anchor text", { cause: error });
  }

  const thread = await liveblocks.createThread({
    roomId,
    data: {
      comment: { userId, body: buildCommentBody(bodyText) },
      metadata: buildThreadMetadata(
        version,
        DocumentThreadAnchorStatus.Anchored
      ),
    },
  });

  try {
    await anchorThreadToText(liveblocks, roomId, thread.id, anchorText);
  } catch (anchorError) {
    // Best-effort rollback: delete the thread to avoid orphaned threads
    await liveblocks
      .deleteThread({ roomId, threadId: thread.id })
      .catch(() => {});
    throw anchorError;
  }

  return thread;
}

/**
 * Create an unanchored artifact-level Liveblocks comment thread. Unlike
 * `createArtifactThread`, this intentionally skips Y.Doc anchor validation
 * because the thread belongs to the whole artifact, not a text range.
 */
export async function createArtifactLevelThread({
  roomId,
  userId,
  bodyText,
  version,
}: CreateArtifactLevelThreadOptions): Promise<ThreadData> {
  const liveblocks = getLiveblocksClient();

  if (!liveblocks) {
    throw new Error("LIVEBLOCKS_SECRET is not configured");
  }

  return await liveblocks.createThread({
    roomId,
    data: {
      comment: { userId, body: buildCommentBody(bodyText) },
      metadata: buildThreadMetadata(
        version,
        DocumentThreadAnchorStatus.ArtifactLevel
      ),
    },
  });
}

/**
 * Delete a Liveblocks artifact thread. Callers use this as compensation when a
 * post-create local projection step fails and retrying would otherwise publish
 * a duplicate visible thread.
 */
export async function deleteArtifactThread({
  roomId,
  threadId,
}: DeleteArtifactThreadOptions): Promise<void> {
  const liveblocks = getLiveblocksClient();

  if (!liveblocks) {
    return;
  }

  await liveblocks.deleteThread({ roomId, threadId });
}

/**
 * Delete a single comment from a Liveblocks artifact thread, leaving the rest of
 * the thread intact. Used to compensate a reply whose local DB projection failed
 * after the Liveblocks write succeeded, so a client retry cannot leave a
 * duplicate visible reply. A no-op when Liveblocks is not configured.
 */
export async function deleteArtifactComment({
  roomId,
  threadId,
  commentId,
}: DeleteArtifactCommentOptions): Promise<void> {
  const liveblocks = getLiveblocksClient();

  if (!liveblocks) {
    return;
  }

  await liveblocks.deleteComment({ roomId, threadId, commentId });
}

/**
 * Add a reply comment to an existing Liveblocks artifact thread and return the
 * created comment. Liveblocks is the source of truth for document comments; the
 * caller projects the returned comment into the local DB. All replies attach to
 * the thread directly (flat replies, FEA-3950) — Liveblocks has no per-comment
 * parent, so threaded discussion is a single flat comment list under the thread.
 */
export async function replyToArtifactThread({
  roomId,
  threadId,
  userId,
  bodyText,
}: ReplyToArtifactThreadOptions): Promise<CommentData> {
  const liveblocks = getLiveblocksClient();

  if (!liveblocks) {
    throw new Error("LIVEBLOCKS_SECRET is not configured");
  }

  return await liveblocks.createComment({
    roomId,
    threadId,
    data: { userId, body: buildCommentBody(bodyText) },
  });
}

/**
 * Mark a Liveblocks artifact thread as resolved, attributing the resolution to
 * `userId`. Returns the updated thread so the caller can re-project resolution
 * state. Author-only enforcement lives in the API service layer, not here.
 */
export async function markArtifactThreadResolved({
  roomId,
  threadId,
  userId,
}: MarkArtifactThreadResolutionOptions): Promise<ThreadData> {
  const liveblocks = getLiveblocksClient();

  if (!liveblocks) {
    throw new Error("LIVEBLOCKS_SECRET is not configured");
  }

  return await liveblocks.markThreadAsResolved({
    roomId,
    threadId,
    data: { userId },
  });
}

/**
 * Mark a Liveblocks artifact thread as unresolved, attributing the action to
 * `userId`. Mirror of {@link markArtifactThreadResolved}.
 */
export async function markArtifactThreadUnresolved({
  roomId,
  threadId,
  userId,
}: MarkArtifactThreadResolutionOptions): Promise<ThreadData> {
  const liveblocks = getLiveblocksClient();

  if (!liveblocks) {
    throw new Error("LIVEBLOCKS_SECRET is not configured");
  }

  return await liveblocks.markThreadAsUnresolved({
    roomId,
    threadId,
    data: { userId },
  });
}

/**
 * Get a Liveblocks client instance.
 * Returns null if LIVEBLOCKS_SECRET is not configured.
 */
function getLiveblocksClient(): Liveblocks | null {
  const secret = keys().LIVEBLOCKS_SECRET;
  if (!secret) {
    return null;
  }
  return new Liveblocks({ secret });
}

function buildCommentBody(bodyText: string): CommentBody {
  return {
    version: 1,
    content: [
      {
        type: "paragraph",
        children: [{ text: bodyText }],
      },
    ],
  };
}

function buildThreadMetadata(
  version: number | undefined,
  anchorStatus?: DocumentThreadAnchorStatusType
): {
  resolved: false;
  version?: number;
  anchorStatus?: DocumentThreadAnchorStatusType;
} {
  const metadata: {
    resolved: false;
    version?: number;
    anchorStatus?: DocumentThreadAnchorStatusType;
  } = { resolved: false };
  if (version !== undefined) {
    metadata.version = version;
  }
  if (anchorStatus !== undefined) {
    metadata.anchorStatus = anchorStatus;
  }
  return metadata;
}
