import {
  DesktopReleaseChannel,
  type DesktopReleaseMetadata,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseUpdaterMetadataAssetName,
  getDesktopReleaseDmgAssetName,
  getDesktopReleaseTag,
  getDesktopReleaseZipAssetName,
} from "@repo/api/src/types/desktop-release";
import type { DesktopRelease } from "../electron-release";

export const VERSION = "0.15.115";
export const TAG = getDesktopReleaseTag(VERSION);
export const DMG_ASSET = `Closedloop-${VERSION}-universal.dmg`;
export const ZIP_ASSET = `Closedloop-${VERSION}-universal-mac.zip`;
export const DOWNLOAD_URL = `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${TAG}/${DMG_ASSET}`;
export const FEED_TEXT = `version: ${VERSION}\nfiles:\n  - url: ${ZIP_ASSET}\n    sha512: abc\n    size: 123\npath: ${ZIP_ASSET}\nsha512: abc\nreleaseDate: "2026-06-16T00:00:00.000Z"\n`;
export const SIGNED_REDIRECT_URL =
  "https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345?X-Amz-Signature=abc";

export function makeAsset(
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

export function makeDesktopRelease(
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

export function makeDesktopReleaseForVersion(
  version: string,
  options: { draft?: boolean; zipAssetId?: number; zipAssetName?: string } = {}
): DesktopRelease {
  const tagName = getDesktopReleaseTag(version);
  const dmgAssetName = getDesktopReleaseDmgAssetName(version);
  const zipAssetName =
    options.zipAssetName ?? getDesktopReleaseZipAssetName(version);
  return makeDesktopRelease({
    tagName,
    draft: options.draft ?? false,
    assets: [
      makeAsset(
        1,
        DesktopReleaseMetadataAssetName,
        releaseDownloadUrl(tagName, DesktopReleaseMetadataAssetName)
      ),
      makeAsset(2, dmgAssetName, releaseDownloadUrl(tagName, dmgAssetName)),
      makeAsset(
        options.zipAssetId ?? 30,
        zipAssetName,
        releaseDownloadUrl(tagName, zipAssetName)
      ),
      makeAsset(
        4,
        DesktopReleaseUpdaterMetadataAssetName,
        releaseDownloadUrl(tagName, DesktopReleaseUpdaterMetadataAssetName)
      ),
    ],
  });
}

export function makeMetadata(): DesktopReleaseMetadata {
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

function releaseDownloadUrl(tagName: string, assetName: string) {
  return `https://github.com/${DesktopReleaseOwner}/${DesktopReleaseRepo}/releases/download/${tagName}/${assetName}`;
}
