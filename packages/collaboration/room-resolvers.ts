import "./config";
import { parseArtifactRoomId } from "./room-utils";

type ResolvedRoom = {
  roomId: string;
  name: string;
  url: string | null;
};

function slugToTitleCase(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Creates an async resolver that maps room IDs to display info (name + URL) for Liveblocks.
 * Only resolves rooms belonging to the given organization.
 *
 * Calls the server-side /api/collaboration/rooms/resolve endpoint which reads
 * Liveblocks room metadata (artifactType) to build correct type-specific URLs
 * (e.g., /prds/slug, /issues/slug). Falls back to slug-based names on error.
 */
export function createResolveRoomsInfo(organizationId: string) {
  return async ({
    roomIds,
  }: {
    roomIds: string[];
  }): Promise<(Liveblocks["RoomInfo"] | undefined)[]> => {
    // Filter to only rooms in this organization (client-side pre-filter)
    const orgRoomIds: string[] = [];

    for (const roomId of roomIds) {
      try {
        const { organizationId: roomOrgId } = parseArtifactRoomId(roomId);
        if (roomOrgId === organizationId) {
          orgRoomIds.push(roomId);
        }
      } catch {
        // Skip malformed room IDs
      }
    }

    if (orgRoomIds.length === 0) {
      return roomIds.map(() => undefined);
    }

    // Call server endpoint for room metadata resolution
    let resolvedMap = new Map<string, ResolvedRoom>();
    try {
      const uniqueRoomIds = [...new Set(orgRoomIds)];
      const response = await fetch(
        `/api/collaboration/rooms/resolve?roomIds=${uniqueRoomIds.join(",")}`
      );

      if (response.ok) {
        const resolved: ResolvedRoom[] = await response.json();
        resolvedMap = new Map(resolved.map((r) => [r.roomId, r]));
      }
    } catch {
      // Network error — fall back to slug-based resolution below
    }

    // Build result array maintaining original order
    return roomIds.map((roomId) => {
      const resolved = resolvedMap.get(roomId);
      if (resolved) {
        return {
          name: resolved.name,
          url: resolved.url,
        } satisfies Liveblocks["RoomInfo"];
      }

      // Fallback for rooms not returned by server
      try {
        const { organizationId: roomOrgId, documentSlug } =
          parseArtifactRoomId(roomId);
        if (roomOrgId !== organizationId) {
          return undefined;
        }
        return {
          name: slugToTitleCase(documentSlug),
          url: `/artifacts/${documentSlug}`,
        } satisfies Liveblocks["RoomInfo"];
      } catch {
        return undefined;
      }
    });
  };
}
