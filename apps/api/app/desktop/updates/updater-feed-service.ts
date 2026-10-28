import {
  DesktopReleaseUpdaterMetadataAssetName,
  desktopReleaseChannelsForRing,
} from "@repo/api/src/types/desktop-release";
import {
  type DesktopUpdaterMetadataAssetName,
  getLatestElectronUpdaterFeed,
} from "@repo/github/electron-release";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import {
  consumeDesktopUpdaterRateLimit,
  DesktopUpdaterRateLimitRoute,
} from "./updater-abuse-control";
import { desktopUpdaterRateLimitResponse } from "./updater-rate-limit-response";
import {
  DesktopUpdaterPerInstallCacheControl,
  type DesktopUpdaterRingResolution,
  desktopUpdaterRingHeaders,
  desktopUpdaterRingService,
} from "./updater-ring-service";

export async function getDesktopUpdaterFeed(
  request: Request,
  metadataAssetName: DesktopUpdaterMetadataAssetName = DesktopReleaseUpdaterMetadataAssetName
): Promise<Response> {
  const rateLimit = consumeDesktopUpdaterRateLimit(request, {
    route: DesktopUpdaterRateLimitRoute.Feed,
  });
  if (!rateLimit.allowed) {
    return desktopUpdaterRateLimitResponse(rateLimit);
  }

  // Resolved BEFORE the feed is fetched, not concurrently with it: the ring
  // decides which channel's feed to fetch (ISS-9165).
  const ring = await desktopUpdaterRingService.resolveRing(request);

  // OUTSIDE the try, so a logging failure can never turn a served feed into a
  // 500, and the ring is recorded even when the feed lookup then fails.
  //
  // Debug, not info: every install polls this every five minutes, and
  // `apps/api/AGENTS.md` reserves info for events needing operator attention.
  // The facet, added in ISS-9164 a release cycle before the ring selected
  // anything, is now how the CHANNEL a poll was served is observable at all —
  // the response body does not say which one it came from.
  // `perInstall` rides along because without it this facet cannot answer the one
  // question D0 exists to answer. `general` is the answer to five different
  // upstream truths — no header, malformed header, unknown id, a customer
  // organisation, and a failed lookup — so a run in which the desktop never
  // stamps the header at all reads identically to one where stamping works
  // perfectly and nobody is allow-listed yet. Neither value names an install or
  // a tenant, so the no-id rule below is untouched.
  log.debug("[desktop/updates] Resolved updater feed ring", {
    ring: ring.ring,
    perInstall: ring.perInstall,
  });

  try {
    const channels = desktopReleaseChannelsForRing(ring.ring);
    const feedText =
      metadataAssetName === DesktopReleaseUpdaterMetadataAssetName
        ? await getLatestElectronUpdaterFeed(channels)
        : await getLatestElectronUpdaterFeed(channels, metadataAssetName);
    if (feedText === null) {
      return notFoundResponse("Desktop updater feed");
    }

    return new NextResponse(feedText, {
      status: 200,
      headers: {
        "Cache-Control": desktopUpdaterFeedCacheControl(ring),
        "Content-Type": "application/x-yaml; charset=utf-8",
        ...desktopUpdaterRingHeaders(ring),
      },
    });
  } catch (error) {
    return errorResponse("Failed to fetch Desktop updater feed", error);
  }
}

export const DesktopUpdaterFeedCacheControl =
  "public, s-maxage=60, stale-while-revalidate=300";

/**
 * A per-install answer is `private`; an unattributed one keeps the shared-cache
 * policy it has today, so an installed build predating ISS-9164 sees byte-for-byte
 * the response it sees now.
 */
function desktopUpdaterFeedCacheControl(
  resolution: DesktopUpdaterRingResolution
): string {
  return resolution.perInstall
    ? DesktopUpdaterPerInstallCacheControl
    : DesktopUpdaterFeedCacheControl;
}
