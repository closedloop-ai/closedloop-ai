import { success } from "@repo/api/src/types/common";
import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import { PullRequestNotFoundError } from "../../errors";
import { pullRequestRatingsService } from "../../service";
import { submitPullRequestRatingSchema } from "./validators";

export const GET = withAnyAuth<
  PullRequestRatingSummary,
  "/pull-requests/[id]/rating"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const summary = await pullRequestRatingsService.getRating(
      id,
      user.id,
      user.organizationId
    );
    return NextResponse.json(success(summary));
  } catch (error) {
    if (error instanceof PullRequestNotFoundError) {
      return notFoundResponse("Pull Request");
    }
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
      // Service layer verifies PR belongs to user.organizationId via denormalized organizationId field (defense-in-depth)
      const summary = await pullRequestRatingsService.upsertRating(
        id,
        user.id,
        user.organizationId,
        score,
        comment
      );
      return NextResponse.json(success(summary));
    } catch (error) {
      if (error instanceof PullRequestNotFoundError) {
        return notFoundResponse("Pull Request");
      }
      return errorResponse("Failed to submit rating", error);
    }
  },
  { requiredScopes: ["write"] }
);
