import {
  type TranscriptSyncPlanResponse,
  transcriptSyncPlanRequestSchema,
} from "@repo/api/src/types/desktop-transcripts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseBody, successResponse } from "@/lib/route-utils";
import { transcriptSyncService } from "../service";
import { transcriptErrorResponse } from "../transcript-route-helpers";

/** Max control-plane request body — fingerprints + checksums only, no bytes. */
const TRANSCRIPT_SYNC_PLAN_MAX_BYTES = 8192;

/**
 * POST /desktop/transcripts/sync-plan — decide the upload shape (noop / fullPut
 * / multipart) for one transcript file and mint presigned URLs. Desktop session
 * JWT (or API key) via withAnyAuth; ownership + rate limiting in the service.
 * Ships dark until the desktop client (FEA-2715) calls it.
 */
export const POST = withAnyAuth<
  TranscriptSyncPlanResponse,
  "/desktop/transcripts/sync-plan"
>(async ({ user, clerkUserId }, request) => {
  const { body, errorResponse: bodyError } = await parseBody(
    request,
    transcriptSyncPlanRequestSchema,
    { maxBytes: TRANSCRIPT_SYNC_PLAN_MAX_BYTES }
  );
  if (bodyError) {
    return bodyError;
  }

  const result = await transcriptSyncService.planSync({
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
