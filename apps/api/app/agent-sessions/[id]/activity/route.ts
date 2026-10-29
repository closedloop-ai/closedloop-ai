import type { ArtifactActivityFeedResult } from "@repo/api/src/types/artifact-activity-feed";
import { sessionActivityAdmissionService } from "@/app/agent-sessions/session-activity-admission-service";
import { artifactActivityFeedService } from "@/app/documents/artifact-activity-feed-service";
import { storedEventActivityQuerySchema } from "@/app/documents/stored-event-activity-query";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

/** Read one org-owned Session's V1 edits with the shared activity cursor. */
export const GET = withAnyAuth<
  ArtifactActivityFeedResult,
  "/agent-sessions/[id]/activity"
>(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      if (!isUuid(id)) {
        return notFoundResponse("Agent session");
      }
      const artifactId =
        await sessionActivityAdmissionService.findVisibleArtifactId(
          user.organizationId,
          id
        );
      if (!artifactId) {
        return notFoundResponse("Agent session");
      }

      const { params: query, errorResponse: parseError } = parseQueryParams(
        request,
        storedEventActivityQuerySchema
      );
      if (parseError) {
        return parseError;
      }
      const page =
        await artifactActivityFeedService.listStoredEventActivityFeed({
          organizationId: user.organizationId,
          artifactId,
          cursor: query.cursor,
          limit: query.limit,
        });
      return successResponse(page);
    } catch (error) {
      return errorResponse("Failed to fetch session activity", error);
    }
  },
  { requiredScopes: ["read"] }
);
