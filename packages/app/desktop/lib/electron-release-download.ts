import { isAllowedDesktopReleaseDownloadUrl } from "@repo/api/src/types/desktop-release";
import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";

/**
 * Returns release data only when the download URL is an allowed Desktop asset.
 */
export function sanitizeElectronReleaseInfo(
  release: ElectronReleaseInfo | null | undefined
): ElectronReleaseInfo | null {
  if (!release) {
    return null;
  }

  if (!isAllowedDesktopReleaseDownloadUrl(release.downloadUrl)) {
    return null;
  }

  return release;
}
