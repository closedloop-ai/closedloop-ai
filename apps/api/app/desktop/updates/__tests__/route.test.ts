import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getElectronUpdaterAssetRedirectUrl: vi.fn(),
  getLatestElectronUpdaterFeed: vi.fn(),
  logError: vi.fn(),
  logFlush: vi.fn(() => Promise.resolve()),
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
    error: mocks.logError,
    flush: mocks.logFlush,
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

  it("redirects the current ZIP to the helper-provided signed URL", async () => {
    mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
      SIGNED_REDIRECT_URL
    );

    const response = await assetGET(
      request(`/desktop/updates/${ZIP_ASSET}`),
      routeContext(ZIP_ASSET)
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED_REDIRECT_URL);
    expect(mocks.getElectronUpdaterAssetRedirectUrl).toHaveBeenCalledWith(
      ZIP_ASSET
    );
  });

  it.each([
    ["unknown", "notes.txt"],
    ["blockmap", `${ZIP_ASSET}.blockmap`],
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
      STALE_ZIP_ASSET
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
