// ISS-12173: a publish swaps a channel's feed in by deleting latest-mac.yml and
// renaming the staged copy over it, so the feed route has to answer from the
// staged copy for the moment the live feed is gone.
import {
  DesktopReleaseChannel,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseStagedUpdaterMetadataAssetName,
  DesktopReleaseUpdaterMetadataAssetName,
} from "@repo/api/src/types/desktop-release";
import { describe, expect, it, vi } from "vitest";
import {
  type DesktopReleaseAsset,
  resolveElectronUpdaterAssetRedirectUrl,
  selectLatestElectronUpdaterFeed,
} from "../electron-release";
import {
  FEED_TEXT,
  makeAsset,
  makeDesktopRelease,
  SIGNED_REDIRECT_URL,
  ZIP_ASSET,
} from "./electron-release-fixtures";

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const LIVE_FEED = "version: 0.17.1\n";
const STAGED_FEED = "version: 0.17.2\n";
const LIVE_ID = 7;
const STAGED_ID = 8;

describe("selectLatestElectronUpdaterFeed during a feed swap", () => {
  it("reads the live feed while both copies are on the channel", async () => {
    await expect(
      selectLatestElectronUpdaterFeed(channelWith(true, true), loadFeed())
    ).resolves.toBe(LIVE_FEED);
  });

  it("reads the staged feed once the live one is deleted", async () => {
    await expect(
      selectLatestElectronUpdaterFeed(channelWith(false, true), loadFeed())
    ).resolves.toBe(STAGED_FEED);
  });

  it("reads the staged feed when the live one is deleted after the listing", async () => {
    const load = loadFeed(LIVE_ID, httpError(404));

    await expect(
      selectLatestElectronUpdaterFeed(channelWith(true, true), load)
    ).resolves.toBe(STAGED_FEED);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rethrows a live-feed failure that is not a 404 without reading the staged copy", async () => {
    const outage = httpError(503);
    const load = loadFeed(LIVE_ID, outage);

    await expect(
      selectLatestElectronUpdaterFeed(channelWith(true, true), load)
    ).rejects.toBe(outage);
    // ISS-12175 retries a 5xx once; both reads are of the live feed.
    expect(load.mock.calls.map(([asset]) => asset.id)).toEqual([
      LIVE_ID,
      LIVE_ID,
    ]);
  });

  it("rethrows the 404 when no staged copy is on the channel", async () => {
    const gone = httpError(404);

    await expect(
      selectLatestElectronUpdaterFeed(
        channelWith(true, false),
        loadFeed(LIVE_ID, gone)
      )
    ).rejects.toBe(gone);
  });

  it("re-lists the channel once when the listing predates the staged upload", async () => {
    const reload = vi.fn(async () => channelWith(false, true));

    await expect(
      selectLatestElectronUpdaterFeed(
        channelWith(true, false),
        loadFeed(LIVE_ID, httpError(404)),
        reload
      )
    ).resolves.toBe(STAGED_FEED);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("rethrows the 404 when the re-listed channel's feed is gone too", async () => {
    const gone = httpError(404);
    const reload = vi.fn(async () => channelWith(true, false));

    await expect(
      selectLatestElectronUpdaterFeed(
        channelWith(true, false),
        loadFeed(LIVE_ID, gone),
        reload
      )
    ).rejects.toBe(gone);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("resolveElectronUpdaterAssetRedirectUrl during a feed swap", () => {
  it("redirects the ZIP the staged feed names when the live feed is deleted after the listing", async () => {
    const release = channelWith(true, true);
    release.assets.push(makeAsset(3, ZIP_ASSET));
    const loadText = vi.fn((asset: DesktopReleaseAsset) =>
      asset.id === LIVE_ID
        ? Promise.reject(httpError(404))
        : Promise.resolve(FEED_TEXT)
    );
    const loadRedirect = vi.fn(async () => ({
      status: 302,
      headers: { location: SIGNED_REDIRECT_URL },
    }));

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        release,
        ZIP_ASSET,
        loadText,
        loadRedirect
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
  });

  it("redirects the ZIP the staged feed names when the listing predates the staged upload", async () => {
    const release = channelWith(true, false);
    release.assets.push(makeAsset(3, ZIP_ASSET));
    const relisted = channelWith(false, true);
    relisted.assets.push(makeAsset(3, ZIP_ASSET));
    const loadText = vi.fn((asset: DesktopReleaseAsset) =>
      asset.id === LIVE_ID
        ? Promise.reject(httpError(404))
        : Promise.resolve(FEED_TEXT)
    );
    const loadRedirect = vi.fn(async () => ({
      status: 302,
      headers: { location: SIGNED_REDIRECT_URL },
    }));

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        release,
        ZIP_ASSET,
        loadText,
        loadRedirect,
        undefined,
        async () => relisted
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
  });
});

function channelWith(live: boolean, staged: boolean) {
  const assets = [makeAsset(1, DesktopReleaseMetadataAssetName)];
  if (live) {
    assets.push(makeAsset(LIVE_ID, DesktopReleaseUpdaterMetadataAssetName));
  }
  if (staged) {
    assets.push(
      makeAsset(STAGED_ID, DesktopReleaseStagedUpdaterMetadataAssetName)
    );
  }
  return makeDesktopRelease({ tagName: DesktopReleaseChannel, assets });
}

/** Reads by id, as the route does, optionally failing one id with `error`. */
function loadFeed(failingId?: number, error?: Error) {
  return vi.fn((asset: DesktopReleaseAsset) => {
    if (asset.id === failingId) {
      return Promise.reject(error);
    }
    return Promise.resolve(asset.id === LIVE_ID ? LIVE_FEED : STAGED_FEED);
  });
}

/** The shape Octokit's RequestError carries: an Error with an HTTP status. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}
