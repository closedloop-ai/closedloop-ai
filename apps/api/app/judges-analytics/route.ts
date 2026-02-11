import type { JudgeStatsResponse } from "@repo/api/src/types/judges-analytics";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { judgesAnalyticsService } from "./service";
import { judgesAnalyticsQueryValidator, parseDateRange } from "./validators";

export const GET = withAuth<JudgeStatsResponse, "/judges-analytics">(
  async ({ user }, request) => {
    try {
      const { body: params, errorResponse: parseError } = parseQueryParams(
        request,
        judgesAnalyticsQueryValidator
      );
      if (parseError) {
        return parseError;
      }

      const { startDate, endDate } = parseDateRange(
        params.startDate,
        params.endDate
      );

      const stats = await judgesAnalyticsService.getAggregateStats(
        user.organizationId,
        startDate,
        endDate
      );

      return successResponse(stats);
    } catch (error) {
      return errorResponse("Failed to fetch judges analytics", error);
    }
  }
);
