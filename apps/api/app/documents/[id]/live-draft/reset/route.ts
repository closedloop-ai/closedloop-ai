import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { liveDraftResetReceiptWrite } from "@/app/documents/document-live-draft-reset-receipt";
import {
  type LiveDraftReset,
  LiveDraftResetError,
  liveDraftService,
} from "@/app/documents/live-draft-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  serviceUnavailableResponse,
  successResponse,
} from "@/lib/route-utils";

export const POST = withAnyAuth<
  LiveDraftReset,
  "/documents/[id]/live-draft/reset"
>(
  withOperationReceipts(
    OperationKind.LiveDraftReset,
    async ({ user }, _request, params, receipts) => {
      try {
        const { id } = await params;
        const resolvedId = await resolveDocumentId(id, user.organizationId);
        if (!resolvedId) {
          return notFoundResponse("Artifact");
        }
        const result = await liveDraftService.resetToLatest(
          resolvedId,
          user.organizationId
        );
        if (result.ok) {
          // The reset lands in doc-sync, outside any transaction of ours, so
          // its receipt is written on its own once doc-sync confirms it.
          await receipts.recordStandalone(
            liveDraftResetReceiptWrite(resolvedId, result.value)
          );
          return successResponse(
            withOperationReceipt(result.value.reset, receipts)
          );
        }
        if (result.error === LiveDraftResetError.DocumentNotFound) {
          return notFoundResponse("Artifact");
        }
        if (result.error === LiveDraftResetError.VersionNotFound) {
          return notFoundResponse("Artifact version");
        }
        return serviceUnavailableResponse("Failed to reset the live draft");
      } catch (error) {
        return errorResponse("Failed to reset the live draft", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
