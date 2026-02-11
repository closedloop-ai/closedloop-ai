import type { ArtifactCountsResponse } from "@repo/api/src/types/judges-analytics";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { judgesAnalyticsService } from "../service";
import { artifactCountsQueryValidator, parseDateRange } from "../validators";

export const GET = withAuth<
  ArtifactCountsResponse,
  "/judges-analytics/artifact-counts"
>(async ({ user }, request) => {
  try {
    const { body: params, errorResponse: parseError } = parseQueryParams(
      request,
      artifactCountsQueryValidator
    );
    if (parseError) {
      return parseError;
    }

    const { startDate, endDate } = parseDateRange(
      params.startDate,
      params.endDate
    );

    const counts = await judgesAnalyticsService.getArtifactCounts(
      user.organizationId,
      startDate,
      endDate,
      params.groupBy
    );

    return successResponse(counts);
  } catch (error) {
    return errorResponse("Failed to fetch artifact counts", error);
  }
});
