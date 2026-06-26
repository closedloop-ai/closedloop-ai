import { isDesktopReleaseUpdaterZipAssetName } from "@repo/api/src/types/desktop-release";
import { getElectronUpdaterAssetRedirectUrl } from "@repo/github/electron-release";
import { NextResponse } from "next/server";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import {
  consumeDesktopUpdaterRateLimit,
  DesktopUpdaterRateLimitRoute,
} from "../updater-abuse-control";
import { desktopUpdaterRateLimitResponse } from "../updater-rate-limit-response";

type DesktopUpdaterAssetRouteContext = {
  params: Promise<{ assetName?: string }>;
};

export async function GET(
  request: Request,
  context: DesktopUpdaterAssetRouteContext
): Promise<Response> {
  const { assetName } = await context.params;
  if (!(assetName && isDesktopReleaseUpdaterZipAssetName(assetName))) {
    return notFoundResponse("Desktop updater asset");
  }

  const rateLimit = consumeDesktopUpdaterRateLimit(request, {
    route: DesktopUpdaterRateLimitRoute.Asset,
    assetName,
  });
  if (!rateLimit.allowed) {
    return desktopUpdaterRateLimitResponse(rateLimit);
  }

  try {
    const redirectUrl = await getElectronUpdaterAssetRedirectUrl(assetName);
    if (redirectUrl === null) {
      return notFoundResponse("Desktop updater asset");
    }

    return NextResponse.redirect(redirectUrl, 302);
  } catch (error) {
    return errorResponse("Failed to resolve Desktop updater asset", error);
  }
}
