import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { TranscriptForbiddenCode } from "@repo/api/src/types/desktop-transcripts";
import { NextResponse } from "next/server";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import {
  badRequestResponse,
  conflictResponse,
  forbiddenResponse,
} from "@/lib/route-utils";
import { TranscriptSyncErrorReason } from "./transcript-sync-error-reason";

/**
 * ISS-7097: how long the desktop is asked to wait out a lane-wide outage.
 *
 * PRD-699 Appendix A / ISS-8689 F7: the desktop now READS this header rather
 * than ignoring it, and honors it as a MINIMUM. Its own staged schedule opens
 * at five minutes, so a value this short does not shorten anything — it is the
 * floor under which the desktop already refuses to retry. Its job is to keep a
 * transient outage OFF the long configuration stand-down below.
 */
const UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

/**
 * ISS-8689 / PRD-699 Appendix A: `TRANSCRIPTS_BUCKET` is unset. Only an admin
 * changing configuration fixes this, so the desktop is told to wait an hour
 * rather than retry on the transient-outage cadence above.
 */
const UPSTREAM_NOT_CONFIGURED_RETRY_AFTER_SECONDS = 3600;

/**
 * Map a transcript service failure to its HTTP response. `StaleUpload` is a 409
 * so the desktop knows to re-plan next cycle (the stored state is unchanged).
 *
 * ISS-7097: the 4xx/5xx split here is load-bearing, not cosmetic. The desktop
 * classifies lane-wide failures BY STATUS CODE and refuses to spend per-row
 * retry budget on them, so a reason that means "the cloud is down" must never be
 * answered with a 4xx. Additive and skew-safe in the other direction too: a
 * Desktop build predating that classification treats every non-2xx identically,
 * so a 503 gets exactly the behaviour a 409 used to.
 *
 * ISS-8599: the STATUS is no longer the only discriminator, for 403 alone. Both
 * 403 reasons keep status 403 — a change there would break every installed
 * client at once — and carry a machine-readable `TranscriptForbiddenCode` in the
 * failure envelope instead, which is purely additive: the desktop reads the body
 * for this one status, an older desktop never looks, and an older server never
 * sends. Cloud deploys first (`sync/AGENTS.md`, the skew rule); nothing here may
 * assume a coded client exists.
 */
export function transcriptErrorResponse(
  reason: TranscriptSyncErrorReason
): NextResponse<ApiResult<never>> {
  // biome-ignore lint/style/useDefaultSwitchClause: the closed reason union is exhaustive; a default would hide contract growth.
  switch (reason) {
    case TranscriptSyncErrorReason.Forbidden:
      return forbiddenResponse({ code: TranscriptForbiddenCode.NotOwned });
    case TranscriptSyncErrorReason.RateLimited:
      return NextResponse.json(failure("Rate limited"), {
        status: 429,
        headers: {
          "Retry-After": String(FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS),
        },
      });
    case TranscriptSyncErrorReason.InvalidRequest:
      return badRequestResponse("Invalid transcript sync request");
    case TranscriptSyncErrorReason.StaleUpload:
      return conflictResponse("Transcript upload is stale; re-plan required");
    case TranscriptSyncErrorReason.UpstreamUnavailable:
      return NextResponse.json(failure("Transcript service unavailable"), {
        status: 503,
        headers: {
          "Retry-After": String(UPSTREAM_UNAVAILABLE_RETRY_AFTER_SECONDS),
        },
      });
    case TranscriptSyncErrorReason.UpstreamNotConfigured:
      return NextResponse.json(failure("Transcript service unavailable"), {
        status: 503,
        headers: {
          "Retry-After": String(UPSTREAM_NOT_CONFIGURED_RETRY_AFTER_SECONDS),
        },
      });
  }
}
