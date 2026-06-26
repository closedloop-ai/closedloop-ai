import { getLatestElectronUpdaterFeed } from "@repo/github/electron-release";
import { NextResponse } from "next/server";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import {
  consumeDesktopUpdaterRateLimit,
  DesktopUpdaterRateLimitRoute,
} from "../updater-abuse-control";
import { desktopUpdaterRateLimitResponse } from "../updater-rate-limit-response";

export async function GET(request: Request): Promise<Response> {
  const rateLimit = consumeDesktopUpdaterRateLimit(request, {
    route: DesktopUpdaterRateLimitRoute.Feed,
  });
  if (!rateLimit.allowed) {
    return desktopUpdaterRateLimitResponse(rateLimit);
  }

  try {
    const feedText = await getLatestElectronUpdaterFeed();
    if (feedText === null) {
      return notFoundResponse("Desktop updater feed");
    }

    return new NextResponse(feedText, {
      status: 200,
      headers: {
        "Cache-Control": DesktopUpdaterFeedCacheControl,
        "Content-Type": "application/x-yaml; charset=utf-8",
      },
    });
  } catch (error) {
    return errorResponse("Failed to fetch Desktop updater feed", error);
  }
}

export const DesktopUpdaterFeedCacheControl =
  "public, s-maxage=60, stale-while-revalidate=300";
