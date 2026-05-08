import "server-only";
import {
  type CreateRoomOptions,
  createRoom,
  deleteRoom,
  resetRoom,
  updateRoomMetadata,
} from "@repo/collaboration/room-management";
import { log } from "@repo/observability/log";

/**
 * Create a Liveblocks room with tenant isolation and logging.
 * This function handles errors gracefully and will not throw.
 *
 * @param options - Room creation options including roomId, tenantId, and optional metadata
 * @returns Promise that resolves with success status
 */
export async function createLiveblocksRoom(
  options: CreateRoomOptions
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await createRoom(options);

  if (result.success) {
    log.info("Liveblocks room created", { roomId: options.roomId });
  } else {
    // Log the error but don't throw - if this fails, RoomProvider will auto-create the room
    log.error("Failed to create Liveblocks room", {
      roomId: options.roomId,
      error: result.error,
    });
  }

  return result;
}

/**
 * Update metadata on an existing Liveblocks room with logging.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to update
 * @param metadata - Key-value pairs to merge into existing metadata
 * @returns Promise that resolves with success status
 */
export async function updateLiveblocksRoomMetadata(
  roomId: string,
  metadata: Record<string, string | null>
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await updateRoomMetadata(roomId, metadata);

  if (!result.success) {
    log.error("Failed to update Liveblocks room metadata", {
      roomId,
      error: result.error,
    });
  }

  return result;
}

/**
 * Reset a Liveblocks room.
 * This function clears the room's content and deletes all threads.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to reset
 * @returns Promise that resolves with success status and optional error message
 */
export async function resetLiveblocksRoom(
  roomId: string
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await resetRoom(roomId);

  if (!result.success) {
    log.error("Failed to reset Liveblocks room", {
      roomId,
      error: result.error,
    });
  }

  return result;
}

/**
 * Delete a Liveblocks room with logging.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to delete
 * @returns Promise that resolves with success status
 */
export async function deleteLiveblocksRoom(
  roomId: string
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await deleteRoom(roomId);

  if (!result.success) {
    // Log the error but don't throw - we don't want room deletion failures to block artifact deletion
    log.error("Failed to delete Liveblocks room", {
      roomId,
      error: result.error,
    });
  }

  return result;
}
