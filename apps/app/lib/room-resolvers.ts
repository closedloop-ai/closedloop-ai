import { parseArtifactRoomId } from "@repo/collaboration/room-utils";
import type { RoomInfo } from "@repo/collaboration/top-level-collaboration-provider";

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
  }): Promise<(RoomInfo | undefined)[]> => {
    const orgRoomIds = roomIds.filter((roomId) => {
      try {
        const { organizationId: roomOrgId } = parseArtifactRoomId(roomId);
        return roomOrgId === organizationId;
      } catch {
        return false;
      }
    });

    if (orgRoomIds.length === 0) {
      return roomIds.map(() => undefined);
    }

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

    return roomIds.map((roomId) => {
      const resolved = resolvedMap.get(roomId);
      if (resolved) {
        return {
          name: resolved.name,
          url: resolved.url ?? undefined,
        } satisfies RoomInfo;
      }

      try {
        const { organizationId: roomOrgId, slug } = parseArtifactRoomId(roomId);
        if (roomOrgId !== organizationId) {
          return undefined;
        }
        return {
          name: slug,
          url: `/artifacts/${slug}`,
        } satisfies RoomInfo;
      } catch {
        return undefined;
      }
    });
  };
}

type ResolvedRoom = {
  roomId: string;
  name: string;
  url: string | null;
};
