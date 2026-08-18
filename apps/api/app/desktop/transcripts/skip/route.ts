import {
  type TranscriptSkipResponse,
  transcriptSkipRequestSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseBody, successResponse } from "@/lib/route-utils";
import { transcriptSyncService } from "../service";
import { transcriptErrorResponse } from "../transcript-route-helpers";

/** Max control-plane request body — identity + reason only, no bytes. */
const TRANSCRIPT_SKIP_MAX_BYTES = 8192;

/**
 * POST /desktop/transcripts/skip — record a terminal, non-retryable skip for one
 * transcript file (FEA-3476 / PRD-536 D7). The desktop calls this once when a
 * file transitions to a permanent dead state (e.g. it exceeds the local size
 * cap) so the cloud stops representing it as "syncing" and the read path derives
 * `failedPermanent`. Desktop session JWT (or API key) via withAnyAuth; ownership
 * + rate limiting in the service.
 */
export const POST = withAnyAuth<
  TranscriptSkipResponse,
  "/desktop/transcripts/skip"
>(async ({ user, clerkUserId }, request) => {
  const { body, errorResponse: bodyError } = await parseBody(
    request,
    transcriptSkipRequestSchema,
    { maxBytes: TRANSCRIPT_SKIP_MAX_BYTES }
  );
  if (bodyError) {
    return bodyError;
  }

  const result = await transcriptSyncService.markPermanentlySkipped({
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
