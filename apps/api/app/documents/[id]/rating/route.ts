import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { success } from "@repo/api/src/types/common";
import type { DocumentRatingSummary } from "@repo/api/src/types/rating";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { documentRatingReceiptWrite } from "../../document-rating-receipt";
import { documentEvaluationService } from "../../evaluation-service";
import { submitRatingSchema } from "./validators";

export const GET = withAnyAuth<DocumentRatingSummary, "/documents/[id]/rating">(
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

export const PUT = withAnyAuth<DocumentRatingSummary, "/documents/[id]/rating">(
  withOperationReceipts(
    OperationKind.Rate,
    async ({ user }, request, params, receipts) => {
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
          comment,
          receipts.whenRecording((tx, written) =>
            receipts.record(tx, documentRatingReceiptWrite(resolvedId, written))
          )
        );

        if (!result.ok) {
          if (result.error === Status.NotFound) {
            return notFoundResponse("Artifact");
          }
          return errorResponse("Failed to submit rating", result.error);
        }

        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to submit rating", error);
      }
    }
  )
);
