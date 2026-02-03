import "server-only";
import {
  type CreateRoomOptions,
  createRoom,
  deleteRoom,
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
