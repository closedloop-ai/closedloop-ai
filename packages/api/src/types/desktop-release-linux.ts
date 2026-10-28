import {
  DesktopReleaseLinuxUpdaterMetadataAssetName,
  getDesktopReleaseUpdaterAssetNameFromFeed,
  getDesktopReleaseUpdaterVersionFromFeed,
  isSafeDesktopReleaseAssetBasename,
} from "./desktop-release.ts";

const LinuxUpdaterAssetNameRegex =
  /^Closedloop-(?<version>(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))-linux-x64\.(AppImage|deb)$/;

export function getDesktopReleaseLinuxAppImageAssetName(
  version: string
): string {
  return `Closedloop-${version}-linux-x64.AppImage`;
}

export function getDesktopReleaseLinuxDebAssetName(version: string): string {
  return `Closedloop-${version}-linux-x64.deb`;
}

export function isDesktopReleaseLinuxUpdaterAssetName(
  assetName: string
): boolean {
  return (
    isSafeDesktopReleaseAssetBasename(assetName) &&
    LinuxUpdaterAssetNameRegex.test(assetName)
  );
}

/** A feed must name the requested artifact for its own version. */
export function getDesktopReleaseLinuxUpdaterAssetNameFromFeed(
  feedText: string,
  requestedAssetName: string
): string | null {
  const version = getDesktopReleaseUpdaterVersionFromFeed(feedText);
  if (
    version === null ||
    !(
      requestedAssetName === getDesktopReleaseLinuxAppImageAssetName(version) ||
      requestedAssetName === getDesktopReleaseLinuxDebAssetName(version)
    )
  ) {
    return null;
  }
  return getDesktopReleaseUpdaterAssetNameFromFeed(
    feedText,
    (name) => name === requestedAssetName
  );
}

export function getDesktopReleaseVersionFromLinuxUpdaterAssetName(
  assetName: string
): string | null {
  if (!isSafeDesktopReleaseAssetBasename(assetName)) {
    return null;
  }
  return LinuxUpdaterAssetNameRegex.exec(assetName)?.groups?.version ?? null;
}

export const DesktopReleaseLinuxStagedUpdaterMetadataAssetName =
  "latest-linux.next.yml";
export const DesktopReleaseLinuxUpdaterFeedAssetNames = [
  DesktopReleaseLinuxUpdaterMetadataAssetName,
  DesktopReleaseLinuxStagedUpdaterMetadataAssetName,
] as const;
