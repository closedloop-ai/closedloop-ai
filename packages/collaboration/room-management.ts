import "server-only";
import { Liveblocks } from "@liveblocks/node";
import { keys } from "./keys";
import type { CommentBody, ThreadData } from "./webhook";
import { anchorThreadToText, findAnchorText } from "./yjs-anchor";

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
};

export async function createArtifactThread({
  roomId,
  userId,
  bodyText,
  anchorText,
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

  const body: CommentBody = {
    version: 1,
    content: [
      {
        type: "paragraph",
        children: [{ text: bodyText }],
      },
    ],
  };

  const thread = await liveblocks.createThread({
    roomId,
    data: {
      comment: { userId, body },
      metadata: { resolved: false },
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
