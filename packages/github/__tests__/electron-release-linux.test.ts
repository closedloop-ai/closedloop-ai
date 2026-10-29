import {
  DesktopReleaseChannel,
  DesktopReleaseLinuxUpdaterMetadataAssetName,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  getDesktopReleaseTag,
} from "@repo/api/src/types/desktop-release";
import { DesktopReleaseLinuxStagedUpdaterMetadataAssetName } from "@repo/api/src/types/desktop-release-linux";
import { describe, expect, it, vi } from "vitest";
import {
  resolveElectronUpdaterAssetRedirectUrl,
  selectLatestDesktopRelease,
  selectLatestElectronUpdaterFeed,
} from "../electron-release";
import {
  DOWNLOAD_URL,
  makeAsset,
  makeDesktopRelease,
  makeMetadata,
  SIGNED_REDIRECT_URL,
  VERSION,
} from "./electron-release-fixtures";

const appImage = "Closedloop-0.17.123-linux-x64.AppImage";
const deb = "Closedloop-0.17.123-linux-x64.deb";
const feed = `version: 0.17.123\nfiles:\n  - url: ${appImage}\n  - url: ${deb}\n`;
const release = makeDesktopRelease({
  assets: [
    makeAsset(1, DesktopReleaseLinuxUpdaterMetadataAssetName),
    makeAsset(2, appImage),
    makeAsset(3, deb),
  ],
});

describe("Linux updater release selection", () => {
  it("serves the platform's feed with both published installers", async () => {
    expect(
      await selectLatestElectronUpdaterFeed(
        release,
        async () => feed,
        DesktopReleaseLinuxUpdaterMetadataAssetName
      )
    ).toBe(feed);
  });
  it("falls back when a candidate has no Linux feed", async () => {
    expect(
      await selectLatestElectronUpdaterFeed(
        makeDesktopRelease(),
        async () => feed,
        DesktopReleaseLinuxUpdaterMetadataAssetName
      )
    ).toBeNull();
  });
  it("refuses a feed whose Debian artifact is missing", async () => {
    expect(
      await selectLatestElectronUpdaterFeed(
        {
          ...release,
          assets: release.assets.filter((asset) => asset.name !== deb),
        },
        async () => feed,
        DesktopReleaseLinuxUpdaterMetadataAssetName
      )
    ).toBeNull();
  });
  it.each([appImage, deb])(
    "redirects the current %s artifact",
    async (name) => {
      expect(
        await resolveElectronUpdaterAssetRedirectUrl(
          release,
          name,
          async () => feed,
          async () => ({
            status: 302,
            headers: { location: SIGNED_REDIRECT_URL },
          })
        )
      ).toBe(SIGNED_REDIRECT_URL);
    }
  );
  it("rejects draft releases and unadvertised versions", async () => {
    for (const candidate of [{ ...release, draft: true }, release]) {
      expect(
        await resolveElectronUpdaterAssetRedirectUrl(
          candidate,
          "Closedloop-0.17.122-linux-x64.deb",
          async () => feed,
          async () => ({
            status: 302,
            headers: { location: SIGNED_REDIRECT_URL },
          })
        )
      ).toBeNull();
    }
  });
  it("rejects a redirect to an untrusted host", async () => {
    await expect(
      resolveElectronUpdaterAssetRedirectUrl(
        release,
        deb,
        async () => feed,
        async () => ({
          status: 302,
          headers: { location: "https://example.com/installer" },
        })
      )
    ).rejects.toThrow();
  });
});

it("resolves an older advertised Linux update through its immutable release after the channel advances", async () => {
  const olderDeb = deb.replace("0.17.123", "0.17.122");
  const olderAppImage = appImage.replace("0.17.123", "0.17.122");
  const olderRelease = makeDesktopRelease({
    assets: [
      makeAsset(11, DesktopReleaseLinuxUpdaterMetadataAssetName),
      makeAsset(12, olderAppImage),
      makeAsset(13, olderDeb),
    ],
  });
  const requestedTags: string[] = [];
  expect(
    await resolveElectronUpdaterAssetRedirectUrl(
      release,
      olderDeb,
      async (asset) =>
        asset.id === 11 ? feed.replaceAll("0.17.123", "0.17.122") : feed,
      async () => ({ status: 302, headers: { location: SIGNED_REDIRECT_URL } }),
      (tagName) => {
        requestedTags.push(tagName);
        return Promise.resolve(olderRelease);
      }
    )
  ).toBe(SIGNED_REDIRECT_URL);
  expect(requestedTags).toEqual(["desktop-v0.17.122"]);
});
it("keeps the last macOS download when a newer complete Linux-only archive publishes", async () => {
  const version = "0.15.116";
  const tagName = getDesktopReleaseTag(version);
  const appImage = `Closedloop-${version}-linux-x64.AppImage`;
  const deb = `Closedloop-${version}-linux-x64.deb`;
  const linuxMetadata = {
    owner: DesktopReleaseOwner,
    repo: DesktopReleaseRepo,
    version,
    tagName,
    channel: DesktopReleaseChannel,
    targetCommitish: makeMetadata().targetCommitish,
    platforms: {
      linux: {
        version,
        tagName,
        targetCommitish: makeMetadata().targetCommitish,
        artifacts: { appImage, deb },
        updaterMetadata: DesktopReleaseLinuxUpdaterMetadataAssetName,
      },
    },
  };
  const linux = makeDesktopRelease({
    tagName,
    assets: [
      makeAsset(101, DesktopReleaseMetadataAssetName),
      makeAsset(102, appImage),
      makeAsset(103, deb),
      makeAsset(104, DesktopReleaseLinuxUpdaterMetadataAssetName),
    ],
  });
  const load = (asset: { id: number }) =>
    Promise.resolve(
      JSON.stringify(asset.id === 101 ? linuxMetadata : makeMetadata())
    );
  expect(
    await selectLatestDesktopRelease([linux, makeDesktopRelease()], load)
  ).toMatchObject({ version: VERSION, downloadUrl: DOWNLOAD_URL });
  linux.assets.pop();
  expect(
    await selectLatestDesktopRelease([linux, makeDesktopRelease()], load)
  ).toBeNull();
});

it("serves the staged Linux feed during the swap and after a stale listing's 404", async () => {
  const staged = {
    ...release,
    assets: [
      makeAsset(4, DesktopReleaseLinuxStagedUpdaterMetadataAssetName),
      ...release.assets.filter(
        (asset) => asset.name !== DesktopReleaseLinuxUpdaterMetadataAssetName
      ),
    ],
  };
  expect(
    await selectLatestElectronUpdaterFeed(
      staged,
      async () => feed,
      DesktopReleaseLinuxUpdaterMetadataAssetName
    )
  ).toBe(feed);
  const reload = vi.fn(async () => staged);
  expect(
    await selectLatestElectronUpdaterFeed(
      release,
      (asset) => {
        if (asset.id === 1) {
          return Promise.reject(
            Object.assign(new Error("gone"), { status: 404 })
          );
        }
        return Promise.resolve(feed);
      },
      DesktopReleaseLinuxUpdaterMetadataAssetName,
      reload
    )
  ).toBe(feed);
  expect(reload).toHaveBeenCalledTimes(1);
});

it("re-lists the Linux installer when the original listing predates its upload", async () => {
  const original = {
    ...release,
    assets: [makeAsset(1, DesktopReleaseLinuxUpdaterMetadataAssetName)],
  };
  const relisted = {
    ...release,
    assets: [
      makeAsset(4, DesktopReleaseLinuxStagedUpdaterMetadataAssetName),
      ...release.assets.slice(1),
    ],
  };
  expect(
    await resolveElectronUpdaterAssetRedirectUrl(
      original,
      deb,
      (asset) => {
        if (asset.id === 1) {
          return Promise.reject(
            Object.assign(new Error("gone"), { status: 404 })
          );
        }
        return Promise.resolve(feed);
      },
      async () => ({ status: 302, headers: { location: SIGNED_REDIRECT_URL } }),
      undefined,
      async () => relisted
    )
  ).toBe(SIGNED_REDIRECT_URL);
});
