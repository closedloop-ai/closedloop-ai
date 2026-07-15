/**
 * Resolves the desktop OTel `service.version` resource attribute (FEA-2199).
 *
 * `service.version` was sourced directly from `app.getVersion()`, which is
 * unreliable outside a correctly-packaged app:
 *   - it returns Electron's empty-manifest sentinel `"0.0"` when the loaded app
 *     manifest has no resolvable version (e.g. an unpackaged `dist/main` launch
 *     by the E2E harness), and
 *   - it returns the ELECTRON runtime version for an unpackaged `pnpm dev` launch
 *     (the `39.8.10` bleed observed in Datadog).
 *
 * Shipping either verbatim poisons the per-version fleet slicing the dashboard
 * (PRD-484) depends on. This module makes the version trustworthy:
 *   - a build-time-baked version (`BUILD_APP_VERSION`, see scripts/write-build-info.mjs)
 *     is the authoritative source for a packaged build — the release workflow
 *     writes the minted `desktop-v*` version into package.json BEFORE the build,
 *     so the constant is immune to the runtime `app.getVersion()` quirks above;
 *   - a strict semver predicate (reusing the release-pipeline SSOT) rejects the
 *     `"0.0"` sentinel and the Electron-version bleed; and
 *   - a clearly-distinguishable sentinel buckets anything unresolved so the
 *     `version` facet can never read `"0.0"` again.
 */

import { isSupportedDesktopReleaseVersion } from "@repo/api/src/types/desktop-release";

/**
 * The value emitted when no usable version can be resolved. A valid
 * `major.minor.patch(-suffix)` string that is unmistakably NOT a real release
 * and, critically, never `"0.0"` — so a packaged build can never regress to the
 * polluting value, and any residual non-prod/misbuilt launch lands in one
 * obvious bucket.
 */
export const UNRESOLVED_DESKTOP_SERVICE_VERSION = "0.0.0-unknown";

export type IsUsableDesktopServiceVersionOptions = {
  /**
   * The Electron runtime version (`process.versions.electron`). An unpackaged
   * launch makes `app.getVersion()` return this; rejecting a value equal to it
   * filters the version bleed even though it is itself valid semver. Omitted (or
   * undefined) outside Electron (e.g. unit tests under Node), where there is no
   * Electron version to collide with.
   */
  electronVersion?: string;
};

/**
 * True when `version` is a supported desktop release semver AND is not the
 * Electron runtime version. `"0.0"` fails the semver check; the Electron version
 * is rejected explicitly.
 */
export function isUsableDesktopServiceVersion(
  version: string,
  { electronVersion }: IsUsableDesktopServiceVersionOptions = {}
): boolean {
  if (!isSupportedDesktopReleaseVersion(version)) {
    return false;
  }
  if (electronVersion && version === electronVersion) {
    return false;
  }
  return true;
}

export type ResolveDesktopServiceVersionInput = {
  /** Build-time-baked app version (authoritative for a packaged build). */
  buildVersion: string;
  /** Runtime `app.getVersion()` — the fallback when the build version is unusable. */
  runtimeVersion: string;
  /** `process.versions.electron`, used to reject the unpackaged version bleed. */
  electronVersion?: string;
  /**
   * Called when neither source yields a usable version. A packaged build
   * reaching this is a build defect (the minted version was not baked in), so it
   * is worth a warning signal — but telemetry must never crash its owner, so the
   * caller's logger is best-effort.
   */
  logWarning?: (message: string) => void;
};

/**
 * Returns the first usable version of `[buildVersion, runtimeVersion]`, else the
 * {@link UNRESOLVED_DESKTOP_SERVICE_VERSION} sentinel (logging a warning, since a
 * packaged build should always have a usable build version).
 */
export function resolveDesktopServiceVersion({
  buildVersion,
  runtimeVersion,
  electronVersion,
  logWarning,
}: ResolveDesktopServiceVersionInput): string {
  for (const candidate of [buildVersion, runtimeVersion]) {
    if (isUsableDesktopServiceVersion(candidate, { electronVersion })) {
      return candidate;
    }
  }
  logWarning?.(
    `Unresolved desktop service.version (build="${buildVersion}", runtime="${runtimeVersion}"); ` +
      `emitting "${UNRESOLVED_DESKTOP_SERVICE_VERSION}".`
  );
  return UNRESOLVED_DESKTOP_SERVICE_VERSION;
}
