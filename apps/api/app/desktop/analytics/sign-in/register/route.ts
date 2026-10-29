import { DesktopAnalyticsRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { consumeDesktopAnalyticsPreAuthBudget } from "@/lib/desktop-analytics-handler";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { badRequestResponse, successResponse } from "@/lib/route-utils";
import {
  rateLimitedResponse,
  readBoundedJsonBody,
} from "../../../route-helpers";
import { registrationLimiter } from "../rate-limit";
import { signInAnalyticsRegistrationSchema } from "../schema";
import { desktopSignInAnalyticsService } from "../service";

export const POST = withRequestCompleted(async (request: Request) => {
  if (!registrationLimiter.attempt("registration", Date.now())) {
    return rateLimitedResponse(
      DesktopAnalyticsRestErrorCode.RateLimited,
      FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
    );
  }
  const { rawBody, response } = await readBoundedJsonBody(request, 1024);
  if (response) {
    return response;
  }
  const parsed = signInAnalyticsRegistrationSchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequestResponse("Invalid desktop analytics payload");
  }
  if (!consumeDesktopAnalyticsPreAuthBudget(parsed.data.flowId)) {
    return rateLimitedResponse(
      DesktopAnalyticsRestErrorCode.RateLimited,
      FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
    );
  }
  await desktopSignInAnalyticsService.register(parsed.data);
  return successResponse({ accepted: true });
});
