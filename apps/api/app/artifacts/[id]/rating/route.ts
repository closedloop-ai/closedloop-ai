import { success } from "@repo/api/src/types/common";
import type { ArtifactRatingSummary } from "@repo/api/src/types/rating";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import { ArtifactNotFoundError } from "../../artifact-utils";
import { artifactsService } from "../../service";
import { submitRatingSchema } from "./validators";

export const GET = withAuth<ArtifactRatingSummary, "/artifacts/[id]/rating">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const summary = await artifactsService.getRating(
        id,
        user.id,
        user.organizationId
      );
      return NextResponse.json(success(summary));
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        return notFoundResponse("Artifact");
      }
      return errorResponse("Failed to fetch rating", error);
    }
  }
);

export const PUT = withAuth<ArtifactRatingSummary, "/artifacts/[id]/rating">(
  async ({ user }, request, params) => {
    const { id } = await params;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      submitRatingSchema
    );
    if (parseError) {
      return parseError;
    }

    const { score, comment } = body;

    try {
      const summary = await artifactsService.upsertRating(
        id,
        user.id,
        user.organizationId,
        score,
        comment
      );
      return NextResponse.json(success(summary));
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        return notFoundResponse("Artifact");
      }
      return errorResponse("Failed to submit rating", error);
    }
  }
);
