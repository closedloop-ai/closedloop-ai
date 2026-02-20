import { success } from "@repo/api/src/types/common";
import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { rateLimit } from "@repo/security";
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

    try {
      // Global rate limit: 50 submissions per minute per user across all PRs
      await rateLimit(`pr_rating_user_${user.id}`, 50, "60s", request);
      // Per-PR rate limit: 10 requests per minute per user per PR
      await rateLimit(`pr_rating_${user.id}_${id}`, 10, "60s", request);
    } catch (error) {
      const isRateLimit =
        error instanceof Error && error.message === "Rate limit exceeded";
      if (isRateLimit) {
        return errorResponse(
          "Rate limit exceeded. Please try again later.",
          error,
          429
        );
      }
      return errorResponse("Access denied", error, 403);
    }

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
