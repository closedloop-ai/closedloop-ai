import { auth } from "@repo/auth/server";
import { resolveRoomMetadata } from "@repo/collaboration/room-metadata";
import { parseArtifactRoomId } from "@repo/collaboration/room-utils";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { fetchUser } from "../../fetch-user";

/**
 * GET /api/collaboration/rooms/resolve?roomIds=id1,id2,...
 *
 * Resolves room IDs to display names and navigation URLs by reading
 * Liveblocks room metadata (which stores artifactType at creation time).
 * Used by the client-side resolveRoomsInfo function in the top-level provider.
 *
 * Only resolves rooms belonging to the authenticated user's organization.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { userId, getToken } = await auth();
    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const user = await fetchUser(getToken);
    if (!user) {
      return new Response("Unable to fetch user", { status: 500 });
    }

    const { searchParams } = new URL(request.url);
    const roomIdsParam = searchParams.get("roomIds");

    if (!roomIdsParam) {
      return NextResponse.json([]);
    }

    const roomIds = roomIdsParam.split(",").filter(Boolean);
    if (roomIds.length === 0) {
      return NextResponse.json([]);
    }

    // Filter to only rooms belonging to the user's organization (defense in depth)
    const orgScopedRoomIds = roomIds.filter((roomId) => {
      try {
        const { organizationId } = parseArtifactRoomId(roomId);
        return organizationId === user.organizationId;
      } catch {
        return false;
      }
    });

    // Cap at 50 rooms per request to prevent abuse
    const cappedRoomIds = orgScopedRoomIds.slice(0, 50);
    const results = await resolveRoomMetadata(cappedRoomIds);

    return NextResponse.json(results);
  } catch (error) {
    log.error("Room resolve error", { error: parseError(error) });
    return new Response("Internal server error", { status: 500 });
  }
}
