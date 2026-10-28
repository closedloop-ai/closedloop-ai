import type { ArtifactActivityFeedResult } from "@repo/api/src/types/artifact-activity-feed";
import { branchActivityFeedService } from "@/app/branches/branch-activity-feed-service";
import { storedEventActivityQuerySchema } from "@/app/documents/stored-event-activity-query";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

/** Read one Product-eligible Branch's V1 edits with the shared activity cursor. */
export const GET = withAnyAuth<
  ArtifactActivityFeedResult,
  "/branches/[id]/activity"
>(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      if (!isUuid(id)) {
        return notFoundResponse("Branch");
      }
      const { params: query, errorResponse: parseError } = parseQueryParams(
        request,
        storedEventActivityQuerySchema
      );
      if (parseError) {
        return parseError;
      }
      const page = await branchActivityFeedService.listActivityFeed({
        organizationId: user.organizationId,
        branchId: id,
        cursor: query.cursor,
        limit: query.limit,
      });
      if (!page) {
        return notFoundResponse("Branch");
      }
      return successResponse(page);
    } catch (error) {
      return errorResponse("Failed to fetch branch activity", error);
    }
  },
  { requiredScopes: ["read"] }
);
