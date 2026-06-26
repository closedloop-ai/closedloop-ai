import {
  DesktopReleaseChannel,
  type DesktopReleaseMetadata,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseUpdaterMetadataAssetName,
  getDesktopReleaseTag,
} from "@repo/api/src/types/desktop-release";
import { describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
  getAuthenticatedOctokit: vi.fn(),
}));

import {
  type DesktopRelease,
  parseDesktopReleaseMetadata,
  resolveElectronUpdaterAssetRedirectUrl,
  selectLatestDesktopRelease,
  selectLatestDesktopReleaseFromPages,
  selectLatestElectronUpdaterFeed,
} from "../electron-release";

const VERSION = "0.15.115";
const TAG = getDesktopReleaseTag(VERSION);
const DMG_ASSET = `Closedloop-${VERSION}-universal.dmg`;
const ZIP_ASSET = `Closedloop-${VERSION}-universal-mac.zip`;
const STALE_ZIP_ASSET = "Closedloop-0.15.114-universal-mac.zip";
const DOWNLOAD_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${TAG}/${DMG_ASSET}`;
const FEED_TEXT = `version: ${VERSION}\nfiles:\n  - url: ${ZIP_ASSET}\n    sha512: abc\n    size: 123\npath: ${ZIP_ASSET}\nsha512: abc\nreleaseDate: "2026-06-16T00:00:00.000Z"\n`;
const SIGNED_REDIRECT_URL =
  "https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345?X-Amz-Signature=abc";

describe("selectLatestDesktopRelease", () => {
  it("ignores newer non-Desktop symphony-alpha releases", async () => {
    const release = await selectLatestDesktopRelease(
      [makeNonDesktopRelease("deploy-2026-06-07"), makeDesktopRelease()],
      loadMetadata
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
  });

  it("skips the desktop-latest feed when selecting a web download", async () => {
    const loadMetadataSpy = vi.fn(loadMetadata);
    const release = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          body: "Updater feed",
        }),
        makeDesktopRelease(),
      ],
      loadMetadataSpy
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
    expect(loadMetadataSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when Desktop metadata is malformed", async () => {
    const release = makeDesktopRelease();
    const selected = await selectLatestDesktopRelease([release], async () =>
      JSON.stringify({ owner: DesktopReleaseOwner })
    );

    expect(selected).toBeNull();
  });

  it("fails closed instead of falling back when the newest Desktop release is draft", async () => {
    const selected = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({
          draft: true,
          tagName: getDesktopReleaseTag("0.15.116"),
        }),
        makeDesktopRelease(),
      ],
      loadMetadata
    );

    expect(selected).toBeNull();
  });

  it("returns null when a required Desktop asset is missing", async () => {
    const release = makeDesktopRelease({
      assets: [
        makeAsset(1, DesktopReleaseMetadataAssetName),
        makeAsset(2, DMG_ASSET, DOWNLOAD_URL),
        makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
      ],
    });
    const selected = await selectLatestDesktopRelease([release], loadMetadata);

    expect(selected).toBeNull();
  });

  it("fails closed instead of falling back when the newest Desktop release is incomplete", async () => {
    const selected = await selectLatestDesktopRelease(
      [
        makeDesktopRelease({
          assets: [
            makeAsset(1, DesktopReleaseMetadataAssetName),
            makeAsset(2, DMG_ASSET, DOWNLOAD_URL),
            makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
          ],
          tagName: getDesktopReleaseTag("0.15.116"),
        }),
        makeDesktopRelease(),
      ],
      loadMetadata
    );

    expect(selected).toBeNull();
  });

  it("rejects stale closedloop-electron download URLs", async () => {
    const metadata = parseDesktopReleaseMetadata(
      JSON.stringify({
        ...makeMetadata(),
        downloadUrl:
          "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg",
      })
    );

    expect(metadata).not.toBeNull();
    await expect(
      selectLatestDesktopRelease([makeDesktopRelease()], async () =>
        JSON.stringify({
          ...makeMetadata(),
          downloadUrl:
            "https://github.com/closedloop-ai/closedloop-electron/releases/download/v0.15.115/Closedloop-0.15.115-universal.dmg",
        })
      )
    ).resolves.toBeNull();
  });

  it("rejects malformed percent-encoded download URLs without throwing", async () => {
    await expect(
      selectLatestDesktopRelease([makeDesktopRelease()], async () =>
        JSON.stringify({
          ...makeMetadata(),
          downloadUrl:
            "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-v0.15.115/Closedloop-%E0%A4%A-universal.dmg",
        })
      )
    ).resolves.toBeNull();
  });

  it("rejects non-semver metadata versions", () => {
    const metadata = parseDesktopReleaseMetadata(
      JSON.stringify({
        ...makeMetadata(),
        version: "latest",
        tagName: "desktop-vlatest",
      })
    );

    expect(metadata).toBeNull();
  });

  it("rejects metadata assets that do not match the parsed version", async () => {
    await expect(
      selectLatestDesktopRelease([makeDesktopRelease()], async () =>
        JSON.stringify({
          ...makeMetadata(),
          assets: {
            ...makeMetadata().assets,
            dmg: "Closedloop-9.9.9-universal.dmg",
          },
        })
      )
    ).resolves.toBeNull();
  });

  it("accepts a pre-rename ClosedLoop-* release end-to-end during the brand transition (FEA-2101)", async () => {
    // Regression guard for the dead-code gap: isCompleteDesktopRelease must
    // accept the legacy DMG/ZIP names, otherwise the still-published legacy
    // release on desktop-latest is dropped and existing installs cannot update
    // until the next desktop release publishes.
    const legacyDmg = `ClosedLoop-${VERSION}-universal.dmg`;
    const legacyZip = `ClosedLoop-${VERSION}-universal-mac.zip`;
    const legacyDownloadUrl = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${TAG}/${legacyDmg}`;
    const legacyRelease = makeDesktopRelease({
      assets: [
        makeAsset(1, DesktopReleaseMetadataAssetName),
        makeAsset(2, legacyDmg, legacyDownloadUrl),
        makeAsset(3, legacyZip),
        makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
      ],
    });

    await expect(
      selectLatestDesktopRelease([legacyRelease], async () =>
        JSON.stringify({
          ...makeMetadata(),
          assets: {
            dmg: legacyDmg,
            zip: legacyZip,
            updaterMetadata: DesktopReleaseUpdaterMetadataAssetName,
          },
          downloadUrl: legacyDownloadUrl,
        })
      )
    ).resolves.toEqual({
      downloadUrl: legacyDownloadUrl,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
  });
});

describe("selectLatestDesktopReleaseFromPages", () => {
  it("pages past a full page of newer non-Desktop releases", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      makeNonDesktopRelease(`deploy-2026-06-07-${index}`)
    );
    const listReleasePage = vi.fn(async (page: number) =>
      page === 1 ? firstPage : [makeDesktopRelease()]
    );

    const release = await selectLatestDesktopReleaseFromPages(
      listReleasePage,
      loadMetadata
    );

    expect(release).toEqual({
      downloadUrl: DOWNLOAD_URL,
      version: VERSION,
      releaseNotes: "Desktop release notes",
    });
    expect(listReleasePage).toHaveBeenNthCalledWith(1, 1, 100);
    expect(listReleasePage).toHaveBeenNthCalledWith(2, 2, 100);
  });
});

describe("selectLatestElectronUpdaterFeed", () => {
  it("selects the desktop-latest latest-mac.yml asset text", async () => {
    const feed = await selectLatestElectronUpdaterFeed(
      makeDesktopRelease({ tagName: DesktopReleaseChannel }),
      loadUpdaterAssetText
    );

    expect(feed).toBe(FEED_TEXT);
  });

  it("returns null when the channel feed asset is missing", async () => {
    const feed = await selectLatestElectronUpdaterFeed(
      makeDesktopRelease({
        tagName: DesktopReleaseChannel,
        assets: [makeAsset(1, DesktopReleaseMetadataAssetName)],
      }),
      loadUpdaterAssetText
    );

    expect(feed).toBeNull();
  });
});

describe("resolveElectronUpdaterAssetRedirectUrl", () => {
  it("redirects only the current ZIP derived from latest-mac.yml", async () => {
    const loadRedirect = vi.fn(async () => ({
      status: 302,
      headers: { location: SIGNED_REDIRECT_URL },
    }));

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        loadUpdaterAssetText,
        loadRedirect
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
    expect(loadRedirect).toHaveBeenCalledTimes(1);
  });

  it("falls back to desktop-release.json metadata when the feed cannot identify a ZIP", async () => {
    const loadText = vi.fn(async (asset) =>
      asset.name === DesktopReleaseUpdaterMetadataAssetName
        ? "version: 0.15.115\n"
        : JSON.stringify(makeMetadata())
    );

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        loadText,
        loadAllowedRedirect
      )
    ).resolves.toBe(SIGNED_REDIRECT_URL);
  });

  it("keeps the feed ZIP authoritative when metadata names another ZIP", async () => {
    const metadataOnlyZip = "Closedloop-0.15.116-universal-mac.zip";
    const loadText = vi.fn(async (asset) =>
      asset.name === DesktopReleaseUpdaterMetadataAssetName
        ? FEED_TEXT
        : JSON.stringify({
            ...makeMetadata(),
            assets: { ...makeMetadata().assets, zip: metadataOnlyZip },
          })
    );

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            ...makeDesktopRelease().assets,
            makeAsset(5, metadataOnlyZip),
          ],
        }),
        metadataOnlyZip,
        loadText,
        loadAllowedRedirect
      )
    ).resolves.toBeNull();
  });

  it("returns null for a stale semver ZIP even when it is present on the release", async () => {
    const loadRedirect = vi.fn(loadAllowedRedirect);

    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            ...makeDesktopRelease().assets,
            makeAsset(5, STALE_ZIP_ASSET),
          ],
        }),
        STALE_ZIP_ASSET,
        loadUpdaterAssetText,
        loadRedirect
      )
    ).resolves.toBeNull();
    expect(loadRedirect).not.toHaveBeenCalled();
  });

  it.each([
    ["blockmap", `${ZIP_ASSET}.blockmap`],
    ["DMG", DMG_ASSET],
    ["metadata", DesktopReleaseMetadataAssetName],
    ["feed", DesktopReleaseUpdaterMetadataAssetName],
    ["traversal", `../${ZIP_ASSET}`],
    ["unknown", "notes.txt"],
  ])("returns null for %s requests", async (_name, assetName) => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        assetName,
        loadUpdaterAssetText,
        loadAllowedRedirect
      )
    ).resolves.toBeNull();
  });

  it("returns null when the current ZIP asset is missing", async () => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({
          tagName: DesktopReleaseChannel,
          assets: [
            makeAsset(1, DesktopReleaseMetadataAssetName),
            makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
          ],
        }),
        ZIP_ASSET,
        loadUpdaterAssetText,
        loadAllowedRedirect
      )
    ).resolves.toBeNull();
  });

  it.each([
    ["streamed 200 response", { status: 200, headers: {} }],
    ["non-redirect 2xx response", { status: 204, headers: {} }],
    ["missing location", { status: 302, headers: {} }],
    ["malformed location", { status: 302, headers: { location: "not a url" } }],
    [
      "disallowed location host",
      { status: 302, headers: { location: "https://example.com/asset.zip" } },
    ],
  ])("throws when GitHub returns %s for the current ZIP", async (_name, response) => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        makeDesktopRelease({ tagName: DesktopReleaseChannel }),
        ZIP_ASSET,
        loadUpdaterAssetText,
        async () => response
      )
    ).rejects.toThrow("Desktop updater asset redirect unavailable");
  });
});

function makeDesktopRelease(
  overrides: Partial<DesktopRelease> = {}
): DesktopRelease {
  return {
    tagName: TAG,
    body: "Desktop release notes",
    draft: false,
    assets: [
      makeAsset(1, DesktopReleaseMetadataAssetName),
      makeAsset(2, DMG_ASSET, DOWNLOAD_URL),
      makeAsset(3, ZIP_ASSET),
      makeAsset(4, DesktopReleaseUpdaterMetadataAssetName),
    ],
    ...overrides,
  };
}

function makeNonDesktopRelease(tagName: string): DesktopRelease {
  return {
    tagName,
    body: "Deploy release",
    draft: false,
    assets: [makeAsset(10, "deployment.json")],
  };
}

function makeAsset(
  id: number,
  name: string,
  browserDownloadUrl = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${TAG}/${name}`
) {
  return {
    id,
    name,
    browserDownloadUrl,
  };
}

function makeMetadata(): DesktopReleaseMetadata {
  return {
    owner: DesktopReleaseOwner,
    repo: DesktopReleaseRepo,
    version: VERSION,
    tagName: TAG,
    channel: DesktopReleaseChannel,
    targetCommitish: "0123456789abcdef0123456789abcdef01234567",
    assets: {
      dmg: DMG_ASSET,
      zip: ZIP_ASSET,
      updaterMetadata: DesktopReleaseUpdaterMetadataAssetName,
    },
    downloadUrl: DOWNLOAD_URL,
  };
}

function loadMetadata() {
  return Promise.resolve(JSON.stringify(makeMetadata()));
}

function loadUpdaterAssetText(asset: { name: string }) {
  if (asset.name === DesktopReleaseUpdaterMetadataAssetName) {
    return Promise.resolve(FEED_TEXT);
  }
  return Promise.resolve(JSON.stringify(makeMetadata()));
}

function loadAllowedRedirect() {
  return Promise.resolve({
    status: 302,
    headers: { location: SIGNED_REDIRECT_URL },
  });
}
