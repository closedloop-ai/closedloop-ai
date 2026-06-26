import "server-only";
import { Liveblocks } from "@liveblocks/node";
import { withProsemirrorDocument } from "@liveblocks/node-prosemirror";
import type { DocumentVersionPublishedEvent } from "../shared/room-events";
import { keys } from "./keys";
import type { CommentBody, ThreadData } from "./webhook";
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

  const body: CommentBody = {
    version: 1,
    content: [
      {
        type: "paragraph",
        children: [{ text: bodyText }],
      },
    ],
  };

  const metadata: { resolved: false; version?: number } = { resolved: false };
  if (version !== undefined) {
    metadata.version = version;
  }

  const thread = await liveblocks.createThread({
    roomId,
    data: {
      comment: { userId, body },
      metadata,
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
