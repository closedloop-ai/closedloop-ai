import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-9165: the asset leg is resolved against both mutable channels, promoted
// first, whatever the ring — the desktop strips the compute-target id before the
// ZIP request, so there is no ring here to honour. Written out rather than
// imported so a channel rename has to be acknowledged here.
const ASSET_CHANNELS = ["desktop-latest", "desktop-candidate"];

const mocks = vi.hoisted(() => ({
  getElectronUpdaterAssetRedirectUrl: vi.fn(),
  getLatestElectronUpdaterFeed: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logFlush: vi.fn(() => Promise.resolve()),
  logWarn: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@repo/github/electron-release", () => ({
  getElectronUpdaterAssetRedirectUrl: mocks.getElectronUpdaterAssetRedirectUrl,
  getLatestElectronUpdaterFeed: mocks.getLatestElectronUpdaterFeed,
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: mocks.logDebug,
    error: mocks.logError,
    flush: mocks.logFlush,
    info: mocks.logInfo,
    warn: mocks.logWarn,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: () => {
    throw new Error("Desktop updater routes must not use withAnyAuth");
  },
}));

import { REQUEST_COMPLETED_EVENT } from "@/lib/route-utils";
import { GET as assetGET } from "../[assetName]/route";
import {
  DesktopUpdaterFeedCacheControl,
  GET as feedGET,
} from "../latest-mac.yml/route";
import {
  DesktopUpdaterRateLimitError,
  DesktopUpdaterRateLimitErrorCode,
  DesktopUpdaterRateLimitLimit,
  DesktopUpdaterRateLimitMaxEntries,
  DesktopUpdaterRateLimitRoute,
  type DesktopUpdaterRateLimitRoute as DesktopUpdaterRateLimitRouteValue,
  DesktopUpdaterRateLimitWindowSeconds,
  resetDesktopUpdaterRateLimiterForTests,
  setDesktopUpdaterRateLimiterNowForTests,
} from "../updater-abuse-control";

const VERSION = "0.15.115";
const ZIP_ASSET = `Closedloop-${VERSION}-universal-mac.zip`;
const STALE_ZIP_ASSET = "Closedloop-0.15.114-universal-mac.zip";
const DMG_ASSET = `Closedloop-${VERSION}-universal.dmg`;
const FEED_TEXT = `version: ${VERSION}\nfiles:\n  - url: ${ZIP_ASSET}\n    sha512: abc\n    size: 123\npath: ${ZIP_ASSET}\nsha512: abc\nreleaseDate: "2026-06-16T00:00:00.000Z"\n`;
const SIGNED_REDIRECT_URL =
  "https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345?X-Amz-Signature=abc";
const FIXED_NOW = 1_893_456_000_000;
const FEED_PATH_WITH_NO_CACHE =
  "/desktop/updates/latest-mac.yml?noCache=1k3o4ea6j";
const ALLOWED_FEED_CONTENT_TYPE_REGEX =
  /^(application\/x-yaml|text\/yaml|text\/plain)(;.*)?$/;

describe("GET /desktop/updates/latest-mac.yml", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetDesktopUpdaterRateLimiterForTests();
  });

  it("returns the exact latest-mac.yml body with an allowed content type", async () => {
    mocks.getLatestElectronUpdaterFeed.mockResolvedValue(FEED_TEXT);

    const response = await feedGET(request("/desktop/updates/latest-mac.yml"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(FEED_TEXT);
    expect(response.headers.get("content-type")).toMatch(
      ALLOWED_FEED_CONTENT_TYPE_REGEX
    );
    expect(response.headers.get("cache-control")).toBe(
      DesktopUpdaterFeedCacheControl
    );
    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the feed is missing", async () => {
    mocks.getLatestElectronUpdaterFeed.mockResolvedValue(null);

    const response = await feedGET(request("/desktop/updates/latest-mac.yml"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Desktop updater feed not found",
    });
  });

  it("maps helper rejection to the exact 500 envelope", async () => {
    mocks.getLatestElectronUpdaterFeed.mockRejectedValue(
      new Error("provider unavailable")
    );

    const response = await feedGET(request("/desktop/updates/latest-mac.yml"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to fetch Desktop updater feed",
    });
  });

  it("returns 429 before helper lookup after the feed client limit", async () => {
    setDesktopUpdaterRateLimiterNowForTests(() => FIXED_NOW);
    mocks.getLatestElectronUpdaterFeed.mockResolvedValue(FEED_TEXT);
    const clientRequest = request("/desktop/updates/latest-mac.yml", {
      "x-forwarded-for": "203.0.113.10",
    });

    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.FeedClient;
      index += 1
    ) {
      await feedGET(clientRequest);
    }

    const response = await feedGET(clientRequest);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(
      String(DesktopUpdaterRateLimitWindowSeconds)
    );
    await expect(response.json()).resolves.toEqual(
      expectedRateLimitBody({
        limit: DesktopUpdaterRateLimitLimit.FeedClient,
        route: DesktopUpdaterRateLimitRoute.Feed,
      })
    );
    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledTimes(
      DesktopUpdaterRateLimitLimit.FeedClient
    );
  });

  it("returns 429 before helper lookup after the feed global limit", async () => {
    setDesktopUpdaterRateLimiterNowForTests(() => FIXED_NOW);
    mocks.getLatestElectronUpdaterFeed.mockResolvedValue(FEED_TEXT);

    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.GlobalFeed;
      index += 1
    ) {
      await feedGET(
        request("/desktop/updates/latest-mac.yml", {
          "x-forwarded-for": `feed-global-client-${index}`,
        })
      );
    }

    const response = await feedGET(
      request("/desktop/updates/latest-mac.yml", {
        "x-forwarded-for": "feed-global-overflow-client",
      })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(
      String(DesktopUpdaterRateLimitWindowSeconds)
    );
    await expect(response.json()).resolves.toEqual(
      expectedRateLimitBody({
        limit: DesktopUpdaterRateLimitLimit.GlobalFeed,
        route: DesktopUpdaterRateLimitRoute.Feed,
      })
    );
    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledTimes(
      DesktopUpdaterRateLimitLimit.GlobalFeed
    );
  });

  it("keeps the feed global cap active after high-cardinality client churn", async () => {
    setDesktopUpdaterRateLimiterNowForTests(() => FIXED_NOW);
    mocks.getLatestElectronUpdaterFeed.mockResolvedValue(FEED_TEXT);

    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.GlobalFeed;
      index += 1
    ) {
      await feedGET(
        request("/desktop/updates/latest-mac.yml", {
          "x-forwarded-for": `feed-churn-client-${index}`,
        })
      );
    }

    for (
      let index = 0;
      index <= DesktopUpdaterRateLimitMaxEntries;
      index += 1
    ) {
      const response = await feedGET(
        request("/desktop/updates/latest-mac.yml", {
          "x-forwarded-for": `feed-churn-overflow-client-${index}`,
        })
      );

      expect(response.status).toBe(429);
    }

    const response = await feedGET(
      request("/desktop/updates/latest-mac.yml", {
        "x-forwarded-for": "feed-churn-final-client",
      })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(
      String(DesktopUpdaterRateLimitWindowSeconds)
    );
    await expect(response.json()).resolves.toEqual(
      expectedRateLimitBody({
        limit: DesktopUpdaterRateLimitLimit.GlobalFeed,
        route: DesktopUpdaterRateLimitRoute.Feed,
      })
    );
    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledTimes(
      DesktopUpdaterRateLimitLimit.GlobalFeed
    );
  });
});

describe("GET /desktop/updates/[assetName]", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetDesktopUpdaterRateLimiterForTests();
  });

  it.each([
    ["current ZIP", ZIP_ASSET],
    ["stale-but-valid ZIP", STALE_ZIP_ASSET],
    // ISS-10424: the updater ZIP's blockmap now reaches the helper too.
    ["current ZIP's blockmap", `${ZIP_ASSET}.blockmap`],
  ])(
    "redirects the %s when the helper resolves it",
    async (_name, assetName) => {
      mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
        SIGNED_REDIRECT_URL
      );

      const response = await assetGET(
        request(`/desktop/updates/${assetName}`),
        routeContext(assetName)
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(SIGNED_REDIRECT_URL);
      expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledWith(
        assetName,
        ASSET_CHANNELS
      );
    }
  );

  it.each([
    ["unknown", "notes.txt"],
    ["DMG blockmap", `${DMG_ASSET}.blockmap`],
    ["arbitrary blockmap", "notes.txt.blockmap"],
    ["DMG", DMG_ASSET],
    ["metadata", "desktop-release.json"],
    ["feed", "latest-mac.yml"],
    ["traversal", `../${ZIP_ASSET}`],
    ["encoded separator", `Closedloop-%2F${VERSION}-universal-mac.zip`],
  ])("returns 404 for %s before helper lookup", async (_name, assetName) => {
    const response = await assetGET(
      request(`/desktop/updates/${encodeURIComponent(assetName)}`),
      routeContext(assetName)
    );

    expect(response.status).toBe(404);
    expect(mocks.getElectronUpdaterAssetRedirectUrl).not.toHaveBeenCalled();
  });

  it("returns 404 for a stale semver ZIP when the helper returns null", async () => {
    mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(null);

    const response = await assetGET(
      request(`/desktop/updates/${STALE_ZIP_ASSET}`),
      routeContext(STALE_ZIP_ASSET)
    );

    expect(response.status).toBe(404);
    expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledWith(
      STALE_ZIP_ASSET,
      ASSET_CHANNELS
    );
  });

  it("maps helper rejection to the exact 500 envelope", async () => {
    mocks.getElectronUpdaterAssetRedirectUrl.mockRejectedValue(
      new Error("redirect unavailable")
    );

    const response = await assetGET(
      request(`/desktop/updates/${ZIP_ASSET}`),
      routeContext(ZIP_ASSET)
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Failed to resolve Desktop updater asset",
    });
  });

  it("returns 429 before helper lookup after the asset client/resource limit", async () => {
    setDesktopUpdaterRateLimiterNowForTests(() => FIXED_NOW);
    mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
      SIGNED_REDIRECT_URL
    );
    const clientRequest = request(`/desktop/updates/${ZIP_ASSET}`, {
      "x-forwarded-for": "203.0.113.20",
    });
    const context = routeContext(ZIP_ASSET);

    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.AssetClientResource;
      index += 1
    ) {
      await assetGET(clientRequest, context);
    }

    const response = await assetGET(clientRequest, context);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(
      String(DesktopUpdaterRateLimitWindowSeconds)
    );
    await expect(response.json()).resolves.toEqual(
      expectedRateLimitBody({
        limit: DesktopUpdaterRateLimitLimit.AssetClientResource,
        route: DesktopUpdaterRateLimitRoute.Asset,
      })
    );
    expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledTimes(
      DesktopUpdaterRateLimitLimit.AssetClientResource
    );
  });

  it("returns 429 before helper lookup after the asset global limit", async () => {
    setDesktopUpdaterRateLimiterNowForTests(() => FIXED_NOW);
    mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
      SIGNED_REDIRECT_URL
    );

    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.GlobalAsset;
      index += 1
    ) {
      const assetName = globalLimitZipAssetName(index);
      await assetGET(
        request(`/desktop/updates/${assetName}`, {
          "x-forwarded-for": `asset-global-client-${index}`,
        }),
        routeContext(assetName)
      );
    }

    const overflowAssetName = globalLimitZipAssetName(
      DesktopUpdaterRateLimitLimit.GlobalAsset
    );
    const response = await assetGET(
      request(`/desktop/updates/${overflowAssetName}`, {
        "x-forwarded-for": "asset-global-overflow-client",
      }),
      routeContext(overflowAssetName)
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(
      String(DesktopUpdaterRateLimitWindowSeconds)
    );
    await expect(response.json()).resolves.toEqual(
      expectedRateLimitBody({
        limit: DesktopUpdaterRateLimitLimit.GlobalAsset,
        route: DesktopUpdaterRateLimitRoute.Asset,
      })
    );
    expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledTimes(
      DesktopUpdaterRateLimitLimit.GlobalAsset
    );
  });

  it("keeps the asset global cap active after high-cardinality resource churn", async () => {
    setDesktopUpdaterRateLimiterNowForTests(() => FIXED_NOW);
    mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
      SIGNED_REDIRECT_URL
    );

    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.GlobalAsset;
      index += 1
    ) {
      const assetName = globalLimitZipAssetName(index);
      await assetGET(
        request(`/desktop/updates/${assetName}`, {
          "x-forwarded-for": `asset-churn-client-${index}`,
        }),
        routeContext(assetName)
      );
    }

    for (
      let index = 0;
      index <= DesktopUpdaterRateLimitMaxEntries;
      index += 1
    ) {
      const assetName = globalLimitZipAssetName(
        DesktopUpdaterRateLimitLimit.GlobalAsset + index
      );
      const response = await assetGET(
        request(`/desktop/updates/${assetName}`, {
          "x-forwarded-for": `asset-churn-overflow-client-${index}`,
        }),
        routeContext(assetName)
      );

      expect(response.status).toBe(429);
    }

    const finalAssetName = globalLimitZipAssetName(
      DesktopUpdaterRateLimitLimit.GlobalAsset +
        DesktopUpdaterRateLimitMaxEntries +
        1
    );
    const response = await assetGET(
      request(`/desktop/updates/${finalAssetName}`, {
        "x-forwarded-for": "asset-churn-final-client",
      }),
      routeContext(finalAssetName)
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(
      String(DesktopUpdaterRateLimitWindowSeconds)
    );
    await expect(response.json()).resolves.toEqual(
      expectedRateLimitBody({
        limit: DesktopUpdaterRateLimitLimit.GlobalAsset,
        route: DesktopUpdaterRateLimitRoute.Asset,
      })
    );
    expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledTimes(
      DesktopUpdaterRateLimitLimit.GlobalAsset
    );
  });
});

// ISS-11448: 30 days of failing updater traffic left no server record, because
// these routes had no wrapper to emit `request_completed`. The field names are
// the ones the cl-api log metrics and monitors group on.
describe("desktop updater routes emit request_completed", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetDesktopUpdaterRateLimiterForTests();
  });

  it("records the feed with its status and duration", async () => {
    mocks.getLatestElectronUpdaterFeed.mockResolvedValue(FEED_TEXT);

    const response = await feedGET(request(FEED_PATH_WITH_NO_CACHE));

    expect(response.status).toBe(200);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      REQUEST_COMPLETED_EVENT,
      expect.objectContaining({
        path: "/desktop/updates/latest-mac.yml",
        method: "GET",
        status_code: 200,
        duration_ms: expect.any(Number),
      })
    );
  });

  it("records a failed feed at error level with its 500", async () => {
    mocks.getLatestElectronUpdaterFeed.mockRejectedValue(new Error("github"));

    const response = await feedGET(request(FEED_PATH_WITH_NO_CACHE));

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      REQUEST_COMPLETED_EVENT,
      expect.objectContaining({
        path: "/desktop/updates/latest-mac.yml",
        status_code: 500,
      })
    );
    expect(mocks.logInfo).not.toHaveBeenCalledWith(
      REQUEST_COMPLETED_EVENT,
      expect.anything()
    );
  });

  it("records the asset redirect, with the route params still reaching the handler", async () => {
    mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
      SIGNED_REDIRECT_URL
    );

    const response = await assetGET(
      request(`/desktop/updates/${ZIP_ASSET}`),
      routeContext(ZIP_ASSET)
    );

    expect(response.status).toBe(302);
    expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledWith(
      ZIP_ASSET,
      ASSET_CHANNELS
    );
    expect(mocks.logInfo).toHaveBeenCalledWith(
      REQUEST_COMPLETED_EVENT,
      expect.objectContaining({
        path: "/desktop/updates/:assetName",
        method: "GET",
        status_code: 302,
        duration_ms: expect.any(Number),
      })
    );
  });
});

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://api.closedloop.ai${path}`, {
    headers,
    method: "GET",
  });
}

function routeContext(assetName: string) {
  return {
    params: Promise.resolve({ assetName }),
  };
}

function expectedRateLimitBody(input: {
  limit: number;
  route: DesktopUpdaterRateLimitRouteValue;
}) {
  return {
    success: false,
    error: DesktopUpdaterRateLimitError,
    code: DesktopUpdaterRateLimitErrorCode.RateLimited,
    details: {
      retryAfterSeconds: DesktopUpdaterRateLimitWindowSeconds,
      limit: input.limit,
      windowSeconds: DesktopUpdaterRateLimitWindowSeconds,
      route: input.route,
    },
  };
}

function globalLimitZipAssetName(index: number): string {
  return `Closedloop-0.15.${1000 + index}-universal-mac.zip`;
}
