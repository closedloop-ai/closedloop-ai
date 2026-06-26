import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";

import {
  DesktopUpdaterRateLimitError,
  DesktopUpdaterRateLimitErrorCode,
  type DesktopUpdaterRateLimitRejection,
} from "./updater-abuse-control";

export function desktopUpdaterRateLimitResponse(
  rejection: DesktopUpdaterRateLimitRejection
): NextResponse {
  return NextResponse.json(
    failure(DesktopUpdaterRateLimitError, {
      code: DesktopUpdaterRateLimitErrorCode.RateLimited,
      details: {
        retryAfterSeconds: rejection.retryAfterSeconds,
        limit: rejection.limit,
        windowSeconds: rejection.windowSeconds,
        route: rejection.route,
      },
    }),
    {
      status: 429,
      headers: {
        "Retry-After": String(rejection.retryAfterSeconds),
      },
    }
  );
}
