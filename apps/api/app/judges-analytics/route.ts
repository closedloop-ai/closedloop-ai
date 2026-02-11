import type { JudgeStatsResponse } from "@repo/api/src/types/judges-analytics";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { judgesAnalyticsService } from "./service";
import { queryParamsSchema } from "./validators";

export const GET = withAuth<JudgeStatsResponse, "/judges-analytics">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;

      // Convert searchParams to plain object for validation
      const queryParams = Object.fromEntries(searchParams.entries());

      // Validate query parameters
      const parseResult = queryParamsSchema.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const { startDate, endDate } = parseResult.data;

      // Parse dates from YYYY-MM-DD to Date objects
      const startDateObj = new Date(startDate);
      const endDateObj = new Date(endDate);

      const stats = await judgesAnalyticsService.getAggregateStats(
        user.organizationId,
        startDateObj,
        endDateObj
      );

      return successResponse(stats);
    } catch (error) {
      return errorResponse("Failed to fetch judges analytics", error);
    }
  }
);
