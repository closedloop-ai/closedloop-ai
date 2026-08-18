import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import type { StatusCode } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  forbiddenResponse,
} from "@/lib/route-utils";
import { TranscriptSyncErrorReason } from "./service";

const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/**
 * Map a transcript service failure to its HTTP response. `StaleUpload` is a 409
 * so the desktop knows to re-plan next cycle (the stored state is unchanged).
 * The service returns only {@link TranscriptSyncErrorReason} values; the
 * `StatusCode` arm exists because the shared `Result` widens the error union.
 */
export function transcriptErrorResponse(
  reason: TranscriptSyncErrorReason | StatusCode
): NextResponse<ApiResult<never>> {
  switch (reason) {
    case TranscriptSyncErrorReason.Forbidden:
      return forbiddenResponse();
    // FEA-4169: org session-sync policy is OFF for this org — a denial (403),
    // not a client re-plan. Same 403 family as ownership `Forbidden`.
    case TranscriptSyncErrorReason.PolicyDisabled:
      return forbiddenResponse();
    case TranscriptSyncErrorReason.RateLimited:
      return NextResponse.json(failure("Rate limited"), {
        status: 429,
        headers: { "Retry-After": String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
      });
    case TranscriptSyncErrorReason.InvalidRequest:
      return badRequestResponse("Invalid transcript sync request");
    case TranscriptSyncErrorReason.StaleUpload:
      return conflictResponse("Transcript upload is stale; re-plan required");
    default:
      return errorResponse("Transcript sync failed", reason);
  }
}
