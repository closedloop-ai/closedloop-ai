import { auth } from "@repo/auth/server";
import { resolveRoomMetadata } from "@repo/collaboration/room-metadata";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

/**
 * GET /api/collaboration/rooms/resolve?roomIds=id1,id2,...
 *
 * Resolves room IDs to display names and navigation URLs by reading
 * Liveblocks room metadata (which stores artifactType at creation time).
 * Used by the client-side resolveRoomsInfo function in the top-level provider.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
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

    // Cap at 50 rooms per request to prevent abuse
    const cappedRoomIds = roomIds.slice(0, 50);
    const results = await resolveRoomMetadata(cappedRoomIds);

    return NextResponse.json(results);
  } catch (error) {
    log.error("Room resolve error", { error: parseError(error) });
    return new Response("Internal server error", { status: 500 });
  }
}
