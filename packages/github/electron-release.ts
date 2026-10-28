import "server-only";
import {
  DesktopReleaseCandidateChannel,
  DesktopReleaseChannel,
  type DesktopReleaseChannelName,
  DesktopReleaseLinuxUpdaterMetadataAssetName,
  type DesktopReleaseMetadata,
  DesktopReleaseMetadataAssetName,
  DesktopReleaseMetadataSchema,
  DesktopReleaseOwner,
  DesktopReleasePlatformsMetadataSchema,
  DesktopReleaseRepo,
  DesktopReleaseUpdaterFeedAssetNames,
  DesktopReleaseUpdaterMetadataAssetName,
  type DesktopReleaseVersionParts,
  getDesktopReleaseTag,
  getDesktopReleaseUpdaterVersionFromFeed,
  getDesktopReleaseUpdaterZipAssetNameFromFeed,
  getDesktopReleaseUpdaterZipAssetNameFromMetadata,
  getDesktopReleaseVersionFromUpdaterZipAssetName,
  isAcceptedDesktopReleaseDmgAssetName,
  isAcceptedDesktopReleaseZipAssetName,
  isAllowedDesktopReleaseAssetRedirectUrl,
  isAllowedDesktopReleaseDownloadUrl,
  isDesktopReleaseDownloadUrlForRelease,
  isVersionedDesktopReleaseTag,
  parseDesktopReleaseVersion,
} from "@repo/api/src/types/desktop-release";
import { getDesktopReleaseUpdaterZipAssetNameForAsset } from "@repo/api/src/types/desktop-release-blockmap";
import {
  DesktopReleaseLinuxUpdaterFeedAssetNames,
  getDesktopReleaseLinuxAppImageAssetName,
  getDesktopReleaseLinuxDebAssetName,
  getDesktopReleaseLinuxUpdaterAssetNameFromFeed,
  getDesktopReleaseVersionFromLinuxUpdaterAssetName,
  isDesktopReleaseLinuxUpdaterAssetName,
} from "@repo/api/src/types/desktop-release-linux";
import type { ElectronReleaseInfo } from "@repo/api/src/types/electron";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { extractGitHubErrorStatus } from "./error-status";
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
type LoadVersionedDesktopRelease = (
  tagName: string
) => Promise<DesktopRelease | null>;
type ReloadDesktopRelease = () => Promise<DesktopRelease | null>;
type ListDesktopReleasePage = (
  page: number,
  perPage: number
) => Promise<DesktopRelease[]>;

const GitHubReleasePageSize = 100;
/** The rolling channels that legitimately appear in the release list untagged. */
const MutableDesktopReleaseChannels: ReadonlySet<string> = new Set<string>([
  DesktopReleaseChannel,
  DesktopReleaseCandidateChannel,
]);
const GitHubNotFoundErrorSchema = z.object({ status: z.literal(404) });

type CurrentUpdaterRelease = {
  version: string | null;
  zipAssetName: string | null;
};

export type DesktopReleaseAssetRedirectResponse = {
  status: number;
  headers: Record<string, string | number | string[] | undefined>;
};

/**
 * Fetches the latest complete Desktop release from the Desktop-specific
 * closedloop-ai feed contract. Repo-global latest releases are ignored.
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
 * Fetches the raw Electron updater feed from the first mutable Desktop channel
 * that has one, in the given preference order.
 *
 * `channels` is required and never defaulted (ISS-9165): the channels differ
 * only in which build they carry, so a caller that forgot the argument would be
 * served a real feed for the wrong ring and nothing downstream could tell. The
 * order comes from `desktopReleaseChannelsForRing`, which is what keeps the
 * fallback one-way.
 */
export async function getLatestElectronUpdaterFeed(
  channels: readonly DesktopReleaseChannelName[],
  metadataAssetName: DesktopUpdaterMetadataAssetName = DesktopReleaseUpdaterMetadataAssetName
): Promise<string | null> {
  try {
    const octokit = await retryOnGitHubServerError(getAuthenticatedOctokit);
    for (const channel of channels) {
      const feed = await loadUpdaterFeedForChannel(
        octokit,
        channel,
        metadataAssetName
      );
      if (feed !== null) {
        return feed;
      }
    }
    return null;
  } catch (error) {
    const status = extractGitHubErrorStatus(error);
    log.error(
      "[github/electron-release] Failed to fetch Desktop updater feed",
      {
        error: error instanceof Error ? error.message : "Unknown error",
        ...(status !== null && { upstreamStatus: status }),
      }
    );
    throw error;
  }
}

async function loadUpdaterFeedForChannel(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  channel: DesktopReleaseChannelName,
  metadataAssetName: DesktopUpdaterMetadataAssetName
): Promise<string | null> {
  const readChannel = () =>
    retryOnGitHubServerError(() => getDesktopReleaseChannel(octokit, channel));
  const release = await readChannel();
  return await selectLatestElectronUpdaterFeed(
    release,
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
    metadataAssetName,
    readChannel
  );
}

/**
 * Resolves the short-lived GitHub object redirect for an updater ZIP or, since
 * ISS-10424, that ZIP's blockmap.
 */
export async function getElectronUpdaterAssetRedirectUrl(
  assetName: string,
  channels: readonly DesktopReleaseChannelName[]
): Promise<string | null> {
  if (
    getDesktopReleaseUpdaterZipAssetNameForAsset(assetName) === null &&
    !isDesktopReleaseLinuxUpdaterAssetName(assetName)
  ) {
    return null;
  }

  try {
    const octokit = await getAuthenticatedOctokit();
    for (const channel of channels) {
      const redirectUrl = await resolveAssetRedirectUrlForChannel(
        octokit,
        assetName,
        channel
      );
      if (redirectUrl !== null) {
        return redirectUrl;
      }
    }
    return null;
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

async function resolveAssetRedirectUrlForChannel(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  assetName: string,
  channel: DesktopReleaseChannelName
): Promise<string | null> {
  const release = await getDesktopReleaseChannel(octokit, channel);
  return await resolveElectronUpdaterAssetRedirectUrl(
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
    },
    (tagName) => getDesktopReleaseByTag(octokit, tagName),
    () => getDesktopReleaseChannel(octokit, channel)
  );
}

export async function selectLatestElectronUpdaterFeed(
  release: DesktopRelease | null,
  loadReleaseAssetText: LoadReleaseAssetText,
  metadataAssetNameOrReload:
    | DesktopUpdaterMetadataAssetName
    | ReloadDesktopRelease = DesktopReleaseUpdaterMetadataAssetName,
  reloadRelease?: ReloadDesktopRelease
): Promise<string | null> {
  if (release === null || release.draft) {
    return null;
  }

  const metadataAssetName =
    typeof metadataAssetNameOrReload === "function"
      ? DesktopReleaseUpdaterMetadataAssetName
      : metadataAssetNameOrReload;
  const reload =
    typeof metadataAssetNameOrReload === "function"
      ? metadataAssetNameOrReload
      : reloadRelease;
  const feed = await loadChannelFeedText(
    release,
    loadReleaseAssetText,
    reload,
    metadataAssetName
  );
  if (feed === null) {
    return null;
  }
  if (metadataAssetName === DesktopReleaseLinuxUpdaterMetadataAssetName) {
    const version = getDesktopReleaseUpdaterVersionFromFeed(feed);
    if (version === null) {
      return null;
    }
    for (const name of [
      getDesktopReleaseLinuxAppImageAssetName(version),
      getDesktopReleaseLinuxDebAssetName(version),
    ]) {
      if (getDesktopReleaseLinuxUpdaterAssetNameFromFeed(feed, name) === null) {
        return null;
      }
      if (findAsset(release.assets, name) === undefined) {
        if (reload) {
          return selectLatestElectronUpdaterFeed(
            await reload(),
            loadReleaseAssetText,
            metadataAssetName
          );
        }
        return null;
      }
    }
  }
  return feed;
}

export async function resolveElectronUpdaterAssetRedirectUrl(
  release: DesktopRelease | null,
  assetName: string,
  loadReleaseAssetText: LoadReleaseAssetText,
  loadReleaseAssetRedirect: LoadReleaseAssetRedirect,
  loadVersionedRelease?: LoadVersionedDesktopRelease,
  reloadRelease?: ReloadDesktopRelease
): Promise<string | null> {
  if (isDesktopReleaseLinuxUpdaterAssetName(assetName)) {
    return resolveLinuxUpdaterAssetRedirectUrl(
      release,
      assetName,
      loadReleaseAssetText,
      loadReleaseAssetRedirect,
      loadVersionedRelease,
      reloadRelease
    );
  }

  // A blockmap is served from wherever its ZIP is, so every decision below is
  // taken on the ZIP's name and only the final asset lookup uses `assetName`.
  const zipAssetName = getDesktopReleaseUpdaterZipAssetNameForAsset(assetName);
  if (release === null || release.draft || zipAssetName === null) {
    return null;
  }

  const currentUpdaterRelease = await getCurrentUpdaterRelease(
    release,
    loadReleaseAssetText,
    reloadRelease
  );
  const { version: currentVersion, zipAssetName: currentZipAssetName } =
    currentUpdaterRelease;

  if (zipAssetName === currentZipAssetName) {
    const asset = findAsset(release.assets, assetName);
    if (asset !== undefined) {
      const response = await loadReleaseAssetRedirect(asset);
      return getRedirectLocationOrThrow(response);
    }
    return null;
  }

  if (!isStaleUpdaterZipAssetName(zipAssetName, currentVersion)) {
    return null;
  }

  return await resolveVersionedUpdaterAssetRedirectUrl(
    assetName,
    zipAssetName,
    loadVersionedRelease,
    loadReleaseAssetRedirect
  );
}

/**
 * Pages through repo releases until the Desktop-specific release contract is
 * found, so unrelated closedloop-ai releases cannot hide Desktop downloads.
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
      // This is the whole reason a candidate carries no versioned release
      // (ISS-9165): `desktop-candidate` sits in this list carrying complete
      // metadata, and is skipped here, so the download page can only ever offer
      // a PROMOTED build. Debug rather than warn for the two rolling channels —
      // both are expected members of the list and this route is polled, so
      // warning on them would be noise on every request. An unversioned tag that
      // is neither still warns.
      const skipMessage =
        "[github/electron-release] Skipping non-versioned Desktop release feed";
      if (MutableDesktopReleaseChannels.has(release.tagName)) {
        log.debug(skipMessage, { tag: release.tagName });
      } else {
        log.warn(skipMessage, { tag: release.tagName });
      }
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
    if (isLinuxOnlyDesktopArchive(release, metadataText)) {
      continue;
    }
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

  // Shared with the release preflight's completeness check — see the helper's
  // doc comment for why downloadUrl may legitimately point at another repo.
  return isDesktopReleaseDownloadUrlForRelease(
    metadata.downloadUrl,
    dmgAsset.browserDownloadUrl,
    metadata.version
  );
}

function getDesktopReleaseChannel(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  channel: DesktopReleaseChannelName
): Promise<DesktopRelease | null> {
  return getDesktopReleaseByTag(octokit, channel);
}

async function getDesktopReleaseByTag(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  tagName: string
): Promise<DesktopRelease | null> {
  try {
    const { data: release } = await octokit.repos.getReleaseByTag({
      owner: DesktopReleaseOwner,
      repo: DesktopReleaseRepo,
      tag: tagName,
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

async function resolveVersionedUpdaterAssetRedirectUrl(
  assetName: string,
  zipAssetName: string,
  loadVersionedRelease: LoadVersionedDesktopRelease | undefined,
  loadReleaseAssetRedirect: LoadReleaseAssetRedirect
): Promise<string | null> {
  if (loadVersionedRelease === undefined) {
    return null;
  }

  const version = getDesktopReleaseVersionFromUpdaterZipAssetName(zipAssetName);
  if (version === null) {
    return null;
  }

  const tagName = getDesktopReleaseTag(version);
  const release = await loadVersionedRelease(tagName);
  if (release === null || release.draft || release.tagName !== tagName) {
    return null;
  }

  const asset = findAsset(release.assets, assetName);
  if (asset === undefined) {
    return null;
  }

  const response = await loadReleaseAssetRedirect(asset);
  return getRedirectLocationOrThrow(response);
}

function isStaleUpdaterZipAssetName(
  requestedAssetName: string,
  currentVersion: string | null
): boolean {
  const requestedVersion =
    getDesktopReleaseVersionFromUpdaterZipAssetName(requestedAssetName);
  if (requestedVersion === null || currentVersion === null) {
    return false;
  }

  return compareDesktopReleaseVersions(requestedVersion, currentVersion) < 0;
}

function compareDesktopReleaseVersions(left: string, right: string): number {
  const leftParts = parseDesktopReleaseVersion(left);
  const rightParts = parseDesktopReleaseVersion(right);
  if (leftParts === null || rightParts === null) {
    return 0;
  }

  return compareDesktopReleaseVersionParts(leftParts, rightParts);
}

function compareDesktopReleaseVersionParts(
  left: DesktopReleaseVersionParts,
  right: DesktopReleaseVersionParts
): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

async function getCurrentUpdaterRelease(
  release: DesktopRelease,
  loadReleaseAssetText: LoadReleaseAssetText,
  reloadRelease: ReloadDesktopRelease | undefined
): Promise<CurrentUpdaterRelease> {
  let feedVersion: string | null = null;
  const feedText = await loadChannelFeedText(
    release,
    loadReleaseAssetText,
    reloadRelease
  );
  if (feedText !== null) {
    const zipAssetName = getDesktopReleaseUpdaterZipAssetNameFromFeed(feedText);
    if (zipAssetName !== null) {
      return {
        version: getDesktopReleaseVersionFromUpdaterZipAssetName(zipAssetName),
        zipAssetName,
      };
    }
    feedVersion = getDesktopReleaseUpdaterVersionFromFeed(feedText);
  }

  const metadataAsset = findAsset(
    release.assets,
    DesktopReleaseMetadataAssetName
  );
  if (metadataAsset === undefined) {
    return { version: feedVersion, zipAssetName: null };
  }

  const metadataText = await loadReleaseAssetText(metadataAsset);
  const metadata = DesktopReleaseMetadataSchema.safeParse(
    parseJsonOrNull(metadataText)
  );
  if (!metadata.success) {
    return { version: feedVersion, zipAssetName: null };
  }

  const zipAssetName = getDesktopReleaseUpdaterZipAssetNameFromMetadata(
    metadata.data
  );
  return { version: metadata.data.version, zipAssetName };
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

export type DesktopUpdaterMetadataAssetName =
  | typeof DesktopReleaseUpdaterMetadataAssetName
  | typeof DesktopReleaseLinuxUpdaterMetadataAssetName;

async function resolveLinuxUpdaterAssetRedirectUrl(
  release: DesktopRelease | null,
  assetName: string,
  loadReleaseAssetText: LoadReleaseAssetText,
  loadReleaseAssetRedirect: LoadReleaseAssetRedirect,
  loadVersionedRelease?: LoadVersionedDesktopRelease,
  reloadRelease?: ReloadDesktopRelease
): Promise<string | null> {
  const feed = await selectLatestElectronUpdaterFeed(
    release,
    loadReleaseAssetText,
    DesktopReleaseLinuxUpdaterMetadataAssetName,
    reloadRelease
  );
  if (release === null || feed === null) {
    return null;
  }
  if (
    getDesktopReleaseLinuxUpdaterAssetNameFromFeed(feed, assetName) !==
    assetName
  ) {
    const requestedVersion =
      getDesktopReleaseVersionFromLinuxUpdaterAssetName(assetName);
    const currentVersion = getDesktopReleaseUpdaterVersionFromFeed(feed);
    if (
      requestedVersion === null ||
      currentVersion === null ||
      loadVersionedRelease === undefined ||
      compareDesktopReleaseVersions(requestedVersion, currentVersion) >= 0
    ) {
      return null;
    }
    return resolveLinuxUpdaterAssetRedirectUrl(
      await loadVersionedRelease(getDesktopReleaseTag(requestedVersion)),
      assetName,
      loadReleaseAssetText,
      loadReleaseAssetRedirect
    );
  }
  const asset = findAsset(release.assets, assetName);
  if (asset === undefined) {
    if (reloadRelease) {
      return resolveLinuxUpdaterAssetRedirectUrl(
        await reloadRelease(),
        assetName,
        loadReleaseAssetText,
        loadReleaseAssetRedirect,
        loadVersionedRelease
      );
    }
    return null;
  }
  return getRedirectLocationOrThrow(await loadReleaseAssetRedirect(asset));
}

function isLinuxOnlyDesktopArchive(
  release: DesktopRelease,
  text: string
): boolean {
  const raw = parseJsonOrNull(text);
  if (
    raw === null ||
    typeof raw !== "object" ||
    "assets" in raw ||
    "downloadUrl" in raw
  ) {
    return false;
  }
  const parsed = DesktopReleasePlatformsMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    return false;
  }
  const metadata = parsed.data;
  const linux = metadata.platforms?.linux;
  if (
    !linux ||
    metadata.platforms?.darwin ||
    metadata.tagName !== release.tagName ||
    metadata.tagName !== getDesktopReleaseTag(metadata.version) ||
    linux.version !== metadata.version ||
    linux.tagName !== metadata.tagName ||
    linux.targetCommitish !== metadata.targetCommitish ||
    linux.updaterMetadata !== DesktopReleaseLinuxUpdaterMetadataAssetName ||
    linux.artifacts.appImage !==
      getDesktopReleaseLinuxAppImageAssetName(metadata.version) ||
    linux.artifacts.deb !== getDesktopReleaseLinuxDebAssetName(metadata.version)
  ) {
    return false;
  }
  return [
    linux.artifacts.appImage,
    linux.artifacts.deb,
    linux.updaterMetadata,
  ].every((name) => findAsset(release.assets, name) !== undefined);
}

/**
 * ISS-12173: a publish deletes the live feed and then renames the staged one
 * over it. Between the two only the staged copy exists, and a read that listed
 * the live feed can find it deleted; the staged asset keeps its id through the
 * rename, so it answers in both cases. A listing taken before the staged
 * upload holds only the live id, so a 404 on the last listed feed re-lists the
 * channel once and reads from that.
 */
async function loadChannelFeedText(
  release: DesktopRelease,
  loadReleaseAssetText: LoadReleaseAssetText,
  reloadRelease: ReloadDesktopRelease | undefined,
  metadataAssetName: DesktopUpdaterMetadataAssetName = DesktopReleaseUpdaterMetadataAssetName
): Promise<string | null> {
  const assetNames =
    metadataAssetName === DesktopReleaseLinuxUpdaterMetadataAssetName
      ? DesktopReleaseLinuxUpdaterFeedAssetNames
      : DesktopReleaseUpdaterFeedAssetNames;
  const feedAssets = assetNames
    .map((name) => findAsset(release.assets, name))
    .filter((asset) => asset !== undefined);
  for (const [index, feedAsset] of feedAssets.entries()) {
    try {
      return await retryOnGitHubServerError(() =>
        loadReleaseAssetText(feedAsset)
      );
    } catch (error) {
      if (!GitHubNotFoundErrorSchema.safeParse(error).success) {
        throw error;
      }
      if (index === feedAssets.length - 1) {
        const relisted = await reloadRelease?.();
        if (!relisted) {
          throw error;
        }
        return await loadChannelFeedText(
          relisted,
          loadReleaseAssetText,
          undefined,
          metadataAssetName
        );
      }
    }
  }
  return null;
}

/**
 * ISS-12175: each GitHub call the updater feed makes is retried once,
 * immediately, on a 5xx; a 4xx is GitHub's answer and is rethrown.
 * @octokit/request 10 raises a network failure as status 500.
 *
 * Basis, Datadog APM `service:cl-api env:prod @http.host:api.github.com`,
 * 2026-09-09 to 10-08: 46 calls answered 5xx, and none was followed by another
 * 5xx before GitHub next succeeded. The 12 on the calls this feed makes
 * (release asset, installation lookup) were each followed by a 200 from the
 * same URL. 8 of the 46 saw a success within 0.3 s, so nothing measured
 * supports waiting before the retry, or retrying twice.
 *
 * Bounds: the slowest failed feed call took 48.3 s (installation lookup 503,
 * 2026-10-03) and a served feed is 1.8 s at p99 (27,925 requests, 30 days), so
 * a failure plus its retry is about 50 s. That fits electron-updater 6.8.7's
 * 60 s request timeout (builder-util-runtime 9.6.2 `httpExecutor.js`) and the
 * route's 300 s limit (api-prod `functionTimeout`).
 */
async function retryOnGitHubServerError<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const status = extractGitHubErrorStatus(error);
    if (status === null || status < 500) {
      throw error;
    }
    log.warn(
      "[github/electron-release] Retrying Desktop updater feed after a GitHub server error",
      { upstreamStatus: status }
    );
    return await read();
  }
}
