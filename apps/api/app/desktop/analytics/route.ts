import {
  DesktopAnalyticsAckReason,
  type DesktopAnalyticsCaptureResponse,
} from "@repo/api/src/types/desktop-analytics";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopAnalyticsRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { Status } from "@repo/api/src/types/result";
import type { NextRequest } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { captureDesktopAnalytics } from "@/lib/desktop-analytics-capture";
import { handleDesktopAnalyticsPreAuthEvent } from "@/lib/desktop-analytics-handler";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
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
 * one compute-target ownership lookup and a PostHog enqueue (PRD-736 P1
 * retired the feature-flag evaluation) — 15s is generous headroom above the
 * desktop client's 10s
 * abort, so a slow-but-successful capture commits server-side instead of the
 * platform default killing it with a non-JSON response.
 */
export const maxDuration = 15;

/**
 * FEA-3425 (PLN-1437 Phase 3): sessioned desktop installs deliver product
 * analytics over the authenticated HTTP write lane; the relay
 * `desktop.analytics` socket event it replaced was retired in ISS-12735.
 * Every non-2xx branch carries a machine-readable `code`
 * ({@link DesktopAnalyticsRestErrorCode}) because the desktop lane dispatches
 * on code + status, never status alone.
 */
/**
 * ISS-10503 (PRD-736 D5): the pre-auth mode. A request with NO Authorization
 * header is an unauthenticated desktop install delivering pre-account or
 * single-player events under a client-supplied v4-UUID distinct id (the
 * envelope `distinctId`; the schema's shape check is the injection control).
 * A request that PRESENTS a credential — even an invalid one — never falls
 * through to this mode: it takes the authenticated branch and earns its 401,
 * so a rejected token can never demote a session to anonymous capture. No
 * compute-target ownership applies here (there is no target); the per-id
 * fixed-window budget and the route body cap still do, and the edge-WAF rule
 * (ISS-10504 P1) covers this mode by construction since it is the same path.
 */
async function preAuthPost(request: Request): Promise<Response> {
  const { rawBody, response } = await readBoundedJsonBody(
    request,
    DESKTOP_ANALYTICS_REQUEST_MAX_BYTES
  );
  if (response) {
    return response;
  }

  try {
    const ack = await handleDesktopAnalyticsPreAuthEvent(rawBody, {
      capture: captureDesktopAnalytics,
    });
    if (ack.accepted) {
      return successResponse({ captured: true });
    }
    if (ack.reason === DesktopAnalyticsAckReason.RateLimited) {
      return rateLimitedResponse(
        DesktopAnalyticsRestErrorCode.RateLimited,
        FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
      );
    }
    if (ack.reason === DesktopAnalyticsAckReason.ValidationFailed) {
      return badRequestResponse("Invalid desktop analytics payload", {
        code: DesktopAnalyticsRestErrorCode.ValidationFailed,
      });
    }
    return errorResponse(
      "Failed to capture desktop analytics",
      ack.reason,
      500,
      { code: DesktopAnalyticsRestErrorCode.CaptureFailed }
    );
  } catch (error) {
    return errorResponse("Failed to capture desktop analytics", error, 500, {
      code: DesktopAnalyticsRestErrorCode.InternalError,
    });
  }
}

const authenticatedPost = withAnyAuth<
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
    // PRD-736 P1: the `feature_disabled` 403 and `analytics_unavailable` 503
    // emissions went with the retired `desktop-server-analytics-relay` flag —
    // the handler no longer produces either reason. Their
    // `DesktopAnalyticsRestErrorCode` members stay one release for skewed
    // desktop builds that can still meet a pre-P1 API deployment.
    if (result.error === Status.Forbidden) {
      return forbiddenResponse({
        code: DesktopAnalyticsRestErrorCode.TargetNotOwned,
      });
    }
    if (result.error === DesktopAnalyticsAckReason.RateLimited) {
      return rateLimitedResponse(
        DesktopAnalyticsRestErrorCode.RateLimited,
        FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
      );
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

export function POST(
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
): Promise<Response> {
  // ISS-10503 (PRD-736 D5): mode selection is the PRESENCE of a credential,
  // never its validity — see the preAuthPost docstring. The desktop's
  // authenticated lane always sends a Bearer token; a browser Clerk-session
  // call without an Authorization header does not occur on this desktop-only
  // route.
  if (request.headers.get("authorization")) {
    return authenticatedPost(request, context);
  }
  return loggedPreAuthPost(request);
}

// ISS-11448: the authenticated branch emits `request_completed` through
// `withAnyAuth`; the pre-auth branch has no auth wrapper, so it gets its own.
const loggedPreAuthPost = withRequestCompleted(preAuthPost);
