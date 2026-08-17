import {
  DesktopAgentSessionsAckReason,
  DesktopAgentSessionsSyncErrorCode,
  type DesktopAgentSessionsSyncResponse,
} from "@repo/api/src/types/agent-session";
import { DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES } from "@repo/api/src/types/agent-session-sync-limits";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import {
  rateLimitedResponse,
  readBoundedMaybeGzipJsonBody,
  requireComputeTargetId,
} from "../../route-helpers";
import { desktopAgentSessionsSyncService } from "./service";

/**
 * FEA-3425: explicit function ceiling for the bulk sync upsert. The desktop
 * client aborts at 30s (parity with the socket transport's ack timeout), so the
 * function gets headroom above that: a slow-but-successful upsert commits
 * server-side and the client's retry lands on the idempotent upsert, instead of
 * the platform default killing the transaction mid-flight with a non-JSON
 * response the client cannot taxonomize.
 */
export const maxDuration = 60;

/**
 * Targeted desktop session sync over the same API-key channel used by
 * local-first trace comments. This lets a desktop comment create the cloud
 * parent SESSION artifact before uploading the comment without waiting behind
 * the bulk relay backfill queue.
 */
export const POST = withAnyAuth<
  DesktopAgentSessionsSyncResponse,
  "/desktop/agent-sessions/sync"
>(async ({ user, clerkUserId }, request) => {
  const { computeTargetId, response: targetResponse } =
    requireComputeTargetId(request);
  if (targetResponse) {
    return targetResponse;
  }

  const { rawBody, response } = await readBoundedMaybeGzipJsonBody(
    request,
    DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES
  );
  if (response) {
    return response;
  }

  try {
    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId,
      computeTargetId,
      organizationId: user.organizationId,
      rawBody,
      userId: user.id,
    });

    if (result.ok) {
      return successResponse(result.value);
    }
    if (
      result.error.reason === Status.BadRequest ||
      result.error.reason === DesktopAgentSessionsAckReason.ValidationFailed
    ) {
      return badRequestResponse("Invalid agent-session sync payload", {
        code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
        // ISS-5090: hand back the stable, value-free field/path summary so the
        // desktop can log WHY the payload was rejected. Additive and optional —
        // omitted (never `null`) when the failure carried none, so an older
        // client that ignores `details` is unaffected.
        ...(result.error.detail
          ? { details: { reason: result.error.detail } }
          : {}),
      });
    }
    // FEA-3425: `Status.Forbidden` (compute target not owned by this
    // org/user) and `FeatureDisabled` (org sync capability off) must be
    // distinguishable — the desktop backs off on a disabled capability but
    // must re-resolve its identity on an ownership rejection, since waiting
    // never fixes a wrong computeTargetId.
    if (result.error.reason === Status.Forbidden) {
      return forbiddenResponse({
        code: DesktopAgentSessionsSyncErrorCode.TargetNotOwned,
      });
    }
    if (result.error.reason === DesktopAgentSessionsAckReason.FeatureDisabled) {
      return forbiddenResponse({
        code: DesktopAgentSessionsSyncErrorCode.FeatureDisabled,
      });
    }
    if (result.error.reason === DesktopAgentSessionsAckReason.RateLimited) {
      return rateLimitedResponse(DesktopAgentSessionsSyncErrorCode.RateLimited);
    }
    return errorResponse(
      "Failed to sync agent session",
      result.error.reason,
      500,
      { code: DesktopAgentSessionsSyncErrorCode.IngestionFailed }
    );
  } catch (error) {
    return errorResponse("Failed to sync agent session", error, 500, {
      code: DesktopAgentSessionsSyncErrorCode.InternalError,
    });
  }
});
