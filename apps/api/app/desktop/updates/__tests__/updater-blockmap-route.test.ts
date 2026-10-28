/**
 * ISS-10424 — the updater asset route serving blockmaps, driven through the
 * REAL release selector (`@repo/github/electron-release`).
 *
 * Only the GitHub client is doubled, and it answers by release tag and asset
 * id: each asset redirects to a URL naming its own id. So a route that served
 * the ZIP for a blockmap request, or one version's blockmap for another's,
 * returns the wrong Location here — which a helper mock returning one URL for
 * every name could never show.
 *
 * Asset names are written out, not derived from the module under test.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedOctokit: vi.fn(),
  brokenAssetIds: new Set<number>(),
}));

vi.mock("@repo/github/index", () => ({
  getAuthenticatedOctokit: mocks.getAuthenticatedOctokit,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { GET as assetGET } from "../[assetName]/route";
import { resetDesktopUpdaterRateLimiterForTests } from "../updater-abuse-control";

const FEED_ASSET_ID = 1;
const CURRENT_FEED = [
  "version: 0.17.21",
  "files:",
  "  - url: Closedloop-0.17.21-universal-mac.zip",
  "    sha512: abc",
  "    size: 123",
  "path: Closedloop-0.17.21-universal-mac.zip",
  "sha512: abc",
  "",
].join("\n");

// GitHub's REST wire shape, keyed by tag. `desktop-candidate` is absent, so the
// route's second channel 404s the way it does when no candidate exists.
const RELEASES_BY_TAG: Record<string, GitHubRelease> = {
  "desktop-latest": release("desktop-latest", [
    [FEED_ASSET_ID, "latest-mac.yml"],
    [11, "Closedloop-0.17.21-universal-mac.zip"],
    [12, "Closedloop-0.17.21-universal-mac.zip.blockmap"],
    [13, "Closedloop-0.17.21-universal.dmg.blockmap"],
  ]),
  "desktop-v0.17.20": release("desktop-v0.17.20", [
    [21, "Closedloop-0.17.20-universal-mac.zip"],
    [22, "Closedloop-0.17.20-universal-mac.zip.blockmap"],
  ]),
  // Published before ISS-10424: no blockmap.
  "desktop-v0.17.19": release("desktop-v0.17.19", [
    [31, "Closedloop-0.17.19-universal-mac.zip"],
  ]),
};

describe("GET /desktop/updates/[assetName] blockmaps (ISS-10424)", () => {
  beforeEach(() => {
    mocks.getAuthenticatedOctokit.mockResolvedValue(fakeOctokit());
  });

  afterEach(() => {
    mocks.getAuthenticatedOctokit.mockReset();
    mocks.brokenAssetIds.clear();
    resetDesktopUpdaterRateLimiterForTests();
  });

  it.each([
    ["the current ZIP", "Closedloop-0.17.21-universal-mac.zip", 11],
    [
      "the current version's blockmap",
      "Closedloop-0.17.21-universal-mac.zip.blockmap",
      12,
    ],
    [
      "the previous version's blockmap, from its versioned release",
      "Closedloop-0.17.20-universal-mac.zip.blockmap",
      22,
    ],
  ])("redirects %s to that asset", async (_name, assetName, assetId) => {
    const response = await get(assetName);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(redirectFor(assetId));
  });

  it.each([
    [
      "an older version published without one",
      "Closedloop-0.17.19-universal-mac.zip.blockmap",
    ],
    [
      "a version the channel does not point at yet",
      "Closedloop-0.17.22-universal-mac.zip.blockmap",
    ],
  ])("404s a missing blockmap for %s", async (_name, assetName) => {
    const response = await get(assetName);

    expect(response.status).toBe(404);
    expect(mocks.getAuthenticatedOctokit).toHaveBeenCalled();
  });

  it.each([
    "Closedloop-0.17.21-universal.dmg.blockmap",
    "latest-mac.yml.blockmap",
    "desktop-release.json.blockmap",
    "notes.blockmap",
    "Closedloop-0.17.21-universal-mac.zip.blockmap.blockmap",
    "../Closedloop-0.17.21-universal-mac.zip.blockmap",
    "Closedloop-%2F0.17.21-universal-mac.zip.blockmap",
  ])("404s %s without consulting GitHub", async (assetName) => {
    const response = await get(assetName);

    expect(response.status).toBe(404);
    expect(mocks.getAuthenticatedOctokit).not.toHaveBeenCalled();
  });

  it("answers an unreadable blockmap with the 404 electron-updater falls back on", async () => {
    mocks.brokenAssetIds.add(12);

    const response = await get("Closedloop-0.17.21-universal-mac.zip.blockmap");

    expect(response.status).toBe(404);
  });

  it("still answers an unreadable ZIP with a 500", async () => {
    mocks.brokenAssetIds.add(11);

    const response = await get("Closedloop-0.17.21-universal-mac.zip");

    expect(response.status).toBe(500);
  });
});

type GitHubRelease = {
  tag_name: string;
  body: string;
  draft: boolean;
  assets: { id: number; name: string; browser_download_url: string }[];
};

type AssetRequestOptions = {
  asset_id: number;
  request?: { redirect?: string };
};

function release(
  tagName: string,
  assets: [id: number, name: string][]
): GitHubRelease {
  return {
    tag_name: tagName,
    body: "",
    draft: false,
    assets: assets.map(([id, name]) => ({
      id,
      name,
      browser_download_url: `https://github.com/closedloop-ai/closedloop-ai/releases/download/${tagName}/${name}`,
    })),
  };
}

function redirectFor(assetId: number): string {
  return `https://release-assets.githubusercontent.com/github-production-release-asset/${assetId}`;
}

function fakeOctokit() {
  return {
    repos: {
      getReleaseByTag: vi.fn(({ tag }: { tag: string }) => {
        const found = RELEASES_BY_TAG[tag];
        if (found === undefined) {
          return Promise.reject(
            Object.assign(new Error("Not Found"), { status: 404 })
          );
        }
        return Promise.resolve({ data: found });
      }),
    },
    request: vi.fn((_route: string, options: AssetRequestOptions) => {
      if (options.request?.redirect !== "manual") {
        if (options.asset_id !== FEED_ASSET_ID) {
          return Promise.reject(
            new Error(`unexpected text read of asset ${options.asset_id}`)
          );
        }
        return Promise.resolve({ data: CURRENT_FEED });
      }
      // A broken asset answers 200 instead of redirecting, which the selector
      // treats as "redirect unavailable" and throws on.
      if (mocks.brokenAssetIds.has(options.asset_id)) {
        return Promise.resolve({ status: 200, headers: {} });
      }
      return Promise.resolve({
        status: 302,
        headers: { location: redirectFor(options.asset_id) },
      });
    }),
  };
}

function get(assetName: string): Promise<Response> {
  return assetGET(
    new NextRequest(
      `https://api.closedloop.ai/desktop/updates/${encodeURIComponent(assetName)}`,
      { method: "GET" }
    ),
    { params: Promise.resolve({ assetName }) }
  );
}
