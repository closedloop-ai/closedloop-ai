import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  type TranscriptSyncPlanResponse,
  transcriptSyncPlanRequestSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { parseBody, successResponse } from "@/lib/route-utils";
import { transcriptSyncService } from "../service";
import { transcriptPlanReceiptWrite } from "../transcript-plan-receipt";
import { transcriptErrorResponse } from "../transcript-route-helpers";
import { TRANSCRIPT_SYNC_PLAN_MAX_BYTES } from "./max-bytes";

/**
 * POST /desktop/transcripts/sync-plan — decide the upload shape (noop / fullPut
 * / multipart) for one transcript file and mint presigned URLs. Desktop session
 * JWT (or API key) via withAnyAuth; ownership + rate limiting in the service.
 * Ships dark until the desktop client (FEA-2715) calls it.
 */
export const POST = withAnyAuth<
  TranscriptSyncPlanResponse,
  "/desktop/transcripts/sync-plan"
>(
  withOperationReceipts(
    OperationKind.DesktopSync,
    async ({ user, clerkUserId, authMethod }, request, _params, receipts) => {
      const { body, errorResponse: bodyError } = await parseBody(
        request,
        transcriptSyncPlanRequestSchema,
        { maxBytes: TRANSCRIPT_SYNC_PLAN_MAX_BYTES }
      );
      if (bodyError) {
        return bodyError;
      }

      const result = await transcriptSyncService.planSync(
        {
          request: body,
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          authMethod,
        },
        receipts.whenRecording((tx, planned) =>
          receipts.record(tx, transcriptPlanReceiptWrite(planned))
        )
      );

      if (result.ok) {
        // The unlocked fast path answers a no-op plan without a transaction.
        if (!receipts.receipt) {
          await receipts.recordStandalone(
            transcriptPlanReceiptWrite(result.value)
          );
        }
        return successResponse(withOperationReceipt(result.value, receipts));
      }
      return transcriptErrorResponse(result.error);
    }
  )
);
