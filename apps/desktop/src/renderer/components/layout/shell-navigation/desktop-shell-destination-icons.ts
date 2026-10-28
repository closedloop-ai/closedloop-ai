import {
  ShellNavigationItemId,
  ShellNavigationRouteId,
} from "@repo/app/shared/lib/shell-navigation-contract";
import type { LucideIcon } from "lucide-react";
import { navEntryFor } from "../../../navigation/nav-config";
import { DESKTOP_SHELL_ROUTE_NAV_IDS } from "../../../navigation/route-table";

/**
 * The icon each v2 sidebar row renders on DESKTOP, by shell item id.
 *
 * The composite takes icons as a slot because the icon is a host question: the
 * contract names an icon TOKEN, and only the surface knows which component it
 * draws. This is the desktop answer, and it reads {@link navEntryFor} — the same
 * `NAV_ENTRIES` list the legacy sidebar and the Topbar breadcrumb read — so a
 * row cannot wear one icon in one tree and another in the next.
 *
 * Exhaustive over {@link ShellNavigationItemId} on purpose: a new item fails
 * `tsc` here until someone decides what it looks like.
 *
 * The type pins that every item has a DECISION, not that the decision RESOLVES.
 * A destination whose desktop nav id is later removed from `NAV_ENTRIES` still
 * compiles and yields null, and the row would ship with a hole where every
 * sibling has an icon. That half is held by the sibling suite, which walks every
 * row this shell can offer and requires an icon for each.
 */
export function desktopDestinationIcon(
  destinationId: string
): LucideIcon | null {
  return DESKTOP_DESTINATION_ICON_BY_ID.get(destinationId) ?? null;
}

function navIcon(routeId: ShellNavigationRouteId): LucideIcon | null {
  const navId = DESKTOP_SHELL_ROUTE_NAV_IDS[routeId];
  return navId === null ? null : (navEntryFor(navId)?.icon ?? null);
}

const DESKTOP_DESTINATION_ICONS: Record<
  ShellNavigationItemId,
  LucideIcon | null
> = {
  [ShellNavigationItemId.Dashboard]: navIcon(ShellNavigationRouteId.Dashboard),
  [ShellNavigationItemId.Sessions]: navIcon(ShellNavigationRouteId.Sessions),
  [ShellNavigationItemId.Branches]: navIcon(ShellNavigationRouteId.Branches),
  [ShellNavigationItemId.Insights]: navIcon(ShellNavigationRouteId.Insights),
  [ShellNavigationItemId.Approvals]: navIcon(ShellNavigationRouteId.Approvals),
  [ShellNavigationItemId.Requests]: navIcon(ShellNavigationRouteId.Requests),
  [ShellNavigationItemId.Agents]: navIcon(ShellNavigationRouteId.Agents),
  [ShellNavigationItemId.Packs]: navIcon(ShellNavigationRouteId.Packs),
  [ShellNavigationItemId.Plans]: navIcon(ShellNavigationRouteId.Plans),
  [ShellNavigationItemId.Help]: navIcon(ShellNavigationRouteId.Help),
  [ShellNavigationItemId.Documents]: navIcon(ShellNavigationRouteId.Documents),
  [ShellNavigationItemId.Issues]: navIcon(ShellNavigationRouteId.Issues),
  // Account-group destinations: the workspace menu owns them, and
  // `SHELL_SECTION_DISCLOSURE` never makes that group a sidebar section.
  [ShellNavigationItemId.Diagnostics]: navIcon(
    ShellNavigationRouteId.Diagnostics
  ),
  [ShellNavigationItemId.Settings]: navIcon(ShellNavigationRouteId.Settings),
  // Not reachable as a desktop row: `DESKTOP_SHELL_ROUTE_NAV_IDS` maps these to
  // null, so the adapter never offers them and the fold drops them.
  [ShellNavigationItemId.Inbox]: null,
  [ShellNavigationItemId.MyIssues]: null,
  [ShellNavigationItemId.MyTasks]: null,
  [ShellNavigationItemId.LostWork]: null,
  [ShellNavigationItemId.TokenOpsWaste]: null,
  [ShellNavigationItemId.Judges]: null,
  // Controls, not destinations: each renders its own chrome through
  // `renderControl`, and `renderIcon` is never asked about them.
  [ShellNavigationItemId.Search]: null,
  [ShellNavigationItemId.Teams]: null,
  [ShellNavigationItemId.TeamFavorites]: null,
  [ShellNavigationItemId.DevMode]: null,
};

const DESKTOP_DESTINATION_ICON_BY_ID: ReadonlyMap<string, LucideIcon> =
  buildIconLookup();

/**
 * A string-keyed lookup DERIVED from the exhaustive record above, so the fold
 * can ask with the opaque id it carries without this module casting a string
 * back into the union — and without losing the exhaustiveness that makes a new
 * item fail `tsc`.
 */
function buildIconLookup(): ReadonlyMap<string, LucideIcon> {
  const icons = new Map<string, LucideIcon>();
  for (const [destinationId, icon] of Object.entries(
    DESKTOP_DESTINATION_ICONS
  )) {
    if (icon !== null) {
      icons.set(destinationId, icon);
    }
  }
  return icons;
}
