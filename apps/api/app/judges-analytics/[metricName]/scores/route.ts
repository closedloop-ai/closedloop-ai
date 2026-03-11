import type { JudgeScoresResponse } from "@repo/api/src/types/judges-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parsePromptNameParam } from "@/lib/judge-name-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { judgesAnalyticsService } from "../../service";
import { scoreComparisonQueryValidator } from "../../validators";

export const GET = withAnyAuth<
  JudgeScoresResponse,
  "/judges-analytics/[metricName]/scores"
>(async ({ user }, _request, params) => {
  try {
    const { params: query, errorResponse: queryErrorResponse } =
      parseQueryParams(_request, scoreComparisonQueryValidator);
    if (queryErrorResponse) {
      return queryErrorResponse;
    }

    const { metricName: rawMetricName } = await params;
    const metricName = parsePromptNameParam(rawMetricName);
    if (metricName === null) {
      return badRequestResponse(
        "Invalid metricName format: must be alphanumeric with underscores"
      );
    }

    const result = await judgesAnalyticsService.getJudgeScores(
      user.organizationId,
      metricName,
      query.reportType,
      query.page,
      query.pageSize
    );

    if (!result) {
      return notFoundResponse("Judge");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch judge scores", error);
  }
});
