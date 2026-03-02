import type { JudgeDetailResponse } from "@repo/api/src/types/judges-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { judgesAnalyticsService } from "../service";

const PROMPT_NAME_PATTERN = /^[a-z0-9_]+$/;

export const GET = withAnyAuth<
  JudgeDetailResponse,
  "/judges-analytics/[promptName]"
>(async ({ user }, _request, params) => {
  try {
    const { promptName: rawPromptName } = await params;
    let promptName = decodeURIComponent(rawPromptName);
    promptName = promptName.toLowerCase();

    if (!PROMPT_NAME_PATTERN.exec(promptName)) {
      return badRequestResponse(
        "Invalid promptName format: must be alphanumeric with underscores"
      );
    }

    const result = await judgesAnalyticsService.getJudgeDetail(
      user.organizationId,
      promptName
    );

    if (!result) {
      return notFoundResponse("Judge");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch judge detail", error);
  }
});
