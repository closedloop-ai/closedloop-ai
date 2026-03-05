import type {
  SubmitJudgeRatingResponse,
  UserJudgeRatingsResponse,
} from "@repo/api/src/types/judges-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
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
  "/artifacts/[id]/judge-ratings"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const result = await getUserJudgeRatings(user.organizationId, user.id, id);
    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch judge ratings", error);
  }
});

export const POST = withAnyAuth<
  SubmitJudgeRatingResponse,
  "/artifacts/[id]/judge-ratings"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

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
      id,
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
