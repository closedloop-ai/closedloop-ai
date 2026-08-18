import type { ComponentVersion } from "@repo/api/src/types/agent-component";

/**
 * Coerce a content-hash to a safe string, never throwing.
 *
 * The API contract types a content hash as `string` (`ComponentVersion.hash`,
 * `usageSessions[].versionHash`), but — exactly like the `sessionStartedAt`
 * crash fixed in #3208 — that value can reach the renderer as a non-string in
 * practice (a Liveblocks-deserialized value, a number, or any non-string on a
 * malformed / differently-shaped record). Calling `.slice` on a non-string then
 * throws a `TypeError`, and because the Agents component detail page renders
 * inside the top-level `LiveblocksErrorBoundary`, that throw is caught →
 * re-render → re-throw → crash-spiral that freezes the page (this is the class
 * of bug behind the Skill-component detail crash, FEA-3520).
 *
 * So we normalize every shape to a string: real strings pass through, other
 * primitives (number, bigint, boolean) are `String()`-coerced so a numeric hash
 * still yields a usable `#prefix`, and everything else (object/symbol/nullish)
 * collapses to "" so callers treat it as "no hash" rather than crashing.
 */
export function coerceHash(hash: unknown): string {
  if (typeof hash === "string") {
    return hash;
  }
  if (
    typeof hash === "number" ||
    typeof hash === "bigint" ||
    typeof hash === "boolean"
  ) {
    return String(hash);
  }
  return "";
}

/**
 * Compact display label for a content-hash revision, used by the detail
 * Sessions/Branches "Version" columns (FEA-2923). Versions arrive newest-first,
 * so the live revision reads "Current" and older ones number up from the oldest;
 * a hash with no matching revision falls back to a short `#prefix`.
 *
 * Returns null when there is no hash (unattributed usage) so the column can
 * render an em dash. `hash` (and each `versions[].hash` it is compared against)
 * is coerced defensively via {@link coerceHash} so a non-string runtime value
 * never throws.
 */
export function versionLabelForHash(
  hash: string | null | undefined,
  versions: readonly ComponentVersion[]
): string | null {
  const safeHash = coerceHash(hash);
  if (!safeHash) {
    return null;
  }
  const index = versions.findIndex((v) => coerceHash(v.hash) === safeHash);
  if (index === -1) {
    return `#${safeHash.slice(0, 7)}`;
  }
  return versions[index].isCurrent
    ? "Current"
    : `Rev ${versions.length - index}`;
}

/**
 * Build a `sessionId → version label` map from the detail's per-session usage
 * attribution + version history, for the Sessions-tab Version column.
 */
export function versionLabelBySession(
  usageSessions: readonly {
    sessionId: string;
    versionHash?: string | null;
  }[],
  versions: readonly ComponentVersion[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const usage of usageSessions) {
    const label = versionLabelForHash(usage.versionHash, versions);
    if (label !== null) {
      out.set(usage.sessionId, label);
    }
  }
  return out;
}

/**
 * Build a `branchName → version label` map from the per-session usage
 * attribution (each usage row carries the branch it ran on) + version history,
 * for the Branches-tab Version column. Best-effort: a branch's version is the
 * revision that ran in the session(s) attributed to that branch.
 */
export function versionLabelByBranch(
  usageSessions: readonly {
    branchName?: string | null;
    versionHash?: string | null;
  }[],
  versions: readonly ComponentVersion[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const usage of usageSessions) {
    if (!usage.branchName) {
      continue;
    }
    const label = versionLabelForHash(usage.versionHash, versions);
    if (label !== null && !out.has(usage.branchName)) {
      out.set(usage.branchName, label);
    }
  }
  return out;
}
