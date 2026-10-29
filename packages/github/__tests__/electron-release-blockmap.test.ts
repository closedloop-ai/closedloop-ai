// ISS-10424. The release selector serves an updater ZIP's blockmap from
// wherever it serves that ZIP: the channel for the current version, the
// persistent `desktop-v<version>` release for an older one. electron-updater
// needs BOTH — the new version's blockmap and the installed version's — and the
// installed version has already left the rolling channel by the time it asks.
//
// Asset names are literals, and every release carries distinct asset ids whose
// redirect names the id, so a resolver that returned the ZIP for a blockmap
// request (or one version's blockmap for another's) fails here.
import {
  DesktopReleaseChannel,
  DesktopReleaseUpdaterMetadataAssetName,
} from "@repo/api/src/types/desktop-release";
import { describe, expect, it, vi } from "vitest";
import {
  type DesktopRelease,
  resolveElectronUpdaterAssetRedirectUrl,
} from "../electron-release";
import { makeAsset } from "./electron-release-fixtures";

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

const CHANNEL_RELEASE: DesktopRelease = {
  tagName: DesktopReleaseChannel,
  body: "",
  draft: false,
  assets: [
    makeAsset(1, DesktopReleaseUpdaterMetadataAssetName),
    makeAsset(11, "Closedloop-0.17.21-universal-mac.zip"),
    makeAsset(12, "Closedloop-0.17.21-universal-mac.zip.blockmap"),
    // Present on purpose: a name the updater never requests must stay
    // unservable even when a file by that name exists.
    makeAsset(13, "Closedloop-0.17.21-universal.dmg.blockmap"),
  ],
};

const VERSIONED_RELEASES: Record<string, DesktopRelease> = {
  "desktop-v0.17.20": {
    tagName: "desktop-v0.17.20",
    body: "",
    draft: false,
    assets: [
      makeAsset(21, "Closedloop-0.17.20-universal-mac.zip"),
      makeAsset(22, "Closedloop-0.17.20-universal-mac.zip.blockmap"),
    ],
  },
  // Published before ISS-10424, so it carries no blockmap.
  "desktop-v0.17.19": {
    tagName: "desktop-v0.17.19",
    body: "",
    draft: false,
    assets: [makeAsset(31, "Closedloop-0.17.19-universal-mac.zip")],
  },
};

function redirectFor(assetId: number): string {
  return `https://release-assets.githubusercontent.com/github-production-release-asset/${assetId}`;
}

function resolve(assetName: string, channel = CHANNEL_RELEASE) {
  const loadRedirect = vi.fn(async (asset: { id: number }) => ({
    status: 302,
    headers: { location: redirectFor(asset.id) },
  }));
  const loadVersionedRelease = vi.fn(
    async (tagName: string) => VERSIONED_RELEASES[tagName] ?? null
  );
  const result = resolveElectronUpdaterAssetRedirectUrl(
    channel,
    assetName,
    async () => CURRENT_FEED,
    loadRedirect,
    loadVersionedRelease
  );
  return { result, loadRedirect, loadVersionedRelease };
}

describe("resolveElectronUpdaterAssetRedirectUrl blockmaps (ISS-10424)", () => {
  it("serves the current version's blockmap from the channel", async () => {
    const { result, loadVersionedRelease } = resolve(
      "Closedloop-0.17.21-universal-mac.zip.blockmap"
    );

    await expect(result).resolves.toBe(redirectFor(12));
    expect(loadVersionedRelease).not.toHaveBeenCalled();
  });

  it("still serves the current ZIP itself, not its blockmap", async () => {
    await expect(
      resolve("Closedloop-0.17.21-universal-mac.zip").result
    ).resolves.toBe(redirectFor(11));
  });

  it("serves an older version's blockmap from its versioned release", async () => {
    const { result, loadVersionedRelease } = resolve(
      "Closedloop-0.17.20-universal-mac.zip.blockmap"
    );

    await expect(result).resolves.toBe(redirectFor(22));
    expect(loadVersionedRelease).toHaveBeenCalledWith("desktop-v0.17.20");
  });

  it("returns null for an older version published without a blockmap", async () => {
    const { result, loadRedirect } = resolve(
      "Closedloop-0.17.19-universal-mac.zip.blockmap"
    );

    await expect(result).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it("returns null for the current version when the channel lacks its blockmap", async () => {
    const withoutBlockmap: DesktopRelease = {
      ...CHANNEL_RELEASE,
      assets: CHANNEL_RELEASE.assets.filter((asset) => asset.id !== 12),
    };
    const { result, loadRedirect, loadVersionedRelease } = resolve(
      "Closedloop-0.17.21-universal-mac.zip.blockmap",
      withoutBlockmap
    );

    await expect(result).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
    expect(loadVersionedRelease).not.toHaveBeenCalled();
  });

  it("does not serve a newer version's blockmap before the channel points at it", async () => {
    const { result, loadVersionedRelease } = resolve(
      "Closedloop-0.17.22-universal-mac.zip.blockmap"
    );

    await expect(result).resolves.toBeNull();
    expect(loadVersionedRelease).not.toHaveBeenCalled();
  });

  it.each([
    "Closedloop-0.17.21-universal.dmg.blockmap",
    "latest-mac.yml.blockmap",
    "notes.blockmap",
  ])("serves nothing for %s even when the release carries it", async (name) => {
    const { result, loadRedirect, loadVersionedRelease } = resolve(name);

    await expect(result).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
    expect(loadVersionedRelease).not.toHaveBeenCalled();
  });
});
