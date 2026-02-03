import "server-only";
import { deleteRoom } from "@repo/collaboration/room-management";
import { log } from "@repo/observability/log";

/**
 * Delete a Liveblocks room with logging.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to delete
 * @returns Promise that resolves with success status
 */
export async function deleteLiveblocksRoom(
  roomId: string
): Promise<{ success: boolean; error?: string }> {
  const result = await deleteRoom(roomId);

  if (result.success) {
    if (result.error) {
      // Success but with a warning (e.g., room didn't exist)
      log.warn("Liveblocks room deletion completed with warning", {
        roomId,
        warning: result.error,
      });
    } else {
      log.info("Liveblocks room deleted successfully", { roomId });
    }
  } else {
    // Log the error but don't throw - we don't want room deletion failures to block artifact deletion
    log.error("Failed to delete Liveblocks room", {
      roomId,
      error: result.error,
    });
  }

  return result;
}
