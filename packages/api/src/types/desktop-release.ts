import { z } from "zod";

export const DesktopReleaseOwner = "closedloop-ai" as const;
export const DesktopReleaseRepo = "closedloop-ai" as const;
/**
 * Public open-source repo the desktop installers are mirrored to so they can be
 * downloaded with no GitHub account (FEA-3372). The release itself still lives
 * in `DesktopReleaseRepo` and is still the source of truth for the updater feed
 * — only the installers are copied here, purely to give them a public URL.
 */
export const DesktopPublicMirrorRepo = "closedloop-ai" as const;
const AllowedDesktopReleaseDownloadRepos: ReadonlySet<string> = new Set([
  DesktopReleaseRepo,
  DesktopPublicMirrorRepo,
]);
export const DesktopReleaseRepository =
  `${DesktopReleaseOwner}/${DesktopReleaseRepo}` as const;
export const DesktopReleaseTagPrefix = "desktop-v" as const;
export const DesktopReleaseChannel = "desktop-latest" as const;
/**
 * PRD-707 FR1 / ISS-9165: the rolling release the twice-daily candidate build
 * publishes to, and the ONLY place a candidate's assets live.
 *
 * Deliberately not a versioned `desktop-v*` release: the public download route
 * ({@link https://github.com/closedloop-ai/closedloop-ai/blob/main/apps/api/app/electron-release/route.ts})
 * picks the newest VERSIONED release carrying {@link
 * DesktopReleaseMetadataAssetName}, ignores the prerelease flag, and fails closed
 * on a draft — so a versioned release cut at candidate time would put every
 * candidate on the download page. The versioned release is created at promotion,
 * by copying this release's assets.
 *
 * Only the candidate workflow writes this channel; only promotion writes {@link
 * DesktopReleaseChannel}.
 */
export const DesktopReleaseCandidateChannel = "desktop-candidate" as const;

/** Either mutable channel an updater request can be served from. */
export type DesktopReleaseChannelName =
  | typeof DesktopReleaseChannel
  | typeof DesktopReleaseCandidateChannel;
export const DesktopReleaseMetadataAssetName = "desktop-release.json" as const;
export const DesktopReleaseUpdaterMetadataAssetName = "latest-mac.yml" as const;
export const DesktopReleaseLinuxUpdaterMetadataAssetName =
  "latest-linux.yml" as const;
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
  /^Closed[Ll]oop-(?<version>(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))-universal-mac\.zip$/;
const DesktopReleaseUpdaterFeedFileUrlRegex =
  /^\s*-\s*url:\s*['"]?([^'"\s#]+)['"]?/gm;
const DesktopReleaseUpdaterFeedPathRegex = /^path:\s*['"]?([^'"\s#]+)['"]?/m;
const DesktopReleaseUpdaterFeedLegacyUrlRegex =
  /^url:\s*['"]?([^'"\s#]+)['"]?/m;
const DesktopReleaseUpdaterFeedVersionRegex =
  /^version:\s*['"]?([^'"\s#]+)['"]?/m;
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
  /**
   * @deprecated ISS-5434 removed the packaging gate from the release path, so
   * nothing emits this any more — the release job proves packaging by building
   * it. Retained rather than deleted under the AGENTS.md Compatibility
   * Guardrail: dropping a contract value needs explicit human approval, and
   * historical workflow runs still carry this string.
   * `desktop-release-preflight.test.ts` asserts it is now unreachable.
   */
  FailUnvalidatedPackaging: "fail_unvalidated_packaging",
  FailGitHubApiError: "fail_github_api_error",
} as const;
export type DesktopReleasePreflightStatus =
  (typeof DesktopReleasePreflightStatus)[keyof typeof DesktopReleasePreflightStatus];

/**
 * GitHub commit-status context the scheduled packaging validation (FEA-1935,
 * retargeted to the release target by ISS-5215) posts on a `main` SHA.
 *
 * ADVISORY / DETECTION ONLY since ISS-5434. It used to gate the release
 * (FEA-1936 preflight + FEA-1941 pre-check); it no longer does, and no code on
 * the release path reads it. Its consumers are now the per-episode main-health
 * alerter (`scripts/ci/main-health-alert.ts`) and the scheduled validator's own
 * target resolver (`scripts/deploy/desktop-packaging-target.ts`), both via
 * `scripts/deploy/desktop-validation-status.ts`.
 *
 * SSOT for the context string on the consumer side; the producing workflow
 * (`desktop-packaging-validation.yml`) pins the same literal, asserted equal by
 * `desktop-validation-status.test.ts`.
 */
export const DesktopPackagingValidationContext =
  "desktop-packaging/validated" as const;

/**
 * GitHub commit-status context the post-merge desktop TEST validation (FEA-2341)
 * posts on a `main` SHA. Produced now (FEA-3902) so the per-episode main-health
 * alerter (`scripts/ci/main-health-alert.ts`) can suppress duplicate red-streak
 * Slack pings; the release-gating consumer (mirroring FEA-1936 packaging) is a
 * tracked follow-up (FEA-3902 item 2b child FEA). It shares the generic
 * commit-status state vocabulary of {@link DesktopPackagingValidationState} — the
 * states are GitHub's own commit-status states, not packaging-specific — so no
 * parallel state enum is defined. The producing workflow
 * (`desktop-test-validation.yml`) pins the same literal, asserted equal by
 * `desktop-test-validation-workflow.test.ts`.
 */
export const DesktopTestValidationContext = "desktop-test/validated" as const;

/**
 * GitHub commit-status context the twice-daily Desktop CANDIDATE build
 * (PRD-707 FR2) posts on the candidate's commit.
 *
 * Distinct from {@link DesktopTestValidationContext} on purpose, and for the
 * same reason that one is distinct from the nightly macOS backstop below: this
 * verdict is about a SIGNED, NOTARIZED, PUBLISHED macOS package, not about a
 * suite. Sharing a context would let a Linux-lane green stand in for a signing
 * failure, which is the one thing the promotion gate must not accept.
 *
 * PRD-707 FR5 is its only consumer-to-be: promotion refuses a candidate whose
 * SHA does not carry this context as `success`. The producing workflow
 * (`desktop-candidate.yml`) pins the same literal, asserted equal by
 * `scripts/deploy/desktop-candidate-workflow-source.test.ts`.
 */
export const DesktopCandidateValidationContext =
  "desktop-candidate/validated" as const;

/**
 * GitHub commit-status context the NIGHTLY macOS `test:node` backstop (FEA-4224)
 * posts on a `main` SHA.
 *
 * Distinct from {@link DesktopTestValidationContext} on purpose: that backstop
 * runs on `linux_4_core_arm`, and both write a verdict for the SAME `main` SHA.
 * Sharing one context would make each lane's episode state overwrite the other's
 * — the macOS lane would read the Linux lane's green as its own parent and never
 * open, and a Linux red would be "recovered" by a macOS green. Desktop ships
 * macOS-only, so the two verdicts are about different things and need different
 * contexts.
 *
 * Its sibling `incident-thread` / `episode-announced` contexts are derived from
 * this prefix by `scripts/ci/main-health-status.ts`. The producing workflow
 * (`desktop-testnode-macos-nightly.yml`) pins the same literal, asserted equal by
 * `scripts/deploy/desktop-testnode-macos-report-shell.test.ts`.
 */
export const DesktopMacosTestNodeValidationContext =
  "desktop-testnode-macos/validated" as const;

/**
 * Resolved state of the `desktop-packaging/validated` commit status for a SHA.
 * `Success`/`Pending`/`Failure`/`Error` mirror GitHub's commit-status states;
 * `Missing` and `Unrecognized` are synthetic, for the two ways a read can end
 * with no state of GitHub's to report.
 *
 * `Unrecognized` is kept apart from `Error` because they are different facts and
 * a refusal built on them says different things (marisolashgrove, PR #6869). An
 * `error` is a lane REPORTING that it broke: decided, and naming its run URL
 * tells an operator where it broke. An unrecognized state string is this
 * reader failing to understand an answer it did receive — the lane may well be
 * green, so telling the operator it is red and handing them that same run URL
 * sends them to debug something that is not broken. Both still fail closed;
 * only the explanation differs.
 *
 * Both synthetic states are DELIBERATELY absent from the wire-state sets that
 * decide whether an incoming `state` string is one of GitHub's — a status whose
 * body literally said "missing" or "unrecognized" is not one of these, it is
 * itself unrecognized.
 *
 * ISS-5434: no release gate consumes this any more. The scheduled validator
 * treats `Success`/`Failure` as decided (anything else means "validate this
 * target"), and the main-health alerter uses the same notion for its ancestry
 * walk — but a non-`Success` state no longer blocks a release.
 */
export const DesktopPackagingValidationState = {
  Success: "success",
  Pending: "pending",
  Failure: "failure",
  Error: "error",
  Missing: "missing",
  Unrecognized: "unrecognized",
} as const;
export type DesktopPackagingValidationState =
  (typeof DesktopPackagingValidationState)[keyof typeof DesktopPackagingValidationState];

/**
 * Generic alias for the same value set, for consumers that resolve a commit
 * status independent of the packaging backstop — e.g. the shared per-episode
 * alert reducer (`scripts/ci/main-health-alert.ts`) that now drives BOTH the
 * `desktop-packaging/validated` and `desktop-test/validated` statuses. The
 * states are GitHub's own commit-status vocabulary (plus the synthetic
 * `missing`), so a generically-named import reads correctly in code with no
 * packaging-specific logic. Same object — not a copy — so there is one SSOT.
 */
export const GithubCommitStatusState = DesktopPackagingValidationState;
export type GithubCommitStatusState = DesktopPackagingValidationState;

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
export const DesktopReleasePlatformSchema = z.object({
  version: z.string().refine(isSupportedDesktopReleaseVersion),
  tagName: z.string().min(1),
  targetCommitish: z.string().min(1),
  artifacts: z.record(z.string(), z.string().min(1)),
  updaterMetadata: z.string().min(1),
});

export const DesktopReleasePlatformsMetadataSchema = z.object({
  owner: z.literal(DesktopReleaseOwner),
  repo: z.literal(DesktopReleaseRepo),
  version: z.string().refine(isSupportedDesktopReleaseVersion),
  tagName: z.string().min(1),
  channel: z.union([
    z.literal(DesktopReleaseChannel),
    z.literal(DesktopReleaseCandidateChannel),
  ]),
  targetCommitish: z.string().min(1),
  platforms: z.record(z.string(), DesktopReleasePlatformSchema).optional(),
});

export const DesktopReleaseMetadataSchema =
  DesktopReleasePlatformsMetadataSchema.extend({
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
 * Builds the public-mirror download URL for a version's DMG (FEA-3372) — the
 * login-free URL the release workflow writes into `downloadUrl` once the mirror
 * succeeds. Always the current "Closedloop-*" casing: the legacy "ClosedLoop-*"
 * assets predate the mirror and only ever existed on the private release repo.
 */
export function getPublicDesktopReleaseDownloadUrl(version: string): string {
  return buildDesktopReleaseAssetDownloadUrl(
    DesktopPublicMirrorRepo,
    version,
    getDesktopReleaseDmgAssetName(version)
  );
}

/**
 * Whether a release's `downloadUrl` is the right one for that release.
 *
 * The DMG is attached to the private release AND mirrored to the public repo so
 * it can be downloaded without a GitHub account (FEA-3372), so `downloadUrl`
 * legitimately points at a different repo than the release it hangs off. Exactly
 * two values are valid: the release's own DMG asset URL (what the workflow falls
 * back to when the mirror fails) or the public mirror URL for THIS EXACT
 * version. Anything else — a metadata/asset mismatch, or a URL for a different
 * version — is a mismatch.
 *
 * Both release-completeness checks share this: `isCompleteDesktopRelease` in
 * packages/github/electron-release.ts (which decides whether the app can resolve
 * a release at all) and `hasRequiredDesktopAssets` in
 * scripts/deploy/desktop-release-preflight.ts (which decides whether an existing
 * release is complete). They must agree — when this rule lived in both files
 * independently, updating only one of them was enough to break the other.
 */
export function isDesktopReleaseDownloadUrlForRelease(
  downloadUrl: string,
  releaseDmgAssetUrl: string,
  version: string
): boolean {
  return (
    downloadUrl === releaseDmgAssetUrl ||
    downloadUrl === getPublicDesktopReleaseDownloadUrl(version)
  );
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
 * Extracts the Desktop release version from a supported updater ZIP basename.
 */
export function getDesktopReleaseVersionFromUpdaterZipAssetName(
  assetName: string
): string | null {
  if (!isSafeDesktopReleaseAssetBasename(assetName)) {
    return null;
  }

  return (
    DesktopReleaseUpdaterZipAssetNameRegex.exec(assetName)?.groups?.version ??
    null
  );
}

/**
 * Extracts the current updater ZIP basename from an Electron latest-mac.yml feed.
 */
export function getDesktopReleaseUpdaterZipAssetNameFromFeed(
  feedText: string
): string | null {
  return getDesktopReleaseUpdaterAssetNameFromFeed(
    feedText,
    isDesktopReleaseUpdaterZipAssetName
  );
}

/** Extracts a safe updater artifact basename for a platform-specific allowlist. */
export function getDesktopReleaseUpdaterAssetNameFromFeed(
  feedText: string,
  isAccepted: (assetName: string) => boolean
): string | null {
  const candidates = [
    ...Array.from(
      feedText.matchAll(DesktopReleaseUpdaterFeedFileUrlRegex),
      (match) => match[1]
    ),
    DesktopReleaseUpdaterFeedPathRegex.exec(feedText)?.[1],
    DesktopReleaseUpdaterFeedLegacyUrlRegex.exec(feedText)?.[1],
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const zipAssetName = getDesktopReleaseUpdaterAssetNameFromCandidate(
      candidate,
      isAccepted
    );
    if (zipAssetName !== null) {
      return zipAssetName;
    }
  }

  return null;
}

/**
 * Extracts the current Desktop release version from an Electron latest-mac.yml
 * feed without trusting the feed to name a usable ZIP asset.
 */
export function getDesktopReleaseUpdaterVersionFromFeed(
  feedText: string
): string | null {
  const version = DesktopReleaseUpdaterFeedVersionRegex.exec(feedText)?.[1];
  return version !== undefined && isSupportedDesktopReleaseVersion(version)
    ? version
    : null;
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
 * Returns true only for active macOS Desktop DMG download URLs — either on the
 * private release repo (`DesktopReleaseRepo`) or on the public mirror the DMG is
 * copied to for login-free download (`DesktopPublicMirrorRepo`, FEA-3372).
 */
export function isAllowedDesktopReleaseDownloadUrl(
  candidateUrl: string
): boolean {
  const parts = parseDesktopReleaseDownloadUrl(candidateUrl);
  if (parts === null) {
    return false;
  }

  // Accept both the current "Closedloop-*" name and the pre-rename
  // "ClosedLoop-*" name during the brand-rename transition (FEA-2101) so
  // download URLs for already-published legacy assets keep validating.
  return isAcceptedDesktopReleaseDmgAssetName(parts.assetName, parts.version);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function getDesktopReleaseUpdaterAssetNameFromCandidate(
  candidate: string,
  isAccepted: (assetName: string) => boolean
): string | null {
  const decodedCandidate = safeDecodeURIComponent(candidate);
  if (decodedCandidate === null) {
    return null;
  }

  if (decodedCandidate.includes("/") || decodedCandidate.includes("\\")) {
    return null;
  }

  return isAccepted(decodedCandidate) ? decodedCandidate : null;
}

/**
 * Shape of a validated Desktop release asset download URL, once the host,
 * owner, repo, and tag have been checked but before any judgement about WHICH
 * asset the URL names.
 */
export type DesktopReleaseDownloadUrlParts = {
  version: string;
  assetName: string;
};

/**
 * Validates the SHAPE of a Desktop release asset download URL and returns the
 * release version and asset basename it names, or null when the URL is not a
 * Desktop release asset URL at all.
 *
 * Deliberately says nothing about which asset is acceptable — that is the
 * caller's, and therefore the platform's, decision. Extracted so every
 * per-platform download guard shares one host/owner/repo/tag/traversal check
 * instead of re-deriving it: `isAllowedDesktopReleaseDownloadUrl` (macOS DMG)
 * and `isAllowedDesktopReleaseWindowsDownloadUrl` (Windows installer,
 * `./desktop-release-windows.ts`) differ ONLY in their final asset-name test.
 */
export function parseDesktopReleaseDownloadUrl(
  candidateUrl: string
): DesktopReleaseDownloadUrlParts | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:") {
    return null;
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return null;
  }
  if (parsedUrl.hostname !== "github.com") {
    return null;
  }
  if (parsedUrl.search !== "" || parsedUrl.hash !== "") {
    return null;
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
  const decodedPathParts = pathParts.map((part) =>
    safeDecodeURIComponent(part)
  );
  if (decodedPathParts.some((part) => part === null)) {
    return null;
  }

  const [owner, repo, releasesSegment, downloadSegment, tagName, assetName] =
    decodedPathParts as [string, string, string, string, string, string];
  if (
    pathParts.length !== 6 ||
    owner !== DesktopReleaseOwner ||
    !AllowedDesktopReleaseDownloadRepos.has(repo) ||
    releasesSegment !== "releases" ||
    downloadSegment !== "download"
  ) {
    return null;
  }

  const version = getDesktopReleaseVersionFromTag(tagName);
  if (version === null) {
    return null;
  }

  if (
    assetName.includes("/") ||
    assetName.includes("\\") ||
    assetName.includes("..")
  ) {
    return null;
  }

  return { version, assetName };
}

/**
 * Builds a Desktop release asset download URL.
 *
 * The exact inverse of {@link parseDesktopReleaseDownloadUrl}, and extracted for
 * the same reason: the `github.com/<owner>/<repo>/releases/download/<tag>/<asset>`
 * construction is identical for every platform and every repo, so a per-platform
 * copy is a place for the two directions to drift apart. `repo` is a parameter
 * because the DMG and the Windows installer are each published to the private
 * release repo AND mirrored to the public one (FEA-3372).
 */
export function buildDesktopReleaseAssetDownloadUrl(
  repo: string,
  version: string,
  assetName: string
): string {
  return `https://github.com/${DesktopReleaseOwner}/${repo}/releases/download/${getDesktopReleaseTag(version)}/${assetName}`;
}

/**
 * Builds the rolling channel's release PAGE URL.
 *
 * Sibling of {@link buildDesktopReleaseAssetDownloadUrl}, and extracted for the
 * reason stated there: the `github.com/<owner>/<repo>/releases/...` construction
 * is identical everywhere, so a per-place copy is where the spellings drift
 * apart. `repo` is a parameter for the same reason too — the channel exists on
 * the private release repo AND on the public mirror (FEA-3372), and only the
 * mirror resolves for a reader with no access to the private one.
 *
 * Platform-neutral by construction, which is the point: unlike an asset URL it
 * names no artifact, so it is the correct link wherever the reader's platform is
 * not knowable (ISS-9708).
 */
export function buildDesktopReleaseChannelPageUrl(repo: string): string {
  return `https://github.com/${DesktopReleaseOwner}/${repo}/releases/tag/${DesktopReleaseChannel}`;
}

/**
 * Returns true only for a release asset basename that names a file and nothing
 * else: no path separator, no `..`, and no percent-encoding hiding either.
 *
 * Exported alongside {@link parseDesktopReleaseDownloadUrl} for the same reason
 * — it is the traversal half of what every per-platform asset-name guard owes,
 * and a platform that hand-rolls it inherits a weaker check than the macOS one.
 * Compose it before the platform's own pattern, as
 * `isDesktopReleaseUpdaterZipAssetName` and
 * `isDesktopReleaseWindowsInstallerAssetName` do.
 */
export function isSafeDesktopReleaseAssetBasename(assetName: string): boolean {
  return (
    assetName.length > 0 &&
    !assetName.includes("/") &&
    !assetName.includes("\\") &&
    !assetName.includes("..") &&
    safeDecodeURIComponent(assetName) === assetName
  );
}

/**
 * PRD-707 FR3 / ISS-9164: which release ring a desktop updater request resolves
 * to.
 *
 * Two rings, and since ISS-9165 they select DIFFERENT channels: `Internal` is
 * served {@link DesktopReleaseCandidateChannel}, `General` {@link
 * DesktopReleaseChannel}. D0 (ISS-9164) resolved and logged the ring while both
 * still pointed at `desktop-latest`, because a packaged signed build cannot
 * redirect its baked-in feed URL — a client carrying the compute-target header
 * has to ship and be promoted the ordinary way before any ring can mean
 * anything. That lead time is why the resolution landed a release cycle ahead of
 * the channel it now picks. {@link desktopReleaseChannelsForRing} is the mapping.
 *
 * `General` is the fail-safe answer, taken for an absent, unknown, or malformed
 * compute-target id and for any lookup failure. There is deliberately no third
 * "unknown" member: a ring is a channel selection, and a request that cannot be
 * attributed gets the channel every unattributed client already gets.
 */
export const DesktopReleaseRing = {
  Internal: "internal",
  General: "general",
} as const;

/** Literal union of the desktop release rings. */
export type DesktopReleaseRing =
  (typeof DesktopReleaseRing)[keyof typeof DesktopReleaseRing];

/**
 * The channels a resolved ring may be served from, in preference order.
 *
 * ORDER IS THE CONTRACT, and the fallback runs one way only. The internal ring
 * prefers the candidate and falls back to the promoted build when no candidate
 * is published; the general ring's list contains the promoted channel and
 * nothing else, so no lookup failure, empty channel, or future edit can walk a
 * customer onto a candidate. That asymmetry is why this is an ordered list per
 * ring rather than one channel plus a shared fallback step.
 *
 * The internal fallback is not a nicety. `desktop-candidate` does not exist
 * until the candidate workflow (PRD-707 FR2) first publishes it, and it is
 * legitimately re-pointed by hand when a candidate is bad (FR3 — there is no
 * hold mechanism). Without the fallback, every internal-ring install's updater
 * feed 404s in both of those windows.
 *
 * Backed by an exhaustive `Record` rather than a `switch` with a default or a
 * side list of "internal-ish" rings, so a third ring cannot compile until
 * someone states its channels.
 */
const DESKTOP_RELEASE_CHANNELS_BY_RING: Record<
  DesktopReleaseRing,
  readonly DesktopReleaseChannelName[]
> = {
  [DesktopReleaseRing.Internal]: [
    DesktopReleaseCandidateChannel,
    DesktopReleaseChannel,
  ],
  [DesktopReleaseRing.General]: [DesktopReleaseChannel],
};

export function desktopReleaseChannelsForRing(
  ring: DesktopReleaseRing
): readonly DesktopReleaseChannelName[] {
  return DESKTOP_RELEASE_CHANNELS_BY_RING[ring];
}

/**
 * The channels an updater ASSET request is resolved against — every request, in
 * this order, with no ring consulted.
 *
 * The asset leg cannot be ringed, and the reason is upstream of this repo's
 * choices (whitlockk, #7121). `registerUpdaterDownloadHeaderNarrowing` in
 * `apps/desktop/src/main/update/auto-update-wiring.ts` takes the compute-target
 * id back off `autoUpdater.requestHeaders` on `update-available`, synchronously,
 * before `downloadUpdate()` recomputes the download's headers — deliberately,
 * because the pinned `builder-util-runtime` forwards every header but
 * `authorization` across the cross-origin 302 the asset route answers with, and
 * carries no seam to add one. So the ZIP request that FOLLOWS a candidate feed
 * is always unattributed, always resolves to {@link DesktopReleaseRing.General},
 * and — served {@link desktopReleaseChannelsForRing}'s general list — would 404
 * the very candidate the internal ring had just been offered.
 *
 * Ringing the FEED is what keeps a candidate away from a customer, and it is
 * sufficient: a general install is never told a candidate version exists, so it
 * never asks for that ZIP. What this list gives up is only the stronger claim
 * that a candidate asset is unreachable by NAME, which an unauthenticated route
 * could never have held against a caller willing to guess a version anyway.
 *
 * Promoted FIRST so the ordinary download — every general install, and every
 * internal one on a promoted build — still resolves on one GitHub call, and only
 * an asset `desktop-latest` does not carry pays for the second.
 */
export const DesktopReleaseAssetChannels: readonly DesktopReleaseChannelName[] =
  [DesktopReleaseChannel, DesktopReleaseCandidateChannel];

/**
 * ISS-12173: the name a publish uploads the next feed under before swapping it
 * in. GitHub cannot replace an asset in place, so the publish deletes
 * {@link DesktopReleaseUpdaterMetadataAssetName} and renames this one over it.
 */
export const DesktopReleaseStagedUpdaterMetadataAssetName =
  "latest-mac.next.yml" as const;

/**
 * The assets the feed route reads a channel's feed from, in order. The staged
 * copy is read only while the live feed is absent: between a publish's delete
 * and rename, or after a publish that failed between the two.
 */
export const DesktopReleaseUpdaterFeedAssetNames = [
  DesktopReleaseUpdaterMetadataAssetName,
  DesktopReleaseStagedUpdaterMetadataAssetName,
] as const;
