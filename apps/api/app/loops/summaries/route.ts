import type { LoopSummariesResponse } from "@repo/api/src/types/loop";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopSummaryService } from "../loop-summary-service";
import { loopSummariesBodyValidator } from "../validators";

export const POST = withAnyAuth<LoopSummariesResponse, "/loops/summaries">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        loopSummariesBodyValidator
      );
      if (parseError) {
        return parseError;
      }

      const summaries = await loopSummaryService.getSummariesForDocuments(
        user.organizationId,
        body.documentIds
      );

      return successResponse(summaries);
    } catch (error) {
      return errorResponse("Failed to fetch loop summaries", error);
    }
  }
);
