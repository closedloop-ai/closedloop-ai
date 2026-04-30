import type { LoopSummariesResponse } from "@repo/api/src/types/loop";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopSummaryService } from "../loop-summary-service";
import { loopSummariesBodyValidator } from "../validators";

// POST is used for the request body (UUID arrays grow past URL length cap),
// but this is a read-only endpoint — explicitly opt into the `read` scope so
// read-only API keys can fetch summaries.
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
  },
  { requiredScopes: ["read"] }
);
