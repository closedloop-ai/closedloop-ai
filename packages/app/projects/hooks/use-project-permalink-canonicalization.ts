"use client";

import { useNavigation } from "@repo/navigation/use-navigation";
import { useEffect, useRef } from "react";

/**
 * Reconciliation for a project permalink whose TEAM segment has gone stale
 * (ISS-8588).
 *
 * A project detail URL embeds `teamId`, a mutable ancestor: `projectId` is
 * stable, but `ProjectTeam` rows come and go, and deleting a team cascades
 * them. `GET /projects/:id` is org-scoped, so the project still resolves; the
 * team half of the page is what fails, tripping the route's `!team` guard into
 * "Project not found" over a project that exists.
 *
 * The destination is NOT computable from the URL — it depends on the project
 * RECORD's current team set. That is why this does not live in
 * `apps/app/lib/app-route-redirects.ts` beside the `/features` → `/issues`
 * rename: that module runs in the proxy, which has no database access and must
 * not grow a per-request API fetch on every project page view. Same kind of
 * decision, resolved one layer later, where the data is; kept in a leaf module
 * for the same reason that one is, so it is testable without mounting a route.
 */
export type ProjectPermalinkLocation = {
  orgSlug: string | null;
  projectHref?: (teamId: string, projectId: string) => string;
  /** The `teamId` segment the caller's URL actually carries. */
  requestedTeamId: string;
  projectId: string;
  /**
   * The project's CURRENT team ids, or `null` while the project read has not
   * settled.
   *
   * `null` and `[]` are deliberately different answers. `null` is "not known
   * yet" and must not move anyone; `[]` is a settled project that belongs to no
   * team at all, which has no canonical location to offer — inventing one would
   * send the reader somewhere the record does not live.
   */
  projectTeamIds: readonly string[] | null;
  /** Serialized query of the incoming URL, without the leading `?`. */
  search: string;
};

/**
 * The path (plus query) this permalink should be canonicalized to, or `null`
 * when no redirect is warranted.
 *
 * Every `null` leaves the route rendering whatever it would otherwise render,
 * including its genuine not-found: answering with a path for an unknown project
 * would turn "this record does not exist" into a redirect to a fabricated
 * destination, a worse failure than the 404 it replaced.
 *
 * The loop guard is structural, not a comparison bolted on at the end. A
 * destination is only minted from a team id the requested one is NOT among, so
 * the path returned always differs from the path that produced it, and the URL
 * it lands on satisfies the membership check and resolves `null` next pass.
 */
export function resolveProjectPermalinkRedirect(
  location: ProjectPermalinkLocation
): string | null {
  const { orgSlug, requestedTeamId, projectId, projectTeamIds } = location;

  // Without all three the destination cannot be built at all. `orgSlug` is null
  // mid-hydration; emitting `//teams/...` there would be a protocol-relative
  // path pointing off-origin.
  if (!((orgSlug || location.projectHref) && requestedTeamId && projectId)) {
    return null;
  }

  // Unsettled read, or a project with no team: no canonical location to name.
  if (!projectTeamIds?.length) {
    return null;
  }

  // The URL already names a team the project belongs to. This is the common
  // case and the terminal state of any redirect this function issues.
  if (projectTeamIds.includes(requestedTeamId)) {
    return null;
  }

  const canonicalTeamId = projectTeamIds[0];
  const path =
    location.projectHref?.(canonicalTeamId, projectId) ??
    `/${orgSlug}/teams/${canonicalTeamId}/projects/${projectId}`;
  return location.search ? `${path}?${location.search}` : path;
}

/**
 * Re-attach the caller's fragment to a resolved destination.
 *
 * A fragment is never transmitted to the server, so an HTTP 3xx preserves it
 * only because the browser re-applies it. A client-side history replacement has
 * no such rule — the fragment is dropped unless it is carried explicitly, which
 * would silently strand exactly the deep links (`#section`) this ticket exists
 * to keep working.
 */
export function appendLocationHash(href: string, hash: string): string {
  if (!hash || href.includes("#")) {
    return href;
  }
  return hash.startsWith("#") ? `${href}${hash}` : `${href}#${hash}`;
}

/**
 * The project's current team ids in the shape
 * {@link resolveProjectPermalinkRedirect} consumes, or `null` when the read has
 * not settled.
 *
 * Typed structurally rather than against `ProjectWithDetails` so this module
 * stays a leaf. `teams` is optional here on purpose: it is a WIRE field on an
 * HTTP response, so an older API deploy that omits it must degrade to "don't
 * move anyone" rather than throw inside a render.
 */
export function projectTeamIdsOf(
  project: { teams?: readonly { id: string }[] } | null | undefined
): readonly string[] | null {
  if (!project?.teams) {
    return null;
  }
  return project.teams.map((entry) => entry.id);
}

/**
 * Resolve this permalink's canonical destination AND navigate to it, returning
 * the pending destination so the route can render as in-flight rather than
 * falling through to a not-found it is about to contradict.
 *
 * One entry point rather than a resolve call plus a separate effect call: the
 * two are a single decision, and a route that took the destination without
 * performing the navigation (or vice versa) would either strand the reader on a
 * permanent spinner or flash the failure it exists to prevent.
 */
export function useProjectPermalinkCanonicalization(
  location: ProjectPermalinkLocation
): string | null {
  const href = resolveProjectPermalinkRedirect(location);
  useProjectPermalinkRedirect(href);
  return href;
}

/**
 * Perform the canonicalization resolved by
 * {@link resolveProjectPermalinkRedirect}, preserving the caller's fragment.
 *
 * `replace`, not `navigate`: the stale URL is not a place the reader chose to
 * be, so it must not become a back-button stop that bounces them straight
 * forward again.
 *
 * The ref — rather than relying on the effect's dependency list alone — makes
 * one navigation per destination, regardless of whether the surface adapter
 * returns a referentially stable actions object.
 *
 * It is CLEARED the moment no redirect is warranted. Latching it for the
 * lifetime of the mount would mean a reader who reaches the same stale
 * destination twice without an unmount in between gets the suppressed branch on
 * the second pass: no navigation, and a `permalinkRedirect` that never clears,
 * which the route renders as a spinner that never resolves. Clearing on `null`
 * cannot loop, because `null` is the state reached only once the URL is already
 * canonical.
 */
function useProjectPermalinkRedirect(href: string | null): void {
  const navigation = useNavigation();
  const navigatedToRef = useRef<string | null>(null);

  useEffect(() => {
    if (!href) {
      navigatedToRef.current = null;
      return;
    }
    if (navigatedToRef.current === href) {
      return;
    }
    navigatedToRef.current = href;
    navigation.replace(appendLocationHash(href, currentLocationHash()));
  }, [href, navigation]);
}

function currentLocationHash(): string {
  if (globalThis.window === undefined) {
    return "";
  }
  const hash = globalThis.location.hash;
  return hash.startsWith("#/") ? "" : hash;
}
