import { EVALUATION_REPORT_TYPE_OPTIONS } from "@repo/api/src/types/evaluation";
import type { JudgeDetailResponse } from "@repo/api/src/types/judges-analytics";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isCanonicalJudgePromptName } from "@/lib/judge-name-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { judgesAnalyticsService } from "../service";

const judgeDetailQueryValidator = z.object({
  reportType: z.enum(EVALUATION_REPORT_TYPE_OPTIONS),
});

export const GET = withAnyAuth<
  JudgeDetailResponse,
  "/judges-analytics/[promptName]"
>(async ({ user }, _request, params) => {
  try {
    const { params: query, errorResponse: queryErrorResponse } =
      parseQueryParams(_request, judgeDetailQueryValidator);
    if (queryErrorResponse) {
      return queryErrorResponse;
    }

    const { promptName: rawPromptName } = await params;
    let promptName = decodeURIComponent(rawPromptName);
    promptName = promptName.toLowerCase();

    if (!isCanonicalJudgePromptName(promptName)) {
      return badRequestResponse(
        "Invalid promptName format: must be alphanumeric with underscores"
      );
    }

    const result = await judgesAnalyticsService.getJudgeDetail(
      user.organizationId,
      promptName,
      query.reportType
    );

    if (!result) {
      return notFoundResponse("Judge");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch judge detail", error);
  }
});
