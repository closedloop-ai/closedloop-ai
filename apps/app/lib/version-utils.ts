import type { ComputeTarget } from "@repo/api/src/types/compute-target";

const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:[.-].*)?$/;
const VERSION_VALIDATION_REGEX = /^\d+\.\d+\.\d+(?:[.-].*)?$/;
const MAX_VERSION_LENGTH = 50;

/**
 * Compare two semver version strings.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 * Returns null if either input fails regex validation (cannot determine order).
 * Compares major, minor, and patch components numerically.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const matchA = SEMVER_REGEX.exec(a);
  const matchB = SEMVER_REGEX.exec(b);

  if (!(matchA && matchB)) {
    return null;
  }

  const [, aMajorStr, aMinorStr, aPatchStr] = matchA;
  const [, bMajorStr, bMinorStr, bPatchStr] = matchB;

  const aMajor = Number.parseInt(aMajorStr, 10);
  const aMinor = Number.parseInt(aMinorStr, 10);
  const aPatch = Number.parseInt(aPatchStr, 10);

  const bMajor = Number.parseInt(bMajorStr, 10);
  const bMinor = Number.parseInt(bMinorStr, 10);
  const bPatch = Number.parseInt(bPatchStr, 10);

  if (aMajor !== bMajor) {
    return aMajor < bMajor ? -1 : 1;
  }

  if (aMinor !== bMinor) {
    return aMinor < bMinor ? -1 : 1;
  }

  if (aPatch !== bPatch) {
    return aPatch < bPatch ? -1 : 1;
  }

  return 0;
}

/**
 * Returns true if latestVersion is strictly greater than currentVersion.
 * Returns false if currentVersion is undefined or versions are equal/current is newer.
 */
export function isUpdateAvailable(
  currentVersion: string | undefined,
  latestVersion: string
): boolean {
  if (!currentVersion) {
    return false;
  }

  return compareVersions(currentVersion, latestVersion) === -1;
}

/**
 * Extracts the plugin version from a ComputeTarget's capabilities object.
 * Returns undefined if not present, not a string, or empty.
 */
export function getPluginVersion(target: ComputeTarget): string | undefined {
  const capabilities = target.capabilities as Record<string, unknown>;
  const version = capabilities.pluginVersion;

  if (typeof version === "string" && version.length > 0) {
    return version;
  }

  return undefined;
}

/**
 * Validates and sanitizes a plugin version string.
 * Returns undefined if the version does not match semver format.
 * Truncates to 50 characters if longer.
 */
export function validatePluginVersion(
  version: string | undefined
): string | undefined {
  if (!version) {
    return undefined;
  }

  if (!VERSION_VALIDATION_REGEX.exec(version)) {
    return undefined;
  }

  return version.slice(0, MAX_VERSION_LENGTH);
}
