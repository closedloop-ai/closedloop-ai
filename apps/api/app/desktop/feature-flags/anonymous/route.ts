import { DESKTOP_FEATURE_FLAGS_NODE_UUID_HEADER } from "@repo/api/src/types/desktop-feature-flags";
import {
  DesktopWriteLaneRejectReason,
  DesktopWriteLaneRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { isUuidV4 } from "@repo/api/src/types/onboarding-analytics";
import { consumeDesktopAnalyticsPreAuthBudget } from "@/lib/desktop-analytics-handler";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { rateLimitedResponse } from "../../route-helpers";
import { desktopFeatureFlagsService } from "../service";

export const GET = withRequestCompleted(async (request: Request) => {
  const nodeUuid = request.headers.get(DESKTOP_FEATURE_FLAGS_NODE_UUID_HEADER);
  if (!isUuidV4(nodeUuid)) {
    return badRequestResponse("Invalid desktop node uuid", {
      code: DesktopWriteLaneRestErrorCode.ValidationFailed,
    });
  }
  if (!consumeDesktopAnalyticsPreAuthBudget(nodeUuid)) {
    return rateLimitedResponse(
      DesktopWriteLaneRejectReason.RateLimited,
      FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
    );
  }
  try {
    return successResponse(
      await desktopFeatureFlagsService.getAnonymous(nodeUuid)
    );
  } catch (error) {
    return errorResponse("Failed to resolve desktop feature flags", error);
  }
});
