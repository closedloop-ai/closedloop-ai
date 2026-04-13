import "server-only";
import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { log } from "@repo/observability/log";
import { getAuthenticatedOctokit } from "./index";

export type { ElectronReleaseInfo } from "@repo/api/src/types/electron";

/**
 * Fetch the latest release info for the closedloop-electron app.
 * Returns the .dmg asset's browser_download_url, version tag, and release notes.
 */
export async function getLatestElectronRelease(): Promise<ElectronReleaseInfo | null> {
  const owner = "closedloop-ai";
  const repo = "closedloop-electron";

  try {
    const octokit = await getAuthenticatedOctokit();
    const { data: release } = await octokit.repos.getLatestRelease({
      owner,
      repo,
    });

    const dmgAsset = release.assets.find((asset) =>
      asset.name.endsWith(".dmg")
    );

    if (!dmgAsset) {
      log.warn(
        "[github/electron-release] No .dmg asset found in latest release",
        {
          tag: release.tag_name,
          assets: release.assets.map((a) => a.name),
        }
      );
      return null;
    }

    return {
      downloadUrl: dmgAsset.browser_download_url,
      version: release.tag_name,
      releaseNotes: release.body ?? "",
    };
  } catch (error) {
    log.error(
      "[github/electron-release] Failed to fetch latest electron release",
      {
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    return null;
  }
}
