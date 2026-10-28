import {
  PRIMARY_NAV_DESTINATIONS,
  type PrimaryNavDestination,
} from "@repo/app/shared/lib/primary-nav-destinations";
import {
  ShellNavigationItemId,
  ShellNavigationRouteId,
} from "@repo/app/shared/lib/shell-navigation-contract";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  CircleHelpIcon,
  Coins,
  PackageIcon,
  TimerOff,
} from "lucide-react";

/**
 * The icon each v2 sidebar row renders on WEB, by shell item id.
 *
 * The composite takes icons as a slot because the icon is a host question: the
 * contract names an icon TOKEN, and only the surface knows which component it
 * draws. This is the web answer.
 *
 * Canonical destinations take their icon from {@link PRIMARY_NAV_DESTINATIONS},
 * the same list the legacy sidebar and the mobile bottom nav read, so a row
 * cannot wear one icon in one tree and another in the next. The five Labs-native
 * surfaces have no entry in that list — they are not primary destinations — so
 * they name theirs here, matching what `sidebar.tsx` renders today.
 *
 * Exhaustive over {@link ShellNavigationItemId} on purpose: a new item fails
 * `tsc` here until someone decides what it looks like.
 *
 * The type pins that every item has a DECISION, not that the decision RESOLVES.
 * A canonical entry whose route leaves {@link PRIMARY_NAV_DESTINATIONS} still
 * compiles and yields null, and the row ships with a hole where every sibling
 * has an icon. That half is held by the sibling suite, which walks every row
 * this shell can offer and requires an icon for each.
 */
export function webDestinationIcon(destinationId: string): LucideIcon | null {
  return WEB_DESTINATION_ICON_BY_ID.get(destinationId) ?? null;
}

const PRIMARY_NAV_ICON_BY_ROUTE_ID: ReadonlyMap<string, LucideIcon> = new Map(
  PRIMARY_NAV_DESTINATIONS.map((destination: PrimaryNavDestination) => [
    destination.shellRouteId,
    destination.icon,
  ])
);

function canonicalIcon(routeId: ShellNavigationRouteId): LucideIcon | null {
  return PRIMARY_NAV_ICON_BY_ROUTE_ID.get(routeId) ?? null;
}

const WEB_DESTINATION_ICONS: Record<ShellNavigationItemId, LucideIcon | null> =
  {
    [ShellNavigationItemId.Dashboard]: canonicalIcon(
      ShellNavigationRouteId.Dashboard
    ),
    [ShellNavigationItemId.Sessions]: canonicalIcon(
      ShellNavigationRouteId.Sessions
    ),
    [ShellNavigationItemId.Branches]: canonicalIcon(
      ShellNavigationRouteId.Branches
    ),
    [ShellNavigationItemId.Inbox]: canonicalIcon(ShellNavigationRouteId.Inbox),
    [ShellNavigationItemId.MyTasks]: canonicalIcon(
      ShellNavigationRouteId.MyTasks
    ),
    [ShellNavigationItemId.Documents]: canonicalIcon(
      ShellNavigationRouteId.Documents
    ),
    [ShellNavigationItemId.Issues]: canonicalIcon(
      ShellNavigationRouteId.Issues
    ),
    [ShellNavigationItemId.Agents]: canonicalIcon(
      ShellNavigationRouteId.Agents
    ),
    // Labs-native: no `PRIMARY_NAV_DESTINATIONS` entry to read from, so these
    // repeat what `sidebar.tsx`'s `labsNative` list draws today. Lost work and
    // TokenOps waste deliberately differ from the Insights bar chart beside them:
    // three identical icons stacked means the icon stops doing any work.
    [ShellNavigationItemId.Insights]: BarChart3,
    [ShellNavigationItemId.LostWork]: TimerOff,
    [ShellNavigationItemId.TokenOpsWaste]: Coins,
    [ShellNavigationItemId.Judges]: BarChart3,
    [ShellNavigationItemId.Packs]: PackageIcon,
    // ISS-10006 — Help became a reachable Labs row. Its icon is a literal rather
    // than a `PRIMARY_NAV_DESTINATIONS` lookup because Help is not a primary nav
    // destination: it has no entry there to read an icon from.
    [ShellNavigationItemId.Help]: CircleHelpIcon,
    // Not reachable as a web row: `WEB_SHELL_ROUTE_HREFS` maps these to null, so
    // the adapter never offers them and the fold drops them.
    [ShellNavigationItemId.MyIssues]: null,
    [ShellNavigationItemId.Approvals]: null,
    [ShellNavigationItemId.Requests]: null,
    [ShellNavigationItemId.Plans]: null,
    // Account-group destinations, which never become a sidebar section. Web now
    // HAS a Diagnostics page (ISS-10006), but it is reached from the workspace
    // menu, not from a sidebar row, so the fold is never asked for an icon.
    [ShellNavigationItemId.Diagnostics]: null,
    [ShellNavigationItemId.Settings]: null,
    // Controls, not destinations: each renders its own chrome through
    // `renderControl`, and `renderIcon` is never asked about them.
    [ShellNavigationItemId.Search]: null,
    [ShellNavigationItemId.Teams]: null,
    [ShellNavigationItemId.TeamFavorites]: null,
    [ShellNavigationItemId.DevMode]: null,
  };

const WEB_DESTINATION_ICON_BY_ID: ReadonlyMap<string, LucideIcon> =
  buildIconLookup();

/**
 * A string-keyed lookup DERIVED from the exhaustive record above, so the fold
 * can ask with the opaque id it carries without this module casting a string
 * back into the union — and without losing the exhaustiveness that makes a new
 * item fail `tsc`.
 */
function buildIconLookup(): ReadonlyMap<string, LucideIcon> {
  const icons = new Map<string, LucideIcon>();
  for (const [destinationId, icon] of Object.entries(WEB_DESTINATION_ICONS)) {
    if (icon !== null) {
      icons.set(destinationId, icon);
    }
  }
  return icons;
}
