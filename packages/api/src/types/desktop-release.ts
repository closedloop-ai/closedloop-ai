import { z } from "zod";

export const DesktopReleaseOwner = "closedloop-ai" as const;
export const DesktopReleaseRepo = "symphony-alpha" as const;
export const DesktopReleaseRepository =
  `${DesktopReleaseOwner}/${DesktopReleaseRepo}` as const;
export const DesktopReleaseTagPrefix = "desktop-v" as const;
export const DesktopReleaseChannel = "desktop-latest" as const;
export const DesktopReleaseMetadataAssetName = "desktop-release.json" as const;
export const DesktopReleaseUpdaterMetadataAssetName = "latest-mac.yml" as const;
export const DesktopReleaseDmgAssetSuffix = "-universal.dmg" as const;
export const DesktopReleaseZipAssetSuffix = "-universal-mac.zip" as const;
const DesktopReleaseVersionRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Brand rename transition (FEA-2101): the desktop product name changed from the
// PascalCase "ClosedLoop" to "Closedloop", so release assets are named
// "Closedloop-<version>-…" going forward. Assets published BEFORE the rename are
// named "ClosedLoop-<version>-…" and still live on the `desktop-latest` channel.
// Consumer guards below must accept BOTH casings during the transition so
// in-flight auto-updates from already-published `ClosedLoop-*` assets keep
// resolving. `Closed[Ll]oop` matches the single-letter casing difference. The
// legacy form is removed in a follow-up (FEA-2107) once no `ClosedLoop-*` assets
// remain on the channel.
const DesktopReleaseUpdaterZipAssetNameRegex =
  /^Closed[Ll]oop-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-universal-mac\.zip$/;
const DesktopReleaseUpdaterFeedFileUrlRegex =
  /^\s*-\s*url:\s*['"]?([^'"\s#]+)['"]?/m;
const DesktopReleaseUpdaterFeedPathRegex = /^path:\s*['"]?([^'"\s#]+)['"]?/m;
const DesktopReleaseUpdaterFeedLegacyUrlRegex =
  /^url:\s*['"]?([^'"\s#]+)['"]?/m;
const AllowedDesktopReleaseAssetRedirectHosts = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export const DesktopReleasePreflightStatus = {
  PublishRequiredMissingRelease: "publish_required_missing_release",
  SkipExistingCompleteCurrent: "skip_existing_complete_current",
  FailExistingDraft: "fail_existing_draft",
  FailPartialAssets: "fail_partial_assets",
  FailWrongTarget: "fail_wrong_target",
  FailMalformedMetadata: "fail_malformed_metadata",
  FailNonDesktopReleaseSelected: "fail_non_desktop_release_selected",
  FailUnvalidatedPackaging: "fail_unvalidated_packaging",
  FailGitHubApiError: "fail_github_api_error",
} as const;
export type DesktopReleasePreflightStatus =
  (typeof DesktopReleasePreflightStatus)[keyof typeof DesktopReleasePreflightStatus];

/**
 * GitHub commit-status context the post-merge packaging validation (FEA-1935)
 * posts on a `main` SHA, and the release preflight gate (FEA-1936) reads. SSOT
 * for the context string on the consumer side; the producing workflow
 * (`desktop-packaging-validation.yml`) pins the same literal, asserted equal by
 * `desktop-release-preflight.test.ts`.
 */
export const DesktopPackagingValidationContext =
  "desktop-packaging/validated" as const;

/**
 * Resolved state of the `desktop-packaging/validated` commit status for a SHA.
 * `Success`/`Pending`/`Failure`/`Error` mirror GitHub's commit-status states;
 * `Missing` is the synthetic state for a SHA carrying no such status. The
 * release gate fails closed on every state except `Success`.
 */
export const DesktopPackagingValidationState = {
  Success: "success",
  Pending: "pending",
  Failure: "failure",
  Error: "error",
  Missing: "missing",
} as const;
export type DesktopPackagingValidationState =
  (typeof DesktopPackagingValidationState)[keyof typeof DesktopPackagingValidationState];

/**
 * Returns true only when a SHA's packaging-validation status is `success`. The
 * release preflight gate treats every other state (pending/failure/error/
 * missing) as not releasable (fail closed) per PRD-470 Q-005.
 */
export function isDesktopPackagingValidated(
  state: DesktopPackagingValidationState
): boolean {
  return state === DesktopPackagingValidationState.Success;
}

/**
 * Validates the Desktop release metadata asset shared by release producers and
 * consumers.
 */
export const DesktopReleaseMetadataSchema = z.object({
  owner: z.literal(DesktopReleaseOwner),
  repo: z.literal(DesktopReleaseRepo),
  version: z.string().refine(isSupportedDesktopReleaseVersion),
  tagName: z.string().min(1),
  channel: z.literal(DesktopReleaseChannel),
  targetCommitish: z.string().min(1),
  assets: z.object({
    dmg: z.string().min(1),
    zip: z.string().min(1),
    updaterMetadata: z.literal(DesktopReleaseUpdaterMetadataAssetName),
  }),
  downloadUrl: z.string().min(1),
});

export type DesktopReleaseMetadata = z.infer<
  typeof DesktopReleaseMetadataSchema
>;

/**
 * Builds the Desktop-only GitHub Release tag used by producers and consumers.
 */
export function getDesktopReleaseTag(version: string): string {
  return `${DesktopReleaseTagPrefix}${version}`;
}

/**
 * Builds the Desktop DMG asset name for the supported macOS universal build.
 */
export function getDesktopReleaseDmgAssetName(version: string): string {
  return `Closedloop-${version}${DesktopReleaseDmgAssetSuffix}`;
}

/**
 * Builds the pre-rename Desktop DMG asset name ("ClosedLoop-<version>-…").
 * Used only by the transition consumer guards (the download-URL guard and the
 * release-completeness check in packages/github/electron-release.ts) during the
 * brand-rename transition (FEA-2101) so already-published `ClosedLoop-*` release
 * assets remain resolvable. Producers always emit the current name above; this
 * is removed once no legacy assets remain on `desktop-latest` (FEA-2107).
 */
export function getDesktopReleaseLegacyDmgAssetName(version: string): string {
  return `ClosedLoop-${version}${DesktopReleaseDmgAssetSuffix}`;
}

/**
 * Builds the Desktop ZIP asset name for the supported macOS universal build.
 */
export function getDesktopReleaseZipAssetName(version: string): string {
  return `Closedloop-${version}${DesktopReleaseZipAssetSuffix}`;
}

/**
 * Builds the pre-rename Desktop ZIP asset name ("ClosedLoop-<version>-…").
 * Transition-only counterpart to {@link getDesktopReleaseLegacyDmgAssetName}
 * (FEA-2101); removed alongside it (FEA-2107).
 */
export function getDesktopReleaseLegacyZipAssetName(version: string): string {
  return `ClosedLoop-${version}${DesktopReleaseZipAssetSuffix}`;
}

/**
 * Returns true when `assetName` is the DMG asset name for `version` in either
 * the current "Closedloop-*" form or the pre-rename "ClosedLoop-*" form. Single
 * source of truth for the dual-casing acceptance the brand-rename transition
 * (FEA-2101) requires across every consumer guard; remove the legacy arm in
 * FEA-2107.
 */
export function isAcceptedDesktopReleaseDmgAssetName(
  assetName: string,
  version: string
): boolean {
  return (
    assetName === getDesktopReleaseDmgAssetName(version) ||
    assetName === getDesktopReleaseLegacyDmgAssetName(version)
  );
}

/**
 * Returns true when `assetName` is the ZIP asset name for `version` in either
 * the current "Closedloop-*" form or the pre-rename "ClosedLoop-*" form. See
 * {@link isAcceptedDesktopReleaseDmgAssetName} (FEA-2101 transition; FEA-2107).
 */
export function isAcceptedDesktopReleaseZipAssetName(
  assetName: string,
  version: string
): boolean {
  return (
    assetName === getDesktopReleaseZipAssetName(version) ||
    assetName === getDesktopReleaseLegacyZipAssetName(version)
  );
}

/**
 * Returns true when a Desktop metadata version is in the supported semver form.
 */
export function isSupportedDesktopReleaseVersion(version: string): boolean {
  return DesktopReleaseVersionRegex.test(version);
}

/**
 * Extracts the supported Desktop semver from a versioned Desktop release tag.
 */
export function getDesktopReleaseVersionFromTag(
  tagName: string
): string | null {
  if (!tagName.startsWith(DesktopReleaseTagPrefix)) {
    return null;
  }

  const version = tagName.slice(DesktopReleaseTagPrefix.length);
  return isSupportedDesktopReleaseVersion(version) ? version : null;
}

/**
 * Returns true when the tag is a selectable versioned Desktop release tag.
 */
export function isVersionedDesktopReleaseTag(tagName: string): boolean {
  return getDesktopReleaseVersionFromTag(tagName) !== null;
}

/**
 * Numeric parts of a supported Desktop release version.
 */
export type DesktopReleaseVersionParts = {
  major: number;
  minor: number;
  patch: number;
};

/**
 * Parses a supported Desktop release version into numeric parts, or null when
 * it is not a supported `major.minor.patch` semver.
 */
export function parseDesktopReleaseVersion(
  version: string
): DesktopReleaseVersionParts | null {
  if (!isSupportedDesktopReleaseVersion(version)) {
    return null;
  }
  const [major, minor, patch] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return { major, minor, patch };
}

/**
 * Returns the `major.minor` release *series* for a version (e.g. "0.16"), or
 * null when the version is not supported. Under release-time version assignment
 * (PRD-470), `apps/desktop/package.json` declares only the series; the release
 * workflow assigns the patch from the `desktop-v*` tag history.
 */
export function getDesktopReleaseSeries(version: string): string | null {
  const parts = parseDesktopReleaseVersion(version);
  if (parts === null) {
    return null;
  }
  return `${parts.major}.${parts.minor}`;
}

/**
 * Returns the highest supported Desktop release version from a list, or null
 * when the list contains no supported version. Used at release time to pick the
 * version a SHA ships: the highest `desktop-v*` tag reachable from the target
 * commit (FEA-2135 — the patch is minted as a tag at merge time, so the release
 * reads it rather than deriving a fresh number).
 */
export function getHighestDesktopReleaseVersion(
  versions: string[]
): string | null {
  let highest: { version: string; parts: DesktopReleaseVersionParts } | null =
    null;
  for (const candidate of versions) {
    const parts = parseDesktopReleaseVersion(candidate);
    if (parts === null) {
      continue;
    }
    if (
      highest === null ||
      parts.major > highest.parts.major ||
      (parts.major === highest.parts.major &&
        parts.minor > highest.parts.minor) ||
      (parts.major === highest.parts.major &&
        parts.minor === highest.parts.minor &&
        parts.patch > highest.parts.patch)
    ) {
      highest = { version: candidate, parts };
    }
  }
  return highest === null ? null : highest.version;
}

/**
 * Resolves the next Desktop version, keyed to the target SHA for idempotency.
 *
 * `apps/desktop/package.json` declares the `major.minor` series anchor and a
 * patch FLOOR; the next patch is `max(highest ledger patch in the series + 1,
 * anchor patch)`, so customer-facing versions increment without reusing a
 * number. Under FEA-2135 this runs at **merge time** to mint the
 * `desktop-v<next>` tag (the counter lives in the tag/release ledger);
 * `releasedVersions` is therefore the union of published releases and existing
 * `desktop-v*` tags so two merges never compute the same patch.
 *
 * The anchor patch as a floor (FEA-2156) does double duty: a fresh series anchor
 * (e.g. `0.17.0`) starts the series at its own patch, and a deliberately-raised
 * anchor (e.g. `0.16.71`) keeps the auto-mint above a high-water mark the ledger
 * has not yet reached — guarding against re-issuing a number an earlier `main`
 * commit already carried in the manifest.
 *
 * Idempotency (FEA-1936): when the target SHA already carries a release tag
 * (`shaReleasedVersion`), that exact version is reused so re-running on a
 * tagged SHA does not mint a fresh number for byte-identical code.
 */
export function resolveDesktopReleaseVersion(input: {
  seriesVersion: string;
  releasedVersions: string[];
  shaReleasedVersion: string | null;
}): { version: string } | { error: string } {
  if (
    input.shaReleasedVersion !== null &&
    isSupportedDesktopReleaseVersion(input.shaReleasedVersion)
  ) {
    return { version: input.shaReleasedVersion };
  }

  const series = parseDesktopReleaseVersion(input.seriesVersion);
  if (series === null) {
    return {
      error: `Desktop series anchor "${input.seriesVersion}" is not a supported major.minor.patch version.`,
    };
  }

  let maxPatch = -1;
  let highestMajor = series.major;
  let highestMinor = series.minor;
  for (const candidate of input.releasedVersions) {
    const parts = parseDesktopReleaseVersion(candidate);
    if (parts === null) {
      continue;
    }
    if (
      parts.major > highestMajor ||
      (parts.major === highestMajor && parts.minor > highestMinor)
    ) {
      highestMajor = parts.major;
      highestMinor = parts.minor;
    }
    if (
      parts.major === series.major &&
      parts.minor === series.minor &&
      parts.patch > maxPatch
    ) {
      maxPatch = parts.patch;
    }
  }

  // Fail closed if the anchor series is behind the highest released series:
  // deriving a lower series here would publish a release/feed promotion that
  // *downgrades* the channel (e.g. anchor 0.16 while 0.17.x already shipped).
  // The anchor must be advanced deliberately before such a release (Codex P2).
  if (highestMajor !== series.major || highestMinor !== series.minor) {
    return {
      error: `Desktop series anchor ${series.major}.${series.minor} is behind the highest released series ${highestMajor}.${highestMinor}; refusing to derive a lower release series (would downgrade the channel). Advance the apps/desktop/package.json anchor first.`,
    };
  }

  // Floor the next patch at the anchor's own patch (FEA-2156). The anchor patch
  // is the release FLOOR: the next version is never below it, even when the
  // tag/release ledger is lower. This both preserves "start a fresh series at
  // its anchor patch" (e.g. anchor 0.17.0 with no 0.17 releases → 0.17.0) and
  // lets the anchor act as a deliberate one-time floor/override — e.g. setting
  // 0.16.71 makes the next release 0.16.71 even though the ledger only reached
  // 0.16.47, so the auto-mint can never re-issue a number an earlier `main`
  // commit already carried in apps/desktop/package.json (which had climbed to
  // 0.16.70 before this control existed). Once the ledger passes the floor, the
  // contiguous +1 leads again.
  const nextPatch = Math.max(maxPatch + 1, series.patch);
  return { version: `${series.major}.${series.minor}.${nextPatch}` };
}

/**
 * Returns true only for the supported macOS updater ZIP asset basename.
 */
export function isDesktopReleaseUpdaterZipAssetName(
  assetName: string
): boolean {
  return (
    isSafeDesktopReleaseAssetBasename(assetName) &&
    DesktopReleaseUpdaterZipAssetNameRegex.test(assetName)
  );
}

/**
 * Extracts the current updater ZIP basename from an Electron latest-mac.yml feed.
 */
export function getDesktopReleaseUpdaterZipAssetNameFromFeed(
  feedText: string
): string | null {
  const candidates = [
    DesktopReleaseUpdaterFeedFileUrlRegex.exec(feedText)?.[1],
    DesktopReleaseUpdaterFeedPathRegex.exec(feedText)?.[1],
    DesktopReleaseUpdaterFeedLegacyUrlRegex.exec(feedText)?.[1],
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const zipAssetName =
      getDesktopReleaseUpdaterZipAssetNameFromCandidate(candidate);
    if (zipAssetName !== null) {
      return zipAssetName;
    }
  }

  return null;
}

/**
 * Extracts the current updater ZIP basename from desktop-release.json
 * metadata, validating the unknown metadata shape with Zod.
 */
export function getDesktopReleaseUpdaterZipAssetNameFromMetadata(
  metadata: unknown
): string | null {
  const parsed = DesktopReleaseMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return null;
  }

  const zipAssetName = parsed.data.assets.zip;
  return isDesktopReleaseUpdaterZipAssetName(zipAssetName)
    ? zipAssetName
    : null;
}

/**
 * Returns true only for short-lived GitHub object URLs suitable for redirecting
 * updater ZIP requests.
 */
export function isAllowedDesktopReleaseAssetRedirectUrl(
  candidateUrl: string
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return false;
  }

  if (parsedUrl.protocol !== "https:") {
    return false;
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return false;
  }
  if (!AllowedDesktopReleaseAssetRedirectHosts.has(parsedUrl.hostname)) {
    return false;
  }
  if (parsedUrl.pathname === "" || parsedUrl.pathname === "/") {
    return false;
  }

  return parsedUrl.hash === "";
}

/**
 * Returns true only for active macOS Desktop release assets in symphony-alpha.
 */
export function isAllowedDesktopReleaseDownloadUrl(
  candidateUrl: string
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return false;
  }

  if (parsedUrl.protocol !== "https:") {
    return false;
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return false;
  }
  if (parsedUrl.hostname !== "github.com") {
    return false;
  }
  if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
    return false;
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  const decodedPathParts = pathParts.map((part) =>
    safeDecodeURIComponent(part)
  );
  if (decodedPathParts.some((part) => part === null)) {
    return false;
  }

  const [owner, repo, releasesSegment, downloadSegment, tagName, assetName] =
    decodedPathParts as [string, string, string, string, string, string];
  if (
    pathParts.length !== 6 ||
    owner !== DesktopReleaseOwner ||
    repo !== DesktopReleaseRepo ||
    releasesSegment !== "releases" ||
    downloadSegment !== "download"
  ) {
    return false;
  }

  const version = getDesktopReleaseVersionFromTag(tagName);
  if (version === null) {
    return false;
  }

  if (
    assetName.includes("/") ||
    assetName.includes("\\") ||
    assetName.includes("..")
  ) {
    return false;
  }

  // Accept both the current "Closedloop-*" name and the pre-rename
  // "ClosedLoop-*" name during the brand-rename transition (FEA-2101) so
  // download URLs for already-published legacy assets keep validating.
  return isAcceptedDesktopReleaseDmgAssetName(assetName, version);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function getDesktopReleaseUpdaterZipAssetNameFromCandidate(
  candidate: string
): string | null {
  const decodedCandidate = safeDecodeURIComponent(candidate);
  if (decodedCandidate === null) {
    return null;
  }

  if (decodedCandidate.includes("/") || decodedCandidate.includes("\\")) {
    return null;
  }

  return isDesktopReleaseUpdaterZipAssetName(decodedCandidate)
    ? decodedCandidate
    : null;
}

function isSafeDesktopReleaseAssetBasename(assetName: string): boolean {
  return (
    assetName.length > 0 &&
    !assetName.includes("/") &&
    !assetName.includes("\\") &&
    !assetName.includes("..") &&
    safeDecodeURIComponent(assetName) === assetName
  );
}
