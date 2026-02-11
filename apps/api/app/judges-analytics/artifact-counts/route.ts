import type { ArtifactCountsResponse } from "@repo/api/src/types/judges-analytics";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { judgesAnalyticsService } from "../service";
import { artifactCountsParamsSchema } from "../validators";

export const GET = withAuth<
  ArtifactCountsResponse,
  "/judges-analytics/artifact-counts"
>(async ({ user }, request) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const queryParams = Object.fromEntries(searchParams.entries());
    const parseResult = artifactCountsParamsSchema.safeParse(queryParams);

    if (!parseResult.success) {
      return badRequestResponse(
        `Invalid query parameters: ${parseResult.error.message}`
      );
    }

    const { startDate, endDate, groupBy } = parseResult.data;
    const startDateObj = new Date(`${startDate}T00:00:00.000Z`);
    const endDateObj = new Date(`${endDate}T23:59:59.999Z`);

    const counts = await judgesAnalyticsService.getArtifactCounts(
      user.organizationId,
      startDateObj,
      endDateObj,
      groupBy
    );

    return successResponse(counts);
  } catch (error) {
    return errorResponse("Failed to fetch artifact counts", error);
  }
});
