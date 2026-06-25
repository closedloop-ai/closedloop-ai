import "server-only";
import {
  DesktopReleaseChannel,
  type DesktopReleaseMetadata,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseMetadataSchema,
  DesktopReleaseOwner,
  DesktopReleaseRepo,
  DesktopReleaseUpdaterMetadataAssetName,
  getDesktopReleaseTag,
  getDesktopReleaseUpdaterZipAssetNameFromFeed,
  getDesktopReleaseUpdaterZipAssetNameFromMetadata,
  isAcceptedDesktopReleaseDmgAssetName,
  isAcceptedDesktopReleaseZipAssetName,
  isAllowedDesktopReleaseAssetRedirectUrl,
  isAllowedDesktopReleaseDownloadUrl,
  isDesktopReleaseUpdaterZipAssetName,
  isVersionedDesktopReleaseTag,
} from "@repo/api/src/types/desktop-release";
import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { getAuthenticatedOctokit } from "./index";

export type { ElectronReleaseInfo } from "@repo/api/src/types/electron";

export type DesktopReleaseAsset = {
  id: number;
  name: string;
  browserDownloadUrl: string;
};

export type DesktopRelease = {
  tagName: string;
  body: string | null;
  draft: boolean;
  assets: DesktopReleaseAsset[];
};

type LoadReleaseAssetText = (asset: DesktopReleaseAsset) => Promise<string>;
type LoadReleaseAssetRedirect = (
  asset: DesktopReleaseAsset
) => Promise<DesktopReleaseAssetRedirectResponse>;
type ListDesktopReleasePage = (
  page: number,
  perPage: number
) => Promise<DesktopRelease[]>;

const GitHubReleasePageSize = 100;
const GitHubNotFoundErrorSchema = z.object({ status: z.literal(404) });

export type DesktopReleaseAssetRedirectResponse = {
  status: number;
  headers: Record<string, string | number | string[] | undefined>;
};

/**
 * Fetches the latest complete Desktop release from the Desktop-specific
 * symphony-alpha feed contract. Repo-global latest releases are ignored.
 */
export async function getLatestElectronRelease(): Promise<ElectronReleaseInfo | null> {
  try {
    const octokit = await getAuthenticatedOctokit();
    return selectLatestDesktopReleaseFromPages(
      async (page, perPage) => {
        const { data: releases } = await octokit.repos.listReleases({
          owner: DesktopReleaseOwner,
          repo: DesktopReleaseRepo,
          per_page: perPage,
          page,
        });
        return releases.map((release) => ({
          tagName: release.tag_name,
          body: release.body ?? "",
          draft: release.draft,
          assets: release.assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            browserDownloadUrl: asset.browser_download_url,
          })),
        }));
      },
      async (asset) => {
        const response = await octokit.request(
          "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
          {
            owner: DesktopReleaseOwner,
            repo: DesktopReleaseRepo,
            asset_id: asset.id,
            headers: {
              accept: "application/octet-stream",
            },
          }
        );
        return releaseAssetDataToText(response.data);
      }
    );
  } catch (error) {
    log.error(
      "[github/electron-release] Failed to fetch latest Desktop release",
      {
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    throw error;
  }
}

/**
 * Fetches the raw Electron updater feed from the mutable Desktop channel.
 */
export async function getLatestElectronUpdaterFeed(): Promise<string | null> {
  try {
    const octokit = await getAuthenticatedOctokit();
    const release = await getDesktopReleaseChannel(octokit);
    return selectLatestElectronUpdaterFeed(release, async (asset) => {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
        {
          owner: DesktopReleaseOwner,
          repo: DesktopReleaseRepo,
          asset_id: asset.id,
          headers: {
            accept: "application/octet-stream",
          },
        }
      );
      return releaseAssetDataToText(response.data);
    });
  } catch (error) {
    log.error(
      "[github/electron-release] Failed to fetch Desktop updater feed",
      {
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    throw error;
  }
}

/**
 * Resolves the short-lived GitHub object redirect for the current updater ZIP.
 */
export async function getElectronUpdaterAssetRedirectUrl(
  assetName: string
): Promise<string | null> {
  if (!isDesktopReleaseUpdaterZipAssetName(assetName)) {
    return null;
  }

  try {
    const octokit = await getAuthenticatedOctokit();
    const release = await getDesktopReleaseChannel(octokit);
    return resolveElectronUpdaterAssetRedirectUrl(
      release,
      assetName,
      async (asset) => {
        const response = await octokit.request(
          "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
          {
            owner: DesktopReleaseOwner,
            repo: DesktopReleaseRepo,
            asset_id: asset.id,
            headers: {
              accept: "application/octet-stream",
            },
          }
        );
        return releaseAssetDataToText(response.data);
      },
      async (asset) => {
        const response = await octokit.request(
          "GET /repos/{owner}/{repo}/releases/assets/{asset_id}",
          {
            owner: DesktopReleaseOwner,
            repo: DesktopReleaseRepo,
            asset_id: asset.id,
            headers: {
              accept: "application/octet-stream",
            },
            request: {
              redirect: "manual",
            },
          }
        );
        return {
          status: response.status,
          headers: response.headers,
        };
      }
    );
  } catch (error) {
    log.error(
      "[github/electron-release] Failed to resolve Desktop updater asset",
      {
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    throw error;
  }
}

export async function selectLatestElectronUpdaterFeed(
  release: DesktopRelease | null,
  loadReleaseAssetText: LoadReleaseAssetText
): Promise<string | null> {
  if (release === null || release.draft) {
    return null;
  }

  const feedAsset = findAsset(
    release.assets,
    DesktopReleaseUpdaterMetadataAssetName
  );
  if (feedAsset === undefined) {
    return null;
  }

  return await loadReleaseAssetText(feedAsset);
}

export async function resolveElectronUpdaterAssetRedirectUrl(
  release: DesktopRelease | null,
  assetName: string,
  loadReleaseAssetText: LoadReleaseAssetText,
  loadReleaseAssetRedirect: LoadReleaseAssetRedirect
): Promise<string | null> {
  if (
    release === null ||
    release.draft ||
    !isDesktopReleaseUpdaterZipAssetName(assetName)
  ) {
    return null;
  }

  const currentZipAssetName = await getCurrentUpdaterZipAssetName(
    release,
    loadReleaseAssetText
  );
  if (currentZipAssetName === null || assetName !== currentZipAssetName) {
    return null;
  }

  const zipAsset = findAsset(release.assets, currentZipAssetName);
  if (zipAsset === undefined) {
    return null;
  }

  const response = await loadReleaseAssetRedirect(zipAsset);
  return getRedirectLocationOrThrow(response);
}

/**
 * Pages through repo releases until the Desktop-specific release contract is
 * found, so unrelated symphony-alpha releases cannot hide Desktop downloads.
 */
export async function selectLatestDesktopReleaseFromPages(
  listReleasePage: ListDesktopReleasePage,
  loadReleaseAssetText: LoadReleaseAssetText
): Promise<ElectronReleaseInfo | null> {
  const releases: DesktopRelease[] = [];

  for (let page = 1; ; page += 1) {
    const pageReleases = await listReleasePage(page, GitHubReleasePageSize);
    releases.push(...pageReleases);

    const selected = await selectLatestDesktopRelease(
      releases,
      loadReleaseAssetText
    );
    if (selected !== null) {
      return selected;
    }
    if (pageReleases.length < GitHubReleasePageSize) {
      return null;
    }
  }
}

/**
 * Selects the first complete Desktop release from a GitHub release list.
 * A release with no Desktop metadata is treated as a non-Desktop release.
 */
export async function selectLatestDesktopRelease(
  releases: DesktopRelease[],
  loadReleaseAssetText: LoadReleaseAssetText
): Promise<ElectronReleaseInfo | null> {
  for (const release of releases) {
    const metadataAsset = findAsset(
      release.assets,
      DesktopReleaseMetadataAssetName
    );
    if (metadataAsset === undefined) {
      continue;
    }

    if (!isVersionedDesktopReleaseTag(release.tagName)) {
      log.warn(
        "[github/electron-release] Skipping non-versioned Desktop release feed",
        {
          tag: release.tagName,
        }
      );
      continue;
    }

    if (release.draft) {
      log.warn("[github/electron-release] Desktop release is draft", {
        tag: release.tagName,
      });
      // Fail closed rather than falling back to an older release while the
      // latest Desktop release may still be publishing.
      return null;
    }

    const metadataText = await loadReleaseAssetText(metadataAsset);
    const metadata = parseDesktopReleaseMetadata(metadataText);
    if (metadata === null) {
      log.warn("[github/electron-release] Desktop release metadata malformed", {
        tag: release.tagName,
      });
      // Malformed metadata on the newest Desktop release is treated as a broken
      // release contract, not permission to surface an older installer.
      return null;
    }

    if (!isCompleteDesktopRelease(release, metadata)) {
      log.warn("[github/electron-release] Desktop release is incomplete", {
        tag: release.tagName,
        assets: release.assets.map((asset) => asset.name),
      });
      // Incomplete assets can mean a publish is mid-flight; keep clients from
      // silently downgrading to a stale release.
      return null;
    }

    return {
      downloadUrl: metadata.downloadUrl,
      version: metadata.version,
      releaseNotes: release.body ?? "",
    };
  }

  return null;
}

/**
 * Parses and validates the Desktop release metadata asset.
 */
export function parseDesktopReleaseMetadata(
  metadataText: string
): DesktopReleaseMetadata | null {
  try {
    const parsed = DesktopReleaseMetadataSchema.safeParse(
      JSON.parse(metadataText)
    );
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function isCompleteDesktopRelease(
  release: DesktopRelease,
  metadata: DesktopReleaseMetadata
): boolean {
  const expectedTagName = getDesktopReleaseTag(metadata.version);
  if (
    release.tagName !== expectedTagName ||
    metadata.tagName !== expectedTagName
  ) {
    return false;
  }

  // Accept both the current "Closedloop-*" asset names and the pre-rename
  // "ClosedLoop-*" names during the brand-rename transition (FEA-2101). Without
  // this, the still-published legacy release on `desktop-latest` fails the
  // completeness check the moment this server code deploys — dropping the whole
  // release so existing installs cannot update or download until the next
  // desktop release publishes. Reverted to the current name only in FEA-2107.
  if (
    !isAcceptedDesktopReleaseDmgAssetName(metadata.assets.dmg, metadata.version)
  ) {
    return false;
  }
  if (
    !isAcceptedDesktopReleaseZipAssetName(metadata.assets.zip, metadata.version)
  ) {
    return false;
  }

  const dmgAsset = findAsset(release.assets, metadata.assets.dmg);
  const zipAsset = findAsset(release.assets, metadata.assets.zip);
  const updaterAsset = findAsset(
    release.assets,
    metadata.assets.updaterMetadata
  );

  if (
    dmgAsset === undefined ||
    zipAsset === undefined ||
    updaterAsset === undefined
  ) {
    return false;
  }

  if (!isAllowedDesktopReleaseDownloadUrl(metadata.downloadUrl)) {
    return false;
  }

  return dmgAsset.browserDownloadUrl === metadata.downloadUrl;
}

async function getDesktopReleaseChannel(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>
): Promise<DesktopRelease | null> {
  try {
    const { data: release } = await octokit.repos.getReleaseByTag({
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: DesktopReleaseChannel,
    });

    return {
      tagName: release.tag_name,
      body: release.body ?? "",
      draft: release.draft,
      assets: release.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        browserDownloadUrl: asset.browser_download_url,
      })),
    };
  } catch (error) {
    if (GitHubNotFoundErrorSchema.safeParse(error).success) {
      return null;
    }
    throw error;
  }
}

async function getCurrentUpdaterZipAssetName(
  release: DesktopRelease,
  loadReleaseAssetText: LoadReleaseAssetText
): Promise<string | null> {
  const feedAsset = findAsset(
    release.assets,
    DesktopReleaseUpdaterMetadataAssetName
  );
  if (feedAsset !== undefined) {
    const feedText = await loadReleaseAssetText(feedAsset);
    const zipAssetName = getDesktopReleaseUpdaterZipAssetNameFromFeed(feedText);
    if (zipAssetName !== null) {
      return zipAssetName;
    }
  }

  const metadataAsset = findAsset(
    release.assets,
    DesktopReleaseMetadataAssetName
  );
  if (metadataAsset === undefined) {
    return null;
  }

  const metadataText = await loadReleaseAssetText(metadataAsset);
  return getDesktopReleaseUpdaterZipAssetNameFromMetadata(
    parseJsonOrNull(metadataText)
  );
}

function getRedirectLocationOrThrow(
  response: DesktopReleaseAssetRedirectResponse
): string {
  if (response.status !== 302) {
    throw new Error("Desktop updater asset redirect unavailable");
  }

  const location = getHeaderValue(response.headers, "location");
  if (location === null || !isAllowedDesktopReleaseAssetRedirectUrl(location)) {
    throw new Error("Desktop updater asset redirect unavailable");
  }

  return location;
}

function findAsset(
  assets: DesktopReleaseAsset[],
  assetName: string
): DesktopReleaseAsset | undefined {
  return assets.find((asset) => asset.name === assetName);
}

function releaseAssetDataToText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return JSON.stringify(data);
}

function getHeaderValue(
  headers: Record<string, string | number | string[] | undefined>,
  headerName: string
): string | null {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === headerName.toLowerCase()
  )?.[1];
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : null;
  }
  return typeof value === "string" ? value : null;
}

function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
