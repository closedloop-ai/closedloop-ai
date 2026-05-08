import { success } from "@repo/api/src/types/common";
import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import { pullRequestRatingsService } from "../../ratings-service";
import { submitPullRequestRatingSchema } from "./validators";

export const GET = withAnyAuth<
  PullRequestRatingSummary,
  "/pull-requests/[id]/rating"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const result = await pullRequestRatingsService.getRating(
      id,
      user.id,
      user.organizationId
    );

    if (result.ok) {
      return NextResponse.json(success(result.value));
    }

    if (result.error === Status.NotFound) {
      return notFoundResponse("Pull Request");
    }

    return errorResponse("Failed to fetch rating", result.error);
  } catch (error) {
    return errorResponse("Failed to fetch rating", error);
  }
});

export const PUT = withAnyAuth<
  PullRequestRatingSummary,
  "/pull-requests/[id]/rating"
>(
  async ({ user }, request, params) => {
    const { id } = await params;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      submitPullRequestRatingSchema
    );
    if (parseError) {
      return parseError;
    }

    const { score, comment } = body;

    try {
      const result = await pullRequestRatingsService.upsertRating(
        id,
        user.id,
        user.organizationId,
        score,
        comment
      );

      if (result.ok) {
        return NextResponse.json(success(result.value));
      }

      if (result.error === Status.NotFound) {
        return notFoundResponse("Pull Request");
      }

      return errorResponse("Failed to submit rating", result.error);
    } catch (error) {
      return errorResponse("Failed to submit rating", error);
    }
  },
  { requiredScopes: ["write"] }
);
