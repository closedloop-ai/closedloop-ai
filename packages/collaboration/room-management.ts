import "server-only";
import { Liveblocks } from "@liveblocks/node";
import { keys } from "./keys";

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

/**
 * Delete a Liveblocks room.
 * This function handles errors gracefully and will not throw.
 *
 * @param roomId - The ID of the room to delete
 * @returns Promise that resolves with success status and optional error message
 */
export async function deleteRoom(
  roomId: string
): Promise<{ success: boolean; error?: string }> {
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
