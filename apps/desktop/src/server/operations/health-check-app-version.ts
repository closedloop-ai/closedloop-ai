import {
  APP_VERSION_CHECK_ID,
  APP_VERSION_CHECK_LABEL,
  CheckSeverity,
} from "@closedloop-ai/loops-api/compute-target";
import { BUILD_COMMIT_HASH } from "../../shared/build-info.js";
import type { GatewayCheckResult as CheckResult } from "./health-check-types.js";

/**
 * Gateway Version check (ISS-5369 Part 3).
 *
 * Two defects lived in the old `checkAppVersion`: it compared a locally-built
 * gateway against the published-release manifest — a category error, a dev
 * build is not an out-of-date release — and it reported the result as a
 * `required` failure, so "a newer release exists" blocked the command outright.
 *
 * This module answers "what build am I?" from data already on disk
 * (`app.isPackaged`, plus the build-time commit stamped by
 * `scripts/write-build-info.mjs`) and downgrades every version finding to a
 * non-blocking row. There is deliberately no minimum-version gate here: the
 * repo has no minimum-gateway-version requirement today, and inventing one
 * would be exactly the fabricated certainty this change removes. If one is ever
 * introduced it belongs in its own narrower check with its own message.
 */

const COMMIT_SHORT_HASH_LENGTH = 7;
const NUMERIC_ONLY_REGEX = /^\d+$/;

/**
 * What kind of gateway build is running.
 *
 * `Packaged` is intentionally NOT called "release": a packaged build produced
 * on a developer's machine is indistinguishable on disk from a published one,
 * so claiming "release" would assert more than the data supports. Version
 * comparison is meaningful for `Packaged` and meaningless for `Source`.
 */
export const GatewayBuildKind = {
  /** Running from source (`pnpm dev`) — `app.isPackaged === false`. */
  Source: "source",
  /** An Electron-packaged build. May or may not be a published release. */
  Packaged: "packaged",
  /** The build could not be classified; assert nothing about its version. */
  Unknown: "unknown",
} as const;
export type GatewayBuildKind =
  (typeof GatewayBuildKind)[keyof typeof GatewayBuildKind];

export function classifyGatewayBuild(
  isPackaged: boolean | undefined
): GatewayBuildKind {
  if (isPackaged === undefined) {
    return GatewayBuildKind.Unknown;
  }
  return isPackaged ? GatewayBuildKind.Packaged : GatewayBuildKind.Source;
}

export function parseStrictSemver(
  version: string
): [number, number, number] | undefined {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  const [majorStr, minorStr, patchStr] = parts;
  if (
    !(
      NUMERIC_ONLY_REGEX.test(majorStr) &&
      NUMERIC_ONLY_REGEX.test(minorStr) &&
      NUMERIC_ONLY_REGEX.test(patchStr)
    )
  ) {
    return undefined;
  }
  return [Number(majorStr), Number(minorStr), Number(patchStr)];
}

export function compareStrictSemver(
  installed: string,
  latest: string
): boolean | undefined {
  const installedTuple = parseStrictSemver(installed);
  const latestTuple = parseStrictSemver(latest);
  if (installedTuple === undefined || latestTuple === undefined) {
    return undefined;
  }
  for (let i = 0; i < 3; i++) {
    if (installedTuple[i] > latestTuple[i]) {
      return true;
    }
    if (installedTuple[i] < latestTuple[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Build the Gateway Version row.
 *
 * Every outcome is `required: false`. A version finding informs; it never
 * blocks the command the user is trying to run.
 */
export function checkAppVersion(
  currentVersion: string,
  latestVersion: string | undefined,
  buildKind: GatewayBuildKind = GatewayBuildKind.Unknown,
  commitHash: string = BUILD_COMMIT_HASH
): CheckResult {
  if (buildKind === GatewayBuildKind.Source) {
    // A source build answers "what build am I?" from its own commit stamp, so
    // it needs no release manifest and never compares against one.
    return buildSourceBuildResult(currentVersion, commitHash);
  }

  if (buildKind === GatewayBuildKind.Unknown) {
    // No release claim is supported for a build we could not classify: it may
    // not be in the published-release sequence at all, so "up to date" is as
    // unevidenced as "out of date", whichever way the numbers compare.
    return unverifiedAppVersionResult(currentVersion, latestVersion);
  }

  if (latestVersion === undefined) {
    // Packaged build, but the release manifest never arrived. The row still
    // reports the installed version; it just cannot compare it to anything.
    return unverifiedAppVersionResult(currentVersion, undefined);
  }

  const isUpToDate = compareStrictSemver(currentVersion, latestVersion);
  if (isUpToDate === undefined) {
    return unverifiedAppVersionResult(currentVersion, latestVersion);
  }

  if (isUpToDate) {
    return {
      ...baseAppVersionResult(currentVersion),
      severity: CheckSeverity.Passed,
    };
  }

  return {
    ...baseAppVersionResult(currentVersion),
    severity: CheckSeverity.Warning,
    error: `Update available: ${latestVersion}`,
    remediation: "Open the Closedloop Gateway app to update",
  };
}

/**
 * `passed: true` on every branch is deliberate. `passed` is the pre-ISS-5369
 * blocking signal that older web builds still read, and a version finding must
 * not block on any of them; `severity` carries the real state for builds that
 * understand it.
 */
function baseAppVersionResult(currentVersion: string): CheckResult {
  return {
    id: APP_VERSION_CHECK_ID,
    label: APP_VERSION_CHECK_LABEL,
    required: false,
    passed: true,
    version: currentVersion,
  };
}

/**
 * The row for a build whose version cannot be compared to a release: an
 * unclassifiable build, or a packaged build with no release manifest to compare
 * against. It states the installed version and stops there.
 */
function unverifiedAppVersionResult(
  currentVersion: string,
  latestVersion: string | undefined
): CheckResult {
  return {
    ...baseAppVersionResult(currentVersion),
    severity: CheckSeverity.Unknown,
    error: latestVersion
      ? `Version not verified (installed: ${currentVersion}, latest: ${latestVersion})`
      : `Version not verified (installed: ${currentVersion}, no release manifest)`,
  };
}

function buildSourceBuildResult(
  currentVersion: string,
  commitHash: string
): CheckResult {
  const shortHash = commitHash.slice(0, COMMIT_SHORT_HASH_LENGTH);
  const suffix = shortHash ? ` ${shortHash}` : "";
  return {
    ...baseAppVersionResult(currentVersion),
    severity: CheckSeverity.Passed,
    version: `${currentVersion} (local build${suffix})`,
  };
}
