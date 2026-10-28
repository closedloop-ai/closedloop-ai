/**
 * ISS-9164 — the updater routes' ring behaviour, driven through the real
 * resolver.
 *
 * Only the database and the GitHub helper are doubled: the routes call the real
 * `desktopUpdaterRingService`, so this covers route → resolver → lookup as one
 * chain. Stubbing the resolver would have proved only that the routes copy a
 * value they were handed.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getElectronUpdaterAssetRedirectUrl: vi.fn(),
  getLatestElectronUpdaterFeed: vi.fn(),
  findUnique: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  env: {} as {
    DESKTOP_INTERNAL_RING_TARGETS?: string;
    DESKTOP_INTERNAL_RING_ORGANIZATIONS?: string;
  },
}));

vi.mock("@repo/github/electron-release", () => ({
  getElectronUpdaterAssetRedirectUrl: mocks.getElectronUpdaterAssetRedirectUrl,
  getLatestElectronUpdaterFeed: mocks.getLatestElectronUpdaterFeed,
}));

vi.mock("@repo/database", () => ({
  withDb: (
    fn: (db: {
      computeTarget: { findUnique: typeof mocks.findUnique };
    }) => unknown
  ) => fn({ computeTarget: { findUnique: mocks.findUnique } }),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: mocks.logDebug,
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    info: vi.fn(),
    warn: mocks.logWarn,
  },
}));

vi.mock("@/env", () => ({ env: mocks.env }));

import { GET as assetGET } from "../[assetName]/route";
import {
  DesktopUpdaterFeedCacheControl,
  GET as feedGET,
} from "../latest-mac.yml/route";
import {
  DesktopUpdaterRateLimitLimit,
  resetDesktopUpdaterRateLimiterForTests,
} from "../updater-abuse-control";
import { resetDesktopUpdaterRingCacheForTests } from "../updater-ring-service";

/**
 * The wire spellings and the exact cache policies, written out rather than read
 * off the modules under test. A rename or a policy edit has to fail here.
 */
const COMPUTE_TARGET_ID_HEADER = "x-desktop-compute-target-id";
const RING_HEADER = "x-desktop-ring";
const PER_INSTALL_CACHE_CONTROL = "private, max-age=60";
// Written out rather than imported: a channel rename must fail here, because
// these two strings are the whole of what separates the rings.
const CANDIDATE_CHANNEL = "desktop-candidate";
const PROMOTED_CHANNEL = "desktop-latest";
const SHARED_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

const COMPUTE_TARGET_ID = "01a06a86-56fa-7213-ae2d-3f5fe0932ec5";
const INTERNAL_ORGANIZATION_ID = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const CUSTOMER_ORGANIZATION_ID = "019c24db-ffff-7000-8000-ea275fb27470";
const VERSION = "0.15.115";
const ZIP_ASSET = `Closedloop-${VERSION}-universal-mac.zip`;
const FEED_TEXT = `version: ${VERSION}\npath: ${ZIP_ASSET}\n`;
const SIGNED_REDIRECT_URL =
  "https://objects.githubusercontent.com/github-production-release-asset/1?X-Amz-Signature=abc";

function feedRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    "https://api.closedloop.ai/desktop/updates/latest-mac.yml",
    { headers, method: "GET" }
  );
}

function assetRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    `https://api.closedloop.ai/desktop/updates/${ZIP_ASSET}`,
    { headers, method: "GET" }
  );
}

function assetContext() {
  return { params: Promise.resolve({ assetName: ZIP_ASSET }) };
}

function attributedHeaders(): Record<string, string> {
  return { [COMPUTE_TARGET_ID_HEADER]: COMPUTE_TARGET_ID };
}

beforeEach(() => {
  resetDesktopUpdaterRateLimiterForTests();
  resetDesktopUpdaterRingCacheForTests();
  mocks.getLatestElectronUpdaterFeed.mockResolvedValue(FEED_TEXT);
  mocks.getElectronUpdaterAssetRedirectUrl.mockResolvedValue(
    SIGNED_REDIRECT_URL
  );
  mocks.findUnique.mockResolvedValue({
    organizationId: CUSTOMER_ORGANIZATION_ID,
  });
  mocks.env.DESKTOP_INTERNAL_RING_TARGETS = undefined;
  mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopUpdaterRateLimiterForTests();
  resetDesktopUpdaterRingCacheForTests();
});

describe("GET /desktop/updates/latest-mac.yml ring answer", () => {
  it("answers a ringed request with the internal ring and a private cache policy", async () => {
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;
    mocks.findUnique.mockResolvedValue({
      organizationId: INTERNAL_ORGANIZATION_ID,
    });

    const response = await feedGET(feedRequest(attributedHeaders()));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(FEED_TEXT);
    expect(response.headers.get(RING_HEADER)).toBe("internal");
    expect(response.headers.get("cache-control")).toBe(
      PER_INSTALL_CACHE_CONTROL
    );
  });

  it("keeps a ringed general answer per-install rather than shared-cached", async () => {
    const response = await feedGET(feedRequest(attributedHeaders()));

    expect(response.headers.get(RING_HEADER)).toBe("general");
    expect(response.headers.get("cache-control")).toBe(
      PER_INSTALL_CACHE_CONTROL
    );
  });

  /**
   * The cross-repo case: a build that predates ISS-9164 sends no header, and its
   * response must be the one it gets today — shared-cache policy, no lookup.
   */
  it("leaves an unattributed request on the shared-cache policy, reading no row", async () => {
    const response = await feedGET(feedRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(SHARED_CACHE_CONTROL);
    expect(response.headers.get("cache-control")).toBe(
      DesktopUpdaterFeedCacheControl
    );
    expect(response.headers.get(RING_HEADER)).toBe("general");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("declares the compute-target header in Vary so a shared cache cannot cross rings", async () => {
    const response = await feedGET(feedRequest());

    expect(response.headers.get("vary")).toBe(COMPUTE_TARGET_ID_HEADER);
  });

  it("logs the resolved ring and whether the request was attributed", async () => {
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;
    mocks.findUnique.mockResolvedValue({
      organizationId: INTERNAL_ORGANIZATION_ID,
    });

    await feedGET(feedRequest(attributedHeaders()));

    expect(mocks.logDebug).toHaveBeenCalledWith(expect.any(String), {
      ring: "internal",
      perInstall: true,
    });
  });

  /**
   * The half that makes the facet answer D0's own question. Without
   * `perInstall`, a fleet that never stamps the header logs the same `general`
   * as one that stamps it perfectly while nobody is allow-listed — so the
   * unattributed case has to be pinned separately, not inferred.
   */
  it("distinguishes an unattributed general answer from an attributed one", async () => {
    await feedGET(feedRequest());
    await feedGET(feedRequest(attributedHeaders()));

    expect(mocks.logDebug.mock.calls.map((call) => call[1])).toEqual([
      { ring: "general", perInstall: false },
      { ring: "general", perInstall: true },
    ]);
  });

  it("never logs the attested id, on the lookup-failure path or the served path", async () => {
    mocks.findUnique.mockRejectedValue(new Error("pool exhausted"));

    const response = await feedGET(feedRequest(attributedHeaders()));

    expect(response.status).toBe(200);
    expect(response.headers.get(RING_HEADER)).toBe("general");
    const logged = JSON.stringify([
      ...mocks.logWarn.mock.calls,
      ...mocks.logDebug.mock.calls,
    ]);
    expect(logged).not.toContain(COMPUTE_TARGET_ID);
  });

  it("still rate limits a ringed request, before resolving a ring or fetching a feed", async () => {
    const ringed = feedRequest({
      ...attributedHeaders(),
      "x-forwarded-for": "203.0.113.10",
    });
    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.FeedClient;
      index += 1
    ) {
      await feedGET(ringed);
    }
    mocks.findUnique.mockClear();
    mocks.getLatestElectronUpdaterFeed.mockClear();

    const response = await feedGET(ringed);

    expect(response.status).toBe(429);
    expect(response.headers.get(RING_HEADER)).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.getLatestElectronUpdaterFeed).not.toHaveBeenCalled();
  });
});

describe("GET /desktop/updates/[assetName] ring answer", () => {
  it("answers a ringed asset request with the ring and a private cache policy", async () => {
    mocks.env.DESKTOP_INTERNAL_RING_TARGETS = COMPUTE_TARGET_ID;

    const response = await assetGET(
      assetRequest(attributedHeaders()),
      assetContext()
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED_REDIRECT_URL);
    expect(response.headers.get(RING_HEADER)).toBe("internal");
    expect(response.headers.get("cache-control")).toBe(
      PER_INSTALL_CACHE_CONTROL
    );
  });

  it("leaves an unattributed asset request with the cache headers it has today", async () => {
    const response = await assetGET(assetRequest(), assetContext());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED_REDIRECT_URL);
    expect(response.headers.get(RING_HEADER)).toBe("general");
    expect(response.headers.get("cache-control")).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("still rate limits a ringed asset request before resolving a ring", async () => {
    const ringed = assetRequest({
      ...attributedHeaders(),
      "x-forwarded-for": "203.0.113.20",
    });
    for (
      let index = 0;
      index < DesktopUpdaterRateLimitLimit.AssetClientResource;
      index += 1
    ) {
      await assetGET(ringed, assetContext());
    }
    mocks.findUnique.mockClear();
    mocks.getElectronUpdaterAssetRedirectUrl.mockClear();

    const response = await assetGET(ringed, assetContext());

    expect(response.status).toBe(429);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.getElectronUpdaterAssetRedirectUrl).not.toHaveBeenCalled();
  });
});

/**
 * ISS-9165 — the ring now picks a CHANNEL, and that is the only thing separating
 * an internal install from a customer's.
 *
 * Asserted on the downstream call shape, not on the response body: both channels
 * return a feed, so a route that resolved the ring correctly and then fetched the
 * wrong channel would pass every ISS-9164 assertion above while shipping
 * candidates to customers.
 */
describe("updater channel selection by ring", () => {
  function internalRing(): void {
    mocks.env.DESKTOP_INTERNAL_RING_ORGANIZATIONS = INTERNAL_ORGANIZATION_ID;
    mocks.findUnique.mockResolvedValue({
      organizationId: INTERNAL_ORGANIZATION_ID,
    });
  }

  it("prefers the candidate channel for an internal-ring install, promoted as fallback", async () => {
    internalRing();

    const response = await feedGET(feedRequest(attributedHeaders()));

    expect(response.headers.get(RING_HEADER)).toBe("internal");
    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledWith([
      CANDIDATE_CHANNEL,
      PROMOTED_CHANNEL,
    ]);
  });

  it("fetches the promoted channel's feed for a general-ring install", async () => {
    const response = await feedGET(feedRequest(attributedHeaders()));

    expect(response.headers.get(RING_HEADER)).toBe("general");
    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledWith([
      PROMOTED_CHANNEL,
    ]);
  });

  it("offers an unattributed install the promoted channel and nothing else", async () => {
    // The cross-repo case: a build predating ISS-9164 sends no header at all and
    // must keep receiving exactly the channel it receives today.
    await feedGET(feedRequest());

    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledWith([
      PROMOTED_CHANNEL,
    ]);
  });

  /**
   * The real helper's shape, narrowed to what these cases turn on: a
   * candidate-only asset exists on `desktop-candidate` and NOWHERE else, so the
   * redirect comes back only when the route asked for that channel. A mock that
   * answered the same way for either list would pass whatever the route did.
   */
  function candidateOnlyAsset(): void {
    mocks.getElectronUpdaterAssetRedirectUrl.mockImplementation(
      (_assetName: string, channels: readonly string[]) =>
        Promise.resolve(
          channels.includes(CANDIDATE_CHANNEL) ? SIGNED_REDIRECT_URL : null
        )
    );
  }

  /**
   * whitlockk, #7121: the shape the desktop ACTUALLY sends. The updater takes the
   * compute-target id back off `autoUpdater.requestHeaders` on `update-available`
   * — synchronously, before `downloadUpdate()` recomputes the download's headers
   * — so the ZIP request that follows a candidate feed carries no attribution at
   * all. Driven with no header for exactly that reason: ringing this leg resolved
   * the internal ring's own download to `general`, where the candidate asset does
   * not exist, and 404'd the update it had just been offered.
   */
  it("serves a candidate-only asset to the unattributed download the desktop actually sends", async () => {
    candidateOnlyAsset();

    const response = await assetGET(assetRequest(), assetContext());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGNED_REDIRECT_URL);
  });

  it("resolves an asset against both channels, promoted first, whatever the ring", async () => {
    internalRing();

    await assetGET(assetRequest(attributedHeaders()), assetContext());
    await assetGET(assetRequest(), assetContext());

    // Identical for both, which is the point: the asset leg carries no ring to
    // resolve, so it must not pretend to. Promoted first keeps the ordinary
    // download on one GitHub call.
    expect(mocks.getElectronUpdaterAssetRedirectUrl.mock.calls).toEqual([
      [ZIP_ASSET, [PROMOTED_CHANNEL, CANDIDATE_CHANNEL]],
      [ZIP_ASSET, [PROMOTED_CHANNEL, CANDIDATE_CHANNEL]],
    ]);
  });

  /**
   * What still keeps a candidate away from a customer, now that the asset leg
   * cannot: the FEED is ringed, so a general install is never told a candidate
   * version exists and never asks for its ZIP.
   */
  it("still never offers a general-ring install a candidate feed", async () => {
    await assetGET(assetRequest(), assetContext());
    await feedGET(feedRequest(attributedHeaders()));

    expect(mocks.getLatestElectronUpdaterFeed).toHaveBeenCalledWith([
      PROMOTED_CHANNEL,
    ]);
  });
});
