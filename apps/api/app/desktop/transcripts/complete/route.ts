import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  type TranscriptCompleteResponse,
  TranscriptUploadStatus,
  transcriptCompleteRequestSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { transcriptSearchIndexService } from "@/app/search/transcript-search-indexer";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { parseBody, successResponse } from "@/lib/route-utils";
import { transcriptSyncService } from "../service";
import { transcriptCompleteReceiptWrite } from "../transcript-complete-receipt";
import { transcriptErrorResponse } from "../transcript-route-helpers";

/** Max control-plane request body — identity + checksums only, no bytes. */
const TRANSCRIPT_COMPLETE_MAX_BYTES = 8192;

/**
 * POST /desktop/transcripts/complete — finalize a planned upload: complete the
 * multipart upload with the full-object CRC64NVME + If-Match guard, verify byte
 * size and checksum against S3, and advance the verified server state. Desktop
 * session JWT (or API key) via withAnyAuth; ownership + rate limiting in the
 * service. Ships dark until FEA-2715.
 */
export const POST = withAnyAuth<
  TranscriptCompleteResponse,
  "/desktop/transcripts/complete"
>(
  withOperationReceipts(
    OperationKind.DesktopSync,
    async ({ user, clerkUserId, authMethod }, request, _params, receipts) => {
      const { body, errorResponse: bodyError } = await parseBody(
        request,
        transcriptCompleteRequestSchema,
        { maxBytes: TRANSCRIPT_COMPLETE_MAX_BYTES }
      );
      if (bodyError) {
        return bodyError;
      }

      const result = await transcriptSyncService.complete(
        {
          request: body,
          organizationId: user.organizationId,
          userId: user.id,
          clerkUserId,
          authMethod,
        },
        receipts.whenRecording((tx, written) =>
          receipts.record(tx, transcriptCompleteReceiptWrite(written))
        )
      );

      if (result.ok) {
        // FEA-3930: on a verified upload, best-effort index the transcript CONTENT
        // into unified search — gated on the org's `searchIncludeTranscripts` and
        // scoped to the MAIN file inside the indexer. Fail-open via `waitUntil`; a
        // projection failure never affects the completed upload.
        if (result.value.status === TranscriptUploadStatus.Uploaded) {
          transcriptSearchIndexService.indexAfterCommit({
            organizationId: user.organizationId,
            computeTargetId: body.computeTargetId,
            externalSessionId: body.externalSessionId,
            fileKey: body.fileKey,
          });
        }
        return successResponse(withOperationReceipt(result.value, receipts));
      }
      return transcriptErrorResponse(result.error);
    }
  )
);
