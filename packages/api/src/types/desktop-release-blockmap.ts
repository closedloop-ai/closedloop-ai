import {
  isDesktopReleaseUpdaterZipAssetName,
  isSafeDesktopReleaseAssetBasename,
} from "./desktop-release.ts";

/**
 * Blockmap half of the Desktop release contract (ISS-10424).
 *
 * electron-builder writes `<artifact>.blockmap` beside each updater artifact,
 * and electron-updater downloads differentially only when it can fetch BOTH the
 * new version's and the installed version's. Split out of `./desktop-release.ts`
 * so that file stays clear of the 1,000-line ceiling, on the same pattern as
 * `./desktop-release-windows.ts`: additive to the contract there, and reusing
 * its `isSafeDesktopReleaseAssetBasename` traversal check rather than trusting
 * the suffix on its own.
 */

const DesktopReleaseUpdaterBlockmapSuffix = ".blockmap";

/**
 * The ZIP an updater asset request resolves through — the name itself for the
 * updater ZIP, the ZIP a `<updater ZIP>.blockmap` describes, and null for every
 * other name. electron-updater asks for both blockmaps by appending this suffix
 * to the ZIP URL, so nothing wider than that is admitted: a DMG's blockmap, or a
 * blockmap for any name that is not itself an updater ZIP, stays unservable.
 */
export function getDesktopReleaseUpdaterZipAssetNameForAsset(
  assetName: string
): string | null {
  if (isDesktopReleaseUpdaterZipAssetName(assetName)) {
    return assetName;
  }
  if (!isDesktopReleaseUpdaterBlockmapAssetName(assetName)) {
    return null;
  }
  return assetName.slice(0, -DesktopReleaseUpdaterBlockmapSuffix.length);
}

/**
 * True only for `<updater ZIP>.blockmap`. Kept apart from
 * {@link isDesktopReleaseUpdaterZipAssetName} because the feed and metadata
 * parsers use that one to decide which file IS the update, and a blockmap must
 * never be accepted there.
 */
export function isDesktopReleaseUpdaterBlockmapAssetName(
  assetName: string
): boolean {
  return (
    isSafeDesktopReleaseAssetBasename(assetName) &&
    assetName.endsWith(DesktopReleaseUpdaterBlockmapSuffix) &&
    isDesktopReleaseUpdaterZipAssetName(
      assetName.slice(0, -DesktopReleaseUpdaterBlockmapSuffix.length)
    )
  );
}
