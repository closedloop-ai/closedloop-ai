import { DesktopReleaseAssetChannels } from "@repo/api/src/types/desktop-release";
import {
  getDesktopReleaseUpdaterZipAssetNameForAsset,
  isDesktopReleaseUpdaterBlockmapAssetName,
} from "@repo/api/src/types/desktop-release-blockmap";
import { isDesktopReleaseLinuxUpdaterAssetName } from "@repo/api/src/types/desktop-release-linux";
import { getElectronUpdaterAssetRedirectUrl } from "@repo/github/electron-release";
import { NextResponse } from "next/server";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import {
  consumeDesktopUpdaterRateLimit,
  DesktopUpdaterRateLimitRoute,
} from "../updater-abuse-control";
import { desktopUpdaterRateLimitResponse } from "../updater-rate-limit-response";
import {
  DesktopUpdaterPerInstallCacheControl,
  desktopUpdaterRingHeaders,
  desktopUpdaterRingService,
} from "../updater-ring-service";

type DesktopUpdaterAssetRouteContext = {
  params: Promise<{ assetName?: string }>;
};

async function handleGet(
  request: Request,
  context: DesktopUpdaterAssetRouteContext
): Promise<Response> {
  const { assetName } = await context.params;
  if (
    !(
      assetName &&
      (getDesktopReleaseUpdaterZipAssetNameForAsset(assetName) ||
        isDesktopReleaseLinuxUpdaterAssetName(assetName))
    )
  ) {
    return notFoundResponse("Desktop updater asset");
  }

  const rateLimit = consumeDesktopUpdaterRateLimit(request, {
    route: DesktopUpdaterRateLimitRoute.Asset,
    assetName,
  });
  if (!rateLimit.allowed) {
    return desktopUpdaterRateLimitResponse(rateLimit);
  }

  const ring = await desktopUpdaterRingService.resolveRing(request);

  try {
    // NOT the ring's channel list, deliberately: the desktop strips the
    // compute-target id before this request is sent, so `ring` here is always
    // `general` and ringing this leg 404s the internal ring's own candidate
    // download. `DesktopReleaseAssetChannels` owns why, and the feed leg is what
    // keeps a candidate off a customer's machine.
    const redirectUrl = await getElectronUpdaterAssetRedirectUrl(
      assetName,
      DesktopReleaseAssetChannels
    );
    if (redirectUrl === null) {
      return notFoundResponse("Desktop updater asset");
    }

    return NextResponse.redirect(redirectUrl, {
      status: 302,
      headers: {
        // Only the per-install answer gains a Cache-Control it did not have; an
        // unattributed request keeps today's headers so an older build is
        // unaffected.
        ...(ring.perInstall && {
          "Cache-Control": DesktopUpdaterPerInstallCacheControl,
        }),
        ...desktopUpdaterRingHeaders(ring),
      },
    });
  } catch (error) {
    // ISS-10424: electron-updater answers ANY failed blockmap fetch by falling
    // back to a full download, so a blockmap it cannot have is a 404, never a
    // 5xx. The failure is not hidden: the release selector logged it before
    // rethrowing, and the ZIP request that follows still 5xxes if GitHub is down.
    if (isDesktopReleaseUpdaterBlockmapAssetName(assetName)) {
      return notFoundResponse("Desktop updater asset");
    }
    return errorResponse("Failed to resolve Desktop updater asset", error);
  }
}

export const GET = withRequestCompleted(handleGet);
