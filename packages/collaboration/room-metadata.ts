import "server-only";
import { Liveblocks } from "@liveblocks/node";
import { keys } from "./keys";
import { parseArtifactRoomId } from "./room-utils";

export type ResolvedRoom = {
  roomId: string;
  name: string;
  url: string | null;
};

/**
 * Maps artifact type (from Liveblocks room metadata) to a route prefix.
 * Mirrors the logic in apps/app/lib/artifact-routes.ts but operates on
 * raw string types from room metadata rather than frontend type unions.
 */
function getRouteForArtifactType(
  artifactType: string,
  documentSlug: string
): string | null {
  switch (artifactType) {
    case "PRD":
      return `/prds/${documentSlug}`;
    case "IMPLEMENTATION_PLAN":
    case "IMPLEMENTATION_STRATEGY":
      return `/implementation-plans/${documentSlug}`;
    case "ISSUE":
    case "BUG":
      return `/issues/${documentSlug}`;
    default:
      return null;
  }
}

function slugToTitleCase(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Resolves room IDs to display names and navigation URLs by reading
 * Liveblocks room metadata (which stores artifactType at creation time).
 * Falls back to generic /artifacts/:slug URL when metadata is missing.
 *
 * Always returns one entry per input room ID to maintain positional
 * correspondence with the input array.
 */
export async function resolveRoomMetadata(
  roomIds: string[]
): Promise<ResolvedRoom[]> {
  const secret = keys().LIVEBLOCKS_SECRET;

  if (!secret) {
    return resolveFromSlugsOnly(roomIds);
  }

  const liveblocks = new Liveblocks({ secret });

  const roomPromises = roomIds.map(async (roomId) => {
    try {
      const { documentSlug } = parseArtifactRoomId(roomId);
      const name = slugToTitleCase(documentSlug);

      try {
        const room = await liveblocks.getRoom(roomId);
        const artifactType = room.metadata?.artifactType;

        if (typeof artifactType === "string") {
          const url = getRouteForArtifactType(artifactType, documentSlug);
          return { roomId, name, url };
        }
      } catch {
        // Room may not exist in Liveblocks or metadata missing
      }

      // Fallback: generic redirect route
      return { roomId, name, url: `/artifacts/${documentSlug}` };
    } catch {
      // Malformed room ID — return entry with no URL
      return { roomId, name: roomId, url: null };
    }
  });

  return await Promise.all(roomPromises);
}

function resolveFromSlugsOnly(roomIds: string[]): ResolvedRoom[] {
  return roomIds.map((roomId) => {
    try {
      const { documentSlug } = parseArtifactRoomId(roomId);
      return {
        roomId,
        name: slugToTitleCase(documentSlug),
        url: `/artifacts/${documentSlug}`,
      };
    } catch {
      // Malformed room ID — return entry with no URL
      return { roomId, name: roomId, url: null };
    }
  });
}
