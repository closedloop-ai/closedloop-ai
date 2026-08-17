import {
  DesktopAnalyticsAckReason,
  type DesktopAnalyticsCaptureResponse,
} from "@repo/api/src/types/desktop-analytics";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopAnalyticsRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
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
  readBoundedJsonBody,
  requireComputeTargetId,
} from "../route-helpers";
import { desktopAnalyticsService } from "./service";

/**
 * Generous ceiling over the server-side property cap
 * (`DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES` = 8 KiB) plus event name and
 * envelope passthrough fields — anything larger is not a well-formed event.
 */
const DESKTOP_ANALYTICS_REQUEST_MAX_BYTES = 32_768;

/**
 * FEA-3425: explicit function ceiling for the analytics capture. The path is
 * one compute-target ownership lookup, a feature-flag evaluation, and a
 * PostHog enqueue — 15s is generous headroom above the desktop client's 10s
 * abort, so a slow-but-successful capture commits server-side instead of the
 * platform default killing it with a non-JSON response.
 */
export const maxDuration = 15;

/**
 * FEA-3425 (PLN-1437 Phase 3): REST twin of the relay `desktop.analytics`
 * socket event, letting sessioned desktop installs deliver product analytics
 * over the authenticated HTTP write lane instead of the static-key relay
 * socket. Every non-2xx branch carries a machine-readable `code`
 * ({@link DesktopAnalyticsRestErrorCode}) because the desktop lane dispatches
 * on code + status, never status alone.
 */
export const POST = withAnyAuth<
  DesktopAnalyticsCaptureResponse,
  "/desktop/analytics"
>(async ({ user, clerkUserId }, request) => {
  const { computeTargetId, response: targetResponse } =
    requireComputeTargetId(request);
  if (targetResponse) {
    return targetResponse;
  }

  const { rawBody, response } = await readBoundedJsonBody(
    request,
    DESKTOP_ANALYTICS_REQUEST_MAX_BYTES
  );
  if (response) {
    return response;
  }

  try {
    const result = await desktopAnalyticsService.capture({
      clerkUserId,
      computeTargetId,
      organizationId: user.organizationId,
      pluginVersion:
        request.headers.get(DESKTOP_PLUGIN_VERSION_HEADER) ?? undefined,
      rawBody,
      userId: user.id,
    });

    if (result.ok) {
      return successResponse(result.value);
    }
    if (result.error === DesktopAnalyticsAckReason.ValidationFailed) {
      return badRequestResponse("Invalid desktop analytics payload", {
        code: DesktopAnalyticsRestErrorCode.ValidationFailed,
      });
    }
    // `Status.Forbidden` (target not owned) and `FeatureDisabled` (org
    // capability off) must stay distinguishable — the desktop latches and
    // stops for the session on a disabled capability but treats an ownership
    // rejection as a wrong/stale computeTargetId.
    if (result.error === Status.Forbidden) {
      return forbiddenResponse({
        code: DesktopAnalyticsRestErrorCode.TargetNotOwned,
      });
    }
    if (result.error === DesktopAnalyticsAckReason.FeatureDisabled) {
      return forbiddenResponse({
        code: DesktopAnalyticsRestErrorCode.FeatureDisabled,
      });
    }
    if (result.error === DesktopAnalyticsAckReason.RateLimited) {
      return rateLimitedResponse(DesktopAnalyticsRestErrorCode.RateLimited);
    }
    return errorResponse(
      "Failed to capture desktop analytics",
      result.error,
      500,
      {
        code: DesktopAnalyticsRestErrorCode.CaptureFailed,
      }
    );
  } catch (error) {
    return errorResponse("Failed to capture desktop analytics", error, 500, {
      code: DesktopAnalyticsRestErrorCode.InternalError,
    });
  }
});
