import type { PrHealthResponse } from "@repo/api/src/types/judges-analytics";
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
import { parseDateRange, prHealthQueryValidator } from "../../validators";

export const GET = withAnyAuth<
  PrHealthResponse,
  "/judges-analytics/[promptName]/pr-health"
>(async ({ user }, _request, params) => {
  try {
    const { params: query, errorResponse: queryErrorResponse } =
      parseQueryParams(_request, prHealthQueryValidator);
    if (queryErrorResponse) {
      return queryErrorResponse;
    }

    const { promptName: rawPromptName } = await params;
    const promptName = parsePromptNameParam(rawPromptName);
    if (promptName === null) {
      return badRequestResponse(
        "Invalid promptName format: must be alphanumeric with underscores"
      );
    }

    const { startDate, endDate } = parseDateRange(
      query.startDate,
      query.endDate
    );

    const result = await judgesAnalyticsService.getPrHealthMetrics(
      user.organizationId,
      promptName,
      query.reportType,
      startDate,
      endDate,
      query.granularity
    );

    if (!result) {
      return notFoundResponse("Judge");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch PR health metrics", error);
  }
});
