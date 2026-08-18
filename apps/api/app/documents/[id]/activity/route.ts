import type { ArtifactActivityFeedResult } from "@repo/api/src/types/artifact-activity-feed";
import { ARTIFACT_ACTIVITY_FEED_MAX_LIMIT } from "@repo/api/src/types/artifact-activity-feed";
import { artifactActivityFeedService } from "@/app/documents/artifact-activity-feed-service";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /documents/[id]/activity — the aggregate activity feed for one artifact
 * (FEA-3864 / FEA-3535 Slice 3).
 *
 * Returns the merged, newest-first, cursor-paginated timeline: persisted
 * `ArtifactActivityEvent` rows fused with on-read projections (versions,
 * PRODUCES derivations, loops, evaluations), each with a normalized actor.
 *
 * Org-scoped: the id is resolved within the caller's organization and the
 * artifact's existence is verified before any feed read, and every underlying
 * source query filters on the org — so one org can never read another's feed.
 *
 * Query params:
 *   - `cursor` — opaque `nextCursor` from the prior page (keyset pagination).
 *   - `limit`  — page size (1..ARTIFACT_ACTIVITY_FEED_MAX_LIMIT); over-large
 *                values are clamped by the service.
 */
export const GET = withAnyAuth<ArtifactActivityFeedResult, "/documents/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      // Verify the artifact exists in the caller's org before reading its feed.
      const artifact = await documentService.findById(
        resolvedId,
        user.organizationId
      );
      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      const searchParams = request.nextUrl.searchParams;
      const cursor = searchParams.get("cursor");
      const limitParam = searchParams.get("limit");
      let limit: number | undefined;
      if (limitParam !== null) {
        const parsed = Number(limitParam);
        if (
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > ARTIFACT_ACTIVITY_FEED_MAX_LIMIT
        ) {
          return badRequestResponse(
            `limit must be an integer between 1 and ${ARTIFACT_ACTIVITY_FEED_MAX_LIMIT}`
          );
        }
        limit = parsed;
      }

      const result = await artifactActivityFeedService.listActivityFeed({
        organizationId: user.organizationId,
        artifactId: resolvedId,
        cursor,
        limit,
      });

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to fetch artifact activity", error);
    }
  }
);
