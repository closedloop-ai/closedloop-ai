import { success } from "@repo/api/src/types/common";
import type { DocumentRatingSummary } from "@repo/api/src/types/rating";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";
import { documentEvaluationService } from "../../evaluation-service";
import { submitRatingSchema } from "./validators";

export const GET = withAuth<DocumentRatingSummary, "/documents/[id]/rating">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }
      const summary = await documentEvaluationService.getRating(
        resolvedId,
        user.id,
        user.organizationId
      );
      return NextResponse.json(success(summary));
    } catch (error) {
      return errorResponse("Failed to fetch rating", error);
    }
  }
);

export const PUT = withAuth<DocumentRatingSummary, "/documents/[id]/rating">(
  async ({ user }, request, params) => {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      submitRatingSchema
    );
    if (parseError) {
      return parseError;
    }

    const { score, comment } = body;

    try {
      const result = await documentEvaluationService.upsertRating(
        resolvedId,
        user.id,
        user.organizationId,
        score,
        comment
      );

      if (!result.ok) {
        if (result.error === Status.NotFound) {
          return notFoundResponse("Artifact");
        }
        return errorResponse("Failed to submit rating", result.error);
      }

      return NextResponse.json(success(result.value));
    } catch (error) {
      return errorResponse("Failed to submit rating", error);
    }
  }
);
