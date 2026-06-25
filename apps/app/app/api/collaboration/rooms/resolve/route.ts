import {
  BATCH_META_MAX_SLUGS,
  buildScopedDocumentPath,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";
import { auth } from "@repo/auth/server";
import { resolveRoomMetadata } from "@repo/collaboration/server/room-metadata";
import { parseDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { fetchBatchMeta } from "../../fetch-batch-meta";
import { fetchUser } from "../../fetch-user";

/**
 * GET /api/collaboration/rooms/resolve?roomIds=id1,id2,...
 *
 * Resolves room IDs to display names and navigation URLs by reading
 * Liveblocks room metadata (which stores documentType at creation time).
 * Used by the client-side resolveRoomsInfo function in the top-level provider.
 *
 * Only resolves rooms belonging to the authenticated user's organization.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { userId, getToken, orgSlug } = await auth();
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
        const { organizationId } = parseDocumentRoomId(roomId);
        return organizationId === user.organizationId;
      } catch {
        return false;
      }
    });

    // Cap at BATCH_META_MAX_SLUGS rooms per request to match batch-meta endpoint limit
    const cappedRoomIds = orgScopedRoomIds.slice(0, BATCH_META_MAX_SLUGS);

    // Extract slugs for title enrichment (derived from cappedRoomIds, independent of resolveRoomMetadata)
    const slugs = cappedRoomIds.flatMap((roomId) => {
      try {
        return [parseDocumentRoomId(roomId).slug];
      } catch {
        return [];
      }
    });

    // Parallelize: room metadata resolution and title fetching are independent
    const [results, titleMap] = await Promise.all([
      resolveRoomMetadata(cappedRoomIds, orgSlug ?? undefined),
      fetchBatchMeta(slugs, getToken),
    ]);

    // Enrich room names with human-readable artifact titles from the BFF API.
    // Also use the document type from batch-meta to build type-specific URLs
    // for rooms where resolveRoomMetadata returned url: null (e.g. when
    // Liveblocks metadata is missing or the room was created without a type).
    try {
      const enrichedResults = results.map((room) => {
        try {
          const { slug } = parseDocumentRoomId(room.roomId);
          const meta = titleMap[slug];
          const name = meta?.title ?? room.name;

          if (room.url === null && meta?.type) {
            const prefix = getRoutePrefixForType(meta.type);
            const url = prefix
              ? buildScopedDocumentPath(prefix, slug, orgSlug)
              : null;
            return { ...room, name, url };
          }

          return { ...room, name };
        } catch {
          return room;
        }
      });

      return NextResponse.json(enrichedResults);
    } catch (enrichError) {
      log.error("Failed to enrich room names, returning unmodified results", {
        error: parseError(enrichError),
      });
      return NextResponse.json(results);
    }
  } catch (error) {
    log.error("Room resolve error", { error: parseError(error) });
    return new Response("Internal server error", { status: 500 });
  }
}
