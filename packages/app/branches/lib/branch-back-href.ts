import { NavReferrerSurface } from "@repo/app/shared/lib/nav-referrer";

/**
 * Resolve the branch-detail "Back" target (FEA-4262). When the page was reached
 * via a session's cross-link (`?from=session`), Back returns to the referring
 * session list surface; otherwise it falls back to the surface's own static
 * branches back href.
 *
 * `from` is the already-validated referrer surface (see
 * `resolveNavReferrerSurface`) — an absent/unknown value keeps the static
 * `branchesHref`, so an arbitrary param can never redirect Back off-surface.
 * `sessionsHref` is the surface-specific session list href; when it is absent
 * (a shell that has no session list to return to) the static branches href is
 * used regardless of the referrer.
 */
export function resolveBranchBackHref({
  from,
  branchesHref,
  sessionsHref,
}: {
  from: NavReferrerSurface | undefined;
  branchesHref: string;
  sessionsHref?: string;
}): string {
  if (returnsToSessions(from, sessionsHref)) {
    return sessionsHref;
  }
  return branchesHref;
}

/** Labels for the branch-detail "Back" destination (breadcrumb + error links). */
export const BranchBackLabel = {
  Branches: "Branches",
  Sessions: "Sessions",
} as const;
export type BranchBackLabel =
  (typeof BranchBackLabel)[keyof typeof BranchBackLabel];

/**
 * The "Back" destination label paired with {@link resolveBranchBackHref} — the
 * two derive from the same referrer so the affordance's text always matches
 * where it goes (FEA-4262). When Back returns to the referring session list the
 * label is "Sessions"; otherwise it is the static "Branches".
 */
export function resolveBranchBackLabel({
  from,
  sessionsHref,
}: {
  from: NavReferrerSurface | undefined;
  sessionsHref?: string;
}): BranchBackLabel {
  if (returnsToSessions(from, sessionsHref)) {
    return BranchBackLabel.Sessions;
  }
  return BranchBackLabel.Branches;
}

/**
 * Whether the branch-detail "Back" affordance resolves to the referring session
 * list rather than the static branches list — the single predicate both the
 * href and the label derive from so they can never disagree.
 */
function returnsToSessions(
  from: NavReferrerSurface | undefined,
  sessionsHref: string | undefined
): sessionsHref is string {
  return from === NavReferrerSurface.Session && Boolean(sessionsHref);
}
