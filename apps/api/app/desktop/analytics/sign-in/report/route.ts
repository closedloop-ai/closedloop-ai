import { DesktopAnalyticsRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { auth } from "@repo/auth/server";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/route-utils";
import {
  rateLimitedResponse,
  readBoundedJsonBody,
} from "../../../route-helpers";
import { reportLimiter } from "../rate-limit";
import { signInAnalyticsReportSchema } from "../schema";
import { desktopSignInAnalyticsService } from "../service";

export const POST = withRequestCompleted(async (request: Request) => {
  // Clerk session only, including a newly created user with no organization (4a).
  try {
    const session = await auth();
    if (!(session.userId && session.sessionId)) {
      return unauthorizedResponse();
    }
    if (!reportLimiter.attempt(session.userId, Date.now())) {
      return rateLimitedResponse(
        DesktopAnalyticsRestErrorCode.RateLimited,
        FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS
      );
    }
    const { rawBody, response } = await readBoundedJsonBody(request, 1024);
    if (response) {
      return response;
    }
    const parsed = signInAnalyticsReportSchema.safeParse(rawBody);
    if (!parsed.success) {
      return badRequestResponse("Invalid desktop analytics payload");
    }
    await desktopSignInAnalyticsService.report(
      parsed.data.codeChallenge,
      session.userId
    );
    return successResponse({ accepted: true });
  } catch {
    return unauthorizedResponse();
  }
});
