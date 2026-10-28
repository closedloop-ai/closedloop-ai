import { z } from "zod";
import {
  buildDesktopReleaseAssetDownloadUrl,
  DesktopPublicMirrorRepo,
  DesktopReleaseMetadataSchema,
  DesktopReleaseRepo,
  isSafeDesktopReleaseAssetBasename,
  parseDesktopReleaseDownloadUrl,
} from "./desktop-release.ts";

/**
 * Windows half of the Desktop release contract (PRD-685 / ISS-9637).
 *
 * Every value here is ADDITIVE to the contract in `./desktop-release.ts`: no
 * existing asset name, feed path, or metadata key changes, and the shared
 * `DesktopReleaseMetadataSchema` is deliberately NOT extended. Windows assets
 * ride along as extra keys on `assets`, which that schema — being a plain,
 * non-strict `z.object` — accepts and ignores. That is what lets an
 * already-installed macOS client on an older build parse a release published
 * with Windows assets and keep updating, and it is asserted directly against
 * the shipped schema in `desktop-release-windows.test.ts` rather than assumed.
 * PRD-684 owns generalizing the shared contract to be platform-keyed; when it
 * lands, this module is the Windows input to that generalization, not a second
 * design of it.
 *
 * Three things the contract deliberately does NOT carry, so a reader does not
 * go looking for them:
 *
 * - **Checksums.** Integrity for Windows updates is the per-file `sha512` that
 *   electron-builder writes into `latest.yml` and electron-updater verifies.
 *   This repo neither computes nor restates it, so re-declaring a checksum
 *   field here would be a second source of truth for a value we do not own.
 * - **Content types.** The installer is served to clients as a 302 redirect to
 *   GitHub object storage, exactly as the macOS updater ZIP is, so its content
 *   type is GitHub's. The only content type this repo emits on the update path
 *   is the updater feed's, which belongs to the serving route (compare
 *   `apps/api/app/desktop/updates/latest-mac.yml/route.ts`).
 * - **A pre-rename asset name.** The `ClosedLoop-*` compatibility alias in
 *   `./desktop-release.ts` exists because assets under that name were really
 *   published before FEA-2101. No Windows asset has ever been published under
 *   any name, so there is no legacy Windows spelling to accept and adding one
 *   would create a shim with nothing behind it.
 *
 * Consumers are the downstream work packages this issue unblocks: ISS-9641
 * (installer build) reads the asset names, ISS-9643 (release job and updater
 * feed) reads the names and writes {@link DesktopReleaseWindowsAssetsSchema},
 * and ISS-9651 (download control) reads
 * {@link resolveDesktopReleaseWindowsAvailability}.
 */

/**
 * Windows architectures the release contract can name.
 *
 * `x64` only. Windows ARM64 is PRD-685 FR14 and is blocked upstream: the
 * packaged runtime depends on `libsql`, which publishes no `win32-arm64`
 * prebuild, so an arm64 member here would name an artifact that cannot be
 * built. Add it in the same change that ships the build, so nothing can quietly
 * resolve to it first.
 */
export const DesktopReleaseWindowsArch = {
  X64: "x64",
} as const;
export type DesktopReleaseWindowsArch =
  (typeof DesktopReleaseWindowsArch)[keyof typeof DesktopReleaseWindowsArch];

export const DesktopReleaseWindowsInstallerAssetSuffix =
  `-${DesktopReleaseWindowsArch.X64}.exe` as const;

/**
 * electron-builder emits a `.blockmap` beside every NSIS installer, and
 * electron-updater fetches it to download only the changed ranges of a new
 * installer. Absence degrades to a full download rather than a failed update,
 * so this is a bandwidth contract, not a correctness one — but the release job
 * must publish it for differential updates to work at all.
 */
export const DesktopReleaseWindowsBlockmapAssetSuffix =
  `${DesktopReleaseWindowsInstallerAssetSuffix}.blockmap` as const;

/**
 * Feed basename electron-updater requests on Windows. This is the library's own
 * name for the Windows channel file — the macOS feed is `latest-mac.yml` and
 * Linux is `latest-linux.yml`, and Windows is the unsuffixed one. It is not a
 * name this repo is free to choose, so it is pinned as a literal in
 * {@link DesktopReleaseWindowsAssetsSchema}.
 */
export const DesktopReleaseWindowsUpdaterMetadataAssetName =
  "latest.yml" as const;

/**
 * Anchored, so a basename containing `/`, `\`, `..`, or an escape sequence
 * cannot match it — which makes it agree with, rather than replace, the shared
 * `isSafeDesktopReleaseAssetBasename` its guard composes first. Mirrors the
 * shape of `DesktopReleaseUpdaterZipAssetNameRegex` for the macOS ZIP.
 */
const DesktopReleaseWindowsInstallerAssetNameRegex =
  /^Closedloop-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-x64\.exe$/;

export const DesktopReleaseWindowsAvailabilityStatus = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type DesktopReleaseWindowsAvailabilityStatus =
  (typeof DesktopReleaseWindowsAvailabilityStatus)[keyof typeof DesktopReleaseWindowsAvailabilityStatus];

/**
 * Why a release cannot offer a Windows download. Both members render as
 * unavailable on the surface; they differ in whether anyone should be paged.
 *
 * - `NotPublished` is the ordinary case and the rollback case: a release that
 *   predates Windows, or one where the Windows job did not publish. Expected.
 * - `Malformed` is the producer-defect case, and covers BOTH shapes the
 *   resolver can meet: a release that claims Windows assets but does not
 *   describe this version's assets, AND metadata carrying no usable version or
 *   `assets` object at all (so no version is even in hand to check against).
 *   The second is deliberately not a third reason — a consumer's action is the
 *   same for both, and a release whose own metadata will not parse has no
 *   Windows download to offer either way. Neither arm depends on the macOS
 *   assets being well-formed; the platforms fail independently.
 */
export const DesktopReleaseWindowsUnavailableReason = {
  NotPublished: "not_published",
  Malformed: "malformed",
} as const;
export type DesktopReleaseWindowsUnavailableReason =
  (typeof DesktopReleaseWindowsUnavailableReason)[keyof typeof DesktopReleaseWindowsUnavailableReason];

/**
 * Additive Windows keys on `desktop-release.json`'s `assets` object.
 *
 * `windowsDownloadUrl` is carried rather than derived for the same reason the
 * macOS `downloadUrl` is: the installer is mirrored to the public repo so it can
 * be downloaded without a GitHub account (FEA-3372), and when that mirror step
 * fails the release job falls back to the private release asset URL. A derived
 * URL would name whichever one the producer did not actually publish, which is
 * the dead link this contract exists to prevent.
 */
export const DesktopReleaseWindowsAssetsSchema = z.object({
  windowsInstaller: z.string().min(1),
  windowsUpdaterMetadata: z.literal(
    DesktopReleaseWindowsUpdaterMetadataAssetName
  ),
  windowsDownloadUrl: z.string().min(1),
});

export type DesktopReleaseWindowsAssets = z.infer<
  typeof DesktopReleaseWindowsAssetsSchema
>;

/**
 * Presence probe for the additive block, derived from an exhaustive `Record`
 * over the schema's own keys so a key added to
 * {@link DesktopReleaseWindowsAssetsSchema} fails typecheck until it is named
 * here too. A hand-listed `string[]` would keep compiling and silently classify
 * a partially-written block as "not published" instead of malformed.
 *
 * Presence is `!== undefined`, so an explicit `windowsInstaller: null` COUNTS
 * as claiming Windows and lands on `malformed`, not `not_published`. That is
 * the AGENTS.md cross-repo rule enforced rather than accommodated: an absent
 * optional field is omitted, never serialized as `null`, unless the receiving
 * contract declares it nullable — and none of these three is. ISS-9643 writes
 * this block and has not been built yet, so nothing has ever published a null
 * here and holding the line costs no compatibility. Loosening this to `!= null`
 * would let a producer bug read as the ordinary "no Windows build" case and
 * silently hide it; `desktop-release-windows.test.ts` pins the null arm.
 */
const DesktopReleaseWindowsAssetKeyPresence: Record<
  keyof DesktopReleaseWindowsAssets,
  true
> = {
  windowsInstaller: true,
  windowsUpdaterMetadata: true,
  windowsDownloadUrl: true,
};
const DesktopReleaseWindowsAssetKeys = Object.keys(
  DesktopReleaseWindowsAssetKeyPresence
);

/**
 * Everything {@link resolveDesktopReleaseWindowsAvailability} reads off the
 * metadata: the release version, and the raw `assets` bag the Windows keys ride
 * on.
 *
 * Deliberately NOT `DesktopReleaseMetadataSchema` — that requires `assets.dmg`,
 * `assets.zip`, and `assets.updaterMetadata`, so gating Windows on it makes a
 * release with a perfect Windows block but a broken macOS asset resolve to
 * `malformed` for Windows too, pointing the on-call at the platform that is
 * fine. The two platforms fail independently. `version` is taken from the
 * shared schema's own shape so the accepted version format cannot drift from
 * the contract, and the Windows arm validates itself from there: the installer
 * name and the download URL are both checked against that version.
 */
const DesktopReleaseWindowsProbeSchema = z.object({
  version: DesktopReleaseMetadataSchema.shape.version,
  assets: z.record(z.string(), z.unknown()),
});

export type DesktopReleaseWindowsAvailability =
  | {
      status: typeof DesktopReleaseWindowsAvailabilityStatus.Available;
      version: string;
      installerAssetName: string;
      updaterMetadataAssetName: typeof DesktopReleaseWindowsUpdaterMetadataAssetName;
      downloadUrl: string;
    }
  | {
      status: typeof DesktopReleaseWindowsAvailabilityStatus.Unavailable;
      reason: DesktopReleaseWindowsUnavailableReason;
    };

/**
 * Builds the Windows installer asset name for a version.
 */
export function getDesktopReleaseWindowsInstallerAssetName(
  version: string
): string {
  return `Closedloop-${version}${DesktopReleaseWindowsInstallerAssetSuffix}`;
}

/**
 * Builds the differential-update blockmap asset name for a version.
 */
export function getDesktopReleaseWindowsBlockmapAssetName(
  version: string
): string {
  return `Closedloop-${version}${DesktopReleaseWindowsBlockmapAssetSuffix}`;
}

/**
 * Builds the Windows installer URL on the PRIVATE release repo — the fallback
 * the release job writes into `windowsDownloadUrl` when the public mirror step
 * fails.
 */
export function getDesktopReleaseWindowsInstallerAssetUrl(
  version: string
): string {
  return buildDesktopReleaseAssetDownloadUrl(
    DesktopReleaseRepo,
    version,
    getDesktopReleaseWindowsInstallerAssetName(version)
  );
}

/**
 * Builds the login-free public-mirror installer URL for a version — the
 * preferred `windowsDownloadUrl`, matching how the macOS DMG is offered.
 */
export function getPublicDesktopReleaseWindowsDownloadUrl(
  version: string
): string {
  return buildDesktopReleaseAssetDownloadUrl(
    DesktopPublicMirrorRepo,
    version,
    getDesktopReleaseWindowsInstallerAssetName(version)
  );
}

/**
 * Returns true only for a Windows installer asset basename.
 *
 * Version-free on purpose: the updater asset route validates a bare basename
 * off the URL with no release in hand, the same job
 * `getDesktopReleaseUpdaterZipAssetNameForAsset` does for macOS (ISS-10424 moved
 * the route off `isDesktopReleaseUpdaterZipAssetName` so a blockmap resolves
 * through the ZIP it describes).
 *
 * Composes `isSafeDesktopReleaseAssetBasename` before the pattern, as that
 * macOS sibling does. The two predicates agree on every input the anchored
 * pattern can see, so this rejects nothing new today; it is here so the shared
 * traversal check is what every platform guard is built from, rather than each
 * platform's pattern being separately trusted to imply it.
 */
export function isDesktopReleaseWindowsInstallerAssetName(
  assetName: string
): boolean {
  return (
    isSafeDesktopReleaseAssetBasename(assetName) &&
    DesktopReleaseWindowsInstallerAssetNameRegex.test(assetName)
  );
}

/**
 * Returns true only for an active Windows installer download URL, on either the
 * private release repo or the public mirror, whose tag version agrees with the
 * installer name it points at.
 *
 * The counterpart guard for macOS is `isAllowedDesktopReleaseDownloadUrl`, and
 * the two share one URL-shape parse. **They must stay mutually exclusive**: the
 * macOS guard also gates the managed-onboarding installer script, which mounts
 * what it is given as a disk image, so a Windows `.exe` accepted there would be
 * handed to `hdiutil`. `desktop-release-windows.test.ts` pins that boundary in
 * both directions.
 */
export function isAllowedDesktopReleaseWindowsDownloadUrl(
  candidateUrl: string
): boolean {
  const parts = parseDesktopReleaseDownloadUrl(candidateUrl);
  if (parts === null) {
    return false;
  }

  return (
    parts.assetName ===
    getDesktopReleaseWindowsInstallerAssetName(parts.version)
  );
}

/**
 * Resolves whether a release's metadata offers a Windows download, from the
 * unknown metadata shape a version-skewed client actually holds.
 *
 * Never constructs a URL for assets the producer did not publish: metadata with
 * no Windows block — a pre-Windows release, or a release the platform was rolled
 * back out of — resolves to `unavailable`, so the download surface can say the
 * platform is not available for that release instead of rendering a link that
 * 404s.
 */
export function resolveDesktopReleaseWindowsAvailability(
  metadata: unknown
): DesktopReleaseWindowsAvailability {
  const probe = DesktopReleaseWindowsProbeSchema.safeParse(metadata);
  if (!probe.success) {
    return unavailableWindowsRelease(
      DesktopReleaseWindowsUnavailableReason.Malformed
    );
  }

  const rawAssets = probe.data.assets;
  const claimsWindows = DesktopReleaseWindowsAssetKeys.some(
    (key) => rawAssets[key] !== undefined
  );
  if (!claimsWindows) {
    return unavailableWindowsRelease(
      DesktopReleaseWindowsUnavailableReason.NotPublished
    );
  }

  const windowsAssets = DesktopReleaseWindowsAssetsSchema.safeParse(rawAssets);
  if (!windowsAssets.success) {
    return unavailableWindowsRelease(
      DesktopReleaseWindowsUnavailableReason.Malformed
    );
  }

  const { version } = probe.data;
  const installerAssetName =
    getDesktopReleaseWindowsInstallerAssetName(version);
  const acceptedDownloadUrls = [
    getPublicDesktopReleaseWindowsDownloadUrl(version),
    getDesktopReleaseWindowsInstallerAssetUrl(version),
  ];
  if (
    windowsAssets.data.windowsInstaller !== installerAssetName ||
    !acceptedDownloadUrls.includes(windowsAssets.data.windowsDownloadUrl)
  ) {
    return unavailableWindowsRelease(
      DesktopReleaseWindowsUnavailableReason.Malformed
    );
  }

  return {
    status: DesktopReleaseWindowsAvailabilityStatus.Available,
    version,
    installerAssetName,
    updaterMetadataAssetName: DesktopReleaseWindowsUpdaterMetadataAssetName,
    downloadUrl: windowsAssets.data.windowsDownloadUrl,
  };
}

function unavailableWindowsRelease(
  reason: DesktopReleaseWindowsUnavailableReason
): DesktopReleaseWindowsAvailability {
  return {
    status: DesktopReleaseWindowsAvailabilityStatus.Unavailable,
    reason,
  };
}
