import type {
  SubmitJudgeRatingResponse,
  UserJudgeRatingsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { getUserJudgeRatings, submitJudgeRating } from "./service";
import { submitJudgeRatingValidator } from "./validators";

export const GET = withAnyAuth<
  UserJudgeRatingsResponse,
  "/documents/[id]/judge-ratings"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }
    const result = await getUserJudgeRatings(
      user.organizationId,
      user.id,
      resolvedId
    );
    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch judge ratings", error);
  }
});

export const POST = withAnyAuth<
  SubmitJudgeRatingResponse,
  "/documents/[id]/judge-ratings"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      submitJudgeRatingValidator
    );
    if (parseError) {
      return parseError;
    }

    const result = await submitJudgeRating(
      user.organizationId,
      user.id,
      resolvedId,
      body.judgeScoreId,
      body.rating
    );

    if (!result) {
      return notFoundResponse("JudgeScore");
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to submit judge rating", error);
  }
});
