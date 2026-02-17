import { success } from "@repo/api/src/types/common";
import type { PullRequestRatingSummary } from "@repo/api/src/types/pull-request-rating";
import { rateLimit } from "@repo/security";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import {
  PullRequestNotFoundError,
  pullRequestRatingsService,
} from "../../service";
import { submitPullRequestRatingSchema } from "./validators";

export const GET = withAuth<
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

export const PUT = withAuth<
  PullRequestRatingSummary,
  "/pull-requests/[id]/rating"
>(async ({ user }, request, params) => {
  const { id } = await params;

  try {
    // Rate limiting: 10 requests per minute per user per PR
    await rateLimit(`pr_rating_${user.id}_${id}`, 10, "60s", request);
  } catch (error) {
    return errorResponse(
      "Rate limit exceeded. Please try again later.",
      error,
      429
    );
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
    // Service layer verifies PR belongs to user.organizationId via artifact relationship join
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
});
