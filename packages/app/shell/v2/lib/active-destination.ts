/**
 * @file active-destination.ts
 * @description The one boundary rule for "is this destination the route the user
 * is on" (ISS-9734).
 *
 * Two places on the v2 arm ask it and are meant to agree: the composite lights
 * the row, and the web adapter drains the Agents badge on the same answer. As
 * two hand-written copies, a fix to the boundary — the sibling-prefix case below
 * is the one already known to need one — reaches whichever copy the author was
 * looking at, and the badge silently stops meaning what the row it sits on says.
 */

/**
 * Whether a destination is the one currently open.
 *
 * A bare `startsWith` lights two rows the moment a manifest holds a path that
 * prefixes a sibling (`/issues` under `/issues-archive`). The prototype could
 * assume no such pair existed because its list was hand-written; the composite
 * renders whatever manifest it is handed, so the boundary has to be real.
 *
 * A null on either side is not active: a route this host does not resolve is not
 * somewhere the user can be standing.
 */
export function isActiveDestination(
  activePath: string | null,
  href: string | null
): boolean {
  if (activePath === null || href === null) {
    return false;
  }
  return activePath === href || activePath.startsWith(`${href}/`);
}
