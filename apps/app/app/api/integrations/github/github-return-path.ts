/**
 * Pure return-path validation for the GitHub connect flows — split from
 * `github-utils.ts` (PLN-1742 M3) so the Clerk linking page can import it
 * without dragging in that module's `node:crypto` cookie machinery.
 */

import { GitHubConnectReturnSegment } from "@repo/api/src/types/github-clerk-link";

const ENCODED_SEPARATOR_OR_DOT_PATTERN = /%(?:2e|2f|5c)/i;
const ENCODED_DOT_OR_BACKSLASH_PATTERN = /%(?:2e|5c)/i;
const CR_LF_OR_BACKSLASH_PATTERN = /[\r\n\\]/;

/**
 * The org-scoped destinations a GitHub connect may return to, derived from the
 * one cross-process list so this side and the desktop opener cannot drift
 * (ISS-5958). `branches` is in the set but never reached through it — the
 * branches arm below returns first, because it also owns the detail route.
 */
const SINGLE_SEGMENT_RETURN_PATHS: ReadonlySet<string> = new Set(
  Object.values(GitHubConnectReturnSegment)
);

/** Validate new OAuth return targets and canonicalize legacy Branch View input. */
export function getCanonicalBranchViewReturnPath(
  returnTo: string | null,
  options: { orgSlug?: string | null } = {}
): string | null {
  const compatiblePath = getCompatibleGitHubReturnPath(returnTo, options);
  if (!compatiblePath) {
    return null;
  }
  const [, orgSlug, firstSegment, branchArtifactId] = compatiblePath.split("/");
  return firstSegment === "build" && branchArtifactId
    ? `/${orgSlug}/branches/${branchArtifactId}`
    : compatiblePath;
}

/** Validate current targets while preserving signed legacy `/build` state. */
export function getCompatibleGitHubReturnPath(
  returnTo: string | null,
  options: { orgSlug?: string | null } = {}
): string | null {
  if (!returnTo || returnTo.length > 200) {
    return null;
  }
  const canonicalReturnTo = qualifyOrglessGitHubReturnPath(
    returnTo,
    options.orgSlug
  );
  if (
    CR_LF_OR_BACKSLASH_PATTERN.test(canonicalReturnTo) ||
    canonicalReturnTo.startsWith("//") ||
    canonicalReturnTo.includes("?") ||
    canonicalReturnTo.includes("#") ||
    canonicalReturnTo.startsWith("/api/")
  ) {
    return null;
  }
  const [, orgSlug, firstSegment, secondSegment, ...extra] =
    canonicalReturnTo.split("/");
  if (!isSafeBranchViewPathSegment(orgSlug)) {
    return null;
  }
  if (firstSegment === "branches") {
    if (secondSegment === undefined && extra.length === 0) {
      return `/${orgSlug}/branches`;
    }
    if (
      secondSegment !== undefined &&
      extra.length === 0 &&
      isSafeBranchDetailPathSegment(secondSegment)
    ) {
      return `/${orgSlug}/branches/${secondSegment}`;
    }
    return null;
  }
  if (
    firstSegment !== undefined &&
    SINGLE_SEGMENT_RETURN_PATHS.has(firstSegment) &&
    secondSegment === undefined &&
    extra.length === 0
  ) {
    return `/${orgSlug}/${firstSegment}`;
  }
  if (
    extra.length > 0 ||
    firstSegment !== "build" ||
    ENCODED_SEPARATOR_OR_DOT_PATTERN.test(canonicalReturnTo) ||
    !isSafeBranchViewPathSegment(secondSegment)
  ) {
    return null;
  }
  return `/${orgSlug}/build/${secondSegment}`;
}

function isSafeBranchViewPathSegment(
  value: string | null | undefined
): boolean {
  return Boolean(
    value &&
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("%")
  );
}

function isSafeBranchDetailPathSegment(value: string | undefined): boolean {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    ENCODED_DOT_OR_BACKSLASH_PATTERN.test(value)
  ) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded.length > 0 &&
      !CR_LF_OR_BACKSLASH_PATTERN.test(decoded) &&
      !decoded.split("/").some((segment) => segment === "." || segment === "..")
    );
  } catch {
    return false;
  }
}

function qualifyOrglessGitHubReturnPath(
  returnTo: string,
  orgSlug: string | null | undefined
): string {
  if (!isSafeBranchViewPathSegment(orgSlug)) {
    return returnTo;
  }
  const [, firstSegment, secondSegment, ...extra] = returnTo.split("/");
  if (
    firstSegment !== undefined &&
    SINGLE_SEGMENT_RETURN_PATHS.has(firstSegment) &&
    secondSegment === undefined &&
    extra.length === 0
  ) {
    return `/${orgSlug}/${firstSegment}`;
  }
  if (firstSegment !== "branches" || extra.length > 0) {
    return returnTo;
  }
  if (secondSegment === undefined) {
    return `/${orgSlug}/branches`;
  }
  if (isSafeBranchDetailPathSegment(secondSegment)) {
    return `/${orgSlug}/branches/${secondSegment}`;
  }
  return returnTo;
}
