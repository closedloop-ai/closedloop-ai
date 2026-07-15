import {
  type TranscriptCompleteResponse,
  transcriptCompleteRequestSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseBody, successResponse } from "@/lib/route-utils";
import { transcriptSyncService } from "../service";
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
>(async ({ user, clerkUserId }, request) => {
  const { body, errorResponse: bodyError } = await parseBody(
    request,
    transcriptCompleteRequestSchema,
    { maxBytes: TRANSCRIPT_COMPLETE_MAX_BYTES }
  );
  if (bodyError) {
    return bodyError;
  }

  const result = await transcriptSyncService.complete({
    request: body,
    organizationId: user.organizationId,
    userId: user.id,
    clerkUserId,
  });

  if (result.ok) {
    return successResponse(result.value);
  }
  return transcriptErrorResponse(result.error);
});
