import "server-only";
import { Liveblocks } from "@liveblocks/node";
import {
  buildScopedDocumentPath,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";
import { parseDocumentRoomId } from "../shared/room-utils";
import { keys } from "./keys";

export type ResolvedRoom = {
  roomId: string;
  name: string;
  url: string | null;
};

/**
 * Resolves room IDs to display names and navigation URLs by reading
 * Liveblocks room metadata (which stores documentType at creation time).
 * Falls back to reading legacy artifactType/artifactSubtype for old rooms.
 * Falls back to generic /documents/:slug URL when metadata is missing.
 * Processes rooms in batches to avoid hitting Liveblocks API rate limits
 * when resolving many rooms at once.
 *
 * Always returns one entry per input room ID to maintain positional
 * correspondence with the input array.
 */
export async function resolveRoomMetadata(
  roomIds: string[],
  orgSlug?: string
): Promise<ResolvedRoom[]> {
  const secret = keys().LIVEBLOCKS_SECRET;

  if (!secret) {
    return resolveFromSlugsOnly(roomIds);
  }

  const liveblocks = new Liveblocks({ secret });

  const resolveOne = async (roomId: string): Promise<ResolvedRoom> => {
    try {
      const { slug } = parseDocumentRoomId(roomId);
      const name = slug;

      try {
        const room = await liveblocks.getRoom(roomId);
        // Read documentType first, fall back to legacy artifactType/artifactSubtype for old rooms.
        const documentType =
          room.metadata?.documentType ||
          room.metadata?.artifactType ||
          room.metadata?.artifactSubtype;

        if (typeof documentType === "string") {
          const prefix = getRoutePrefixForType(documentType);
          const url = prefix
            ? buildScopedDocumentPath(prefix, slug, orgSlug)
            : null;
          return { roomId, name, url };
        }
      } catch {
        // Room may not exist in Liveblocks or metadata missing
      }

      // Fallback: no URL when document type is unknown
      return { roomId, name, url: null };
    } catch {
      // Malformed room ID — return entry with no URL
      return { roomId, name: roomId, url: null };
    }
  };

  // Limit concurrent Liveblocks API calls to avoid rate limits.
  // With the 50-room cap in the route, this means at most 5 sequential batches.
  const MAX_CONCURRENT_ROOM_FETCHES = 10;
  const results: ResolvedRoom[] = [];

  for (let i = 0; i < roomIds.length; i += MAX_CONCURRENT_ROOM_FETCHES) {
    const batch = roomIds.slice(i, i + MAX_CONCURRENT_ROOM_FETCHES);
    const batchResults = await Promise.all(batch.map(resolveOne));
    results.push(...batchResults);
  }

  return results;
}

function resolveFromSlugsOnly(roomIds: string[]): ResolvedRoom[] {
  return roomIds.map((roomId) => {
    try {
      const { slug } = parseDocumentRoomId(roomId);
      return {
        roomId,
        name: slug,
        url: null,
      };
    } catch {
      // Malformed room ID — return entry with no URL
      return { roomId, name: roomId, url: null };
    }
  });
}
