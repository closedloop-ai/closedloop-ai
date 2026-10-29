/**
 * Canonical, ordered list of the app's primary navigation destinations —
 * the single source of truth shared by the web app's desktop-width sidebar
 * (`apps/app/(authenticated)/components/sidebar.tsx`, also consumed by that
 * app's command palette) and the mobile bottom nav
 * (`shared/components/mobile-bottom-nav.tsx`).
 *
 * Scope: this list backs the `apps/app` (web) shell only. The Electron desktop
 * renderer has its own navigation registry (`apps/desktop/src/renderer/
 * navigation/nav-config.ts` + `route-table.ts`) and does NOT consume this list,
 * so "desktop" here means the web app's desktop-width sidebar, never the
 * Electron shell.
 *
 * Both consuming surfaces derive their destination set from this list so that
 * adding a top-level destination here reaches both navs at once, and they stay
 * in the same order and flag-gating without hand-maintained parallel copies.
 * The sidebar renders the full list, split into its own visual groups. The
 * mobile bar renders an EXPLICIT named subset of these
 * ({@link MOBILE_NAV_PHONE_DESTINATION_PATHS} via
 * {@link resolveMobileNavDestinations}), not a prefix slice — so its MEMBERSHIP
 * is fixed rather than shifting with which flags happen to be on (FEA-4155);
 * everything else stays reachable from the sidebar Sheet its menu affordance
 * opens. A named member that is itself gated still resolves through the
 * feature-flag port, so the bar can render fewer than four (ISS-5041).
 *
 * `path` is org-relative (no `/${orgSlug}` prefix) so each surface can resolve
 * it through its own org-path builder — the mobile nav via the navigation
 * port's `useOrgPath`, the sidebar by prefixing `/${orgSlug}`.
 */

import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import {
  BotIcon,
  CopyCheckIcon,
  FileTextIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  SquareCheckIcon,
} from "lucide-react";
import { ArtifactFlag } from "./artifact-flags";
import {
  SHELL_CANONICAL_LANDING_ROUTE_ID,
  ShellNavigationRouteId,
} from "./shell-navigation-contract";

/**
 * Which visual group a destination belongs to in the web app's desktop-width
 * sidebar. The mobile nav ignores grouping and renders a flat, capped row; the
 * sidebar uses it for its "top level", "Artifacts" and "Labs" sections.
 *
 * A destination's `group` field is the group it occupies TODAY. ISS-8759's
 * regrouping is a second reading of the same list, not a second list — see
 * {@link labsMovedNavGroup}.
 */
export const PrimaryNavGroup = {
  TopLevel: "topLevel",
  Artifact: "artifact",
  Labs: "labs",
} as const;
export type PrimaryNavGroup =
  (typeof PrimaryNavGroup)[keyof typeof PrimaryNavGroup];

/**
 * Org-relative path of the Agents destination. Exported as the stable identity
 * the Agents activity badge keys off, so the badge attaches by destination
 * rather than by the visible "Agents" title (renaming the label must not
 * silently detach the badge). The web app's desktop-width sidebar keys off
 * `NavId.Agents` for the same reason.
 */
export const AGENTS_NAV_PATH = "/agents";

/** Declared above {@link PRIMARY_NAV_DESTINATIONS}, which reads it at module load. */
export const ISSUES_NAV_TITLE = "Issues";

export type PrimaryNavDestination = {
  /** Visible label and accessible destination name. */
  title: string;
  /** Org-relative path (no leading `/${orgSlug}`), resolved per surface. */
  path: string;
  icon: LucideIcon;
  /** Sidebar grouping; the mobile nav renders the flat ordered list. */
  group: PrimaryNavGroup;
  /** Stable route identity in the shared shell navigation contract. */
  shellRouteId: ShellNavigationRouteId;
  /**
   * PostHog/desktop feature-flag key gating this destination. Omitted means
   * always-on. Both surfaces resolve it through their feature-flag port so a
   * flagged-off route never surfaces a dead-ending nav item.
   */
  featureFlag?: string;
};

/**
 * The ordered destinations. Order is authoritative for the sidebar, which
 * renders every entry in this order within its groups. The mobile nav renders
 * an explicit named subset instead (see {@link MOBILE_NAV_PHONE_DESTINATION_PATHS}).
 */
export const PRIMARY_NAV_DESTINATIONS: readonly PrimaryNavDestination[] = [
  {
    title: "Dashboard",
    path: "/dashboard",
    icon: LayoutDashboardIcon,
    group: PrimaryNavGroup.TopLevel,
    shellRouteId: ShellNavigationRouteId.Dashboard,
  },
  {
    title: "Inbox",
    path: "/inbox",
    icon: InboxIcon,
    group: PrimaryNavGroup.TopLevel,
    shellRouteId: ShellNavigationRouteId.Inbox,
  },
  {
    title: "My Tasks",
    path: "/my-tasks",
    icon: CopyCheckIcon,
    group: PrimaryNavGroup.TopLevel,
    shellRouteId: ShellNavigationRouteId.MyTasks,
  },
  {
    // Org-level Documents index (FEA-4140): the org's DOC artifacts, filed into
    // a project or not (ISS-12858). Gated by its own key, independent of Issues.
    title: "Documents",
    path: "/documents",
    icon: FileTextIcon,
    group: PrimaryNavGroup.Artifact,
    shellRouteId: ShellNavigationRouteId.Documents,
    featureFlag: ArtifactFlag.Documents,
  },
  {
    title: ISSUES_NAV_TITLE,
    path: "/issues",
    icon: SquareCheckIcon,
    group: PrimaryNavGroup.Artifact,
    shellRouteId: ShellNavigationRouteId.Issues,
    featureFlag: ArtifactFlag.Issues,
  },
  {
    // FEA-4155: always-on (no featureFlag). The Sessions page/route is no longer
    // flag-gated — leaving the nav link gated on the winding-down flag would hide
    // the only path to a page that now always renders.
    title: "Sessions",
    path: "/sessions",
    icon: HistoryIcon,
    group: PrimaryNavGroup.Artifact,
    shellRouteId: ShellNavigationRouteId.Sessions,
  },
  {
    // FEA-4155: always-on (no featureFlag), same reasoning as Sessions above.
    title: "Branches",
    path: "/branches",
    icon: GitBranchIcon,
    group: PrimaryNavGroup.Artifact,
    shellRouteId: ShellNavigationRouteId.Branches,
  },
  {
    // ISS-5041 / ISS-7835: re-gated after FEA-3994 graduated it to always-on.
    // The flag is what makes dev mode able to hide Agents at all — an always-on
    // destination has nothing for customer-view suppression to act on. Same key
    // as the desktop `agentsNav` Labs toggle (ISS-5310), default off.
    title: "Agents",
    path: AGENTS_NAV_PATH,
    icon: BotIcon,
    group: PrimaryNavGroup.Artifact,
    shellRouteId: ShellNavigationRouteId.Agents,
    featureFlag: AGENTS_NAV_FLAG_KEY,
  },
] as const;

/**
 * Maximum destination slots the mobile bottom nav renders inline before the
 * menu affordance. Native bottom navs cap at five total slots; the menu is
 * always the fifth, so at most four destinations render inline and any
 * overflow stays reachable from the sidebar Sheet the menu opens.
 */
export const MOBILE_NAV_MAX_DESTINATIONS = 4;

/**
 * The exact org-relative paths the mobile bottom nav renders inline, in order.
 *
 * FEA-4155 (bot review #3789): the bar used to prefix-slice the first
 * {@link MOBILE_NAV_MAX_DESTINATIONS} *enabled* destinations off
 * {@link PRIMARY_NAV_DESTINATIONS}. Because Issues is flag-gated and sits ahead
 * of Sessions in that list, the fourth slot flipped between Issues (flag on) and
 * Sessions (flag off) — the same product showing a different bottom-nav shape
 * per org — and Branches never reached the bar at all, so one of the two
 * surfaces this change unblanks stayed menu-only on mobile.
 *
 * Naming the four phone destinations explicitly fixes the ORDER and puts both
 * unblanked surfaces (Sessions, Branches) on it, replacing a prefix slice whose
 * membership shifted with flag state.
 *
 * ISS-5041 ended the stronger claim this comment used to make. Agents is
 * flag-gated again (`AGENTS_NAV_FLAG_KEY`, default off), so the bar is no longer
 * four always-on slots: with the flag off it renders THREE destinations plus the
 * menu, and {@link resolveMobileNavDestinations} filters it out through the
 * injected flag state rather than leaving a dead slot. Nothing is promoted into
 * the vacancy — which destination deserves a phone-bar slot is a product call
 * nobody has made, and inventing one would change the bar for every user
 * including those who never had Agents. Everything off the bar stays reachable
 * from the sidebar Sheet the menu opens.
 */
export const MOBILE_NAV_PHONE_DESTINATION_PATHS: readonly string[] = [
  "/dashboard",
  "/sessions",
  "/branches",
  AGENTS_NAV_PATH,
] as const;

/**
 * The ordered mobile-bottom-nav destinations: the named phone set
 * ({@link MOBILE_NAV_PHONE_DESTINATION_PATHS}) resolved against the canonical
 * registry so title/icon/flag stay single-sourced, filtered by the injected
 * feature-flag state, and capped at {@link MOBILE_NAV_MAX_DESTINATIONS}.
 * `flagState` maps a destination's `featureFlag` key to its resolved enabled
 * boolean; a destination with no `featureFlag` is always included.
 */
export function resolveMobileNavDestinations(
  flagState: Record<string, boolean>
): PrimaryNavDestination[] {
  const byPath = new Map(
    PRIMARY_NAV_DESTINATIONS.map((destination) => [
      destination.path,
      destination,
    ])
  );
  const resolved: PrimaryNavDestination[] = [];
  for (const path of MOBILE_NAV_PHONE_DESTINATION_PATHS) {
    const destination = byPath.get(path);
    if (!destination) {
      continue;
    }
    if (destination.featureFlag && !flagState[destination.featureFlag]) {
      continue;
    }
    resolved.push(destination);
    if (resolved.length === MOBILE_NAV_MAX_DESTINATIONS) {
      break;
    }
  }
  return resolved;
}

/**
 * Web shell reachability for the shared shell contract. Values are org-relative
 * hrefs; `null` means the Web shell does not currently expose that route id.
 */
export const WEB_SHELL_ROUTE_HREFS = {
  [ShellNavigationRouteId.Dashboard]: "/dashboard",
  [ShellNavigationRouteId.Sessions]: "/sessions",
  [ShellNavigationRouteId.Branches]: "/branches",
  [ShellNavigationRouteId.Inbox]: "/inbox",
  [ShellNavigationRouteId.MyIssues]: null,
  [ShellNavigationRouteId.Insights]: "/insights",
  [ShellNavigationRouteId.Approvals]: null,
  [ShellNavigationRouteId.Requests]: null,
  [ShellNavigationRouteId.Documents]: "/documents",
  [ShellNavigationRouteId.Issues]: "/issues",
  [ShellNavigationRouteId.Agents]: AGENTS_NAV_PATH,
  [ShellNavigationRouteId.MyTasks]: "/my-tasks",
  [ShellNavigationRouteId.Packs]: "/packs",
  [ShellNavigationRouteId.LostWork]: "/insights/lost-work",
  [ShellNavigationRouteId.TokenOpsWaste]: "/insights/tokenops-waste",
  [ShellNavigationRouteId.Judges]: "/judges-analytics",
  [ShellNavigationRouteId.Plans]: null,
  [ShellNavigationRouteId.Diagnostics]: "/diagnostics",
  [ShellNavigationRouteId.Settings]: "/settings",
  [ShellNavigationRouteId.Help]: "/help",
} as const satisfies Record<ShellNavigationRouteId, string | null>;

/** Org-relative path of the Inbox destination. */
export const INBOX_NAV_PATH = "/inbox";

/**
 * ISS-8759: which routes KEEP their {@link PrimaryNavDestination.group} in the
 * web sidebar's Labs-moved layout. Operator direction 2026-09-01: Dashboard,
 * Sessions and Branches stay where they are; every other left-nav destination
 * moves under Labs. Documents and Issues have since moved back to Artifacts
 * (operator direction 2026-10-19).
 *
 * Exhaustive over {@link ShellNavigationRouteId} on purpose. A `Set` or array of
 * the three retained ids would widen to `string`, so a route id added later
 * would compile, miss the inventory, and silently take the Labs branch with
 * nobody having decided that. Spelling every member out means a new route id
 * fails `tsc` here until someone classifies it.
 */
export const NAV_LABS_MOVE_RETAINED_ROUTE_IDS = {
  [ShellNavigationRouteId.Dashboard]: true,
  [ShellNavigationRouteId.Sessions]: true,
  [ShellNavigationRouteId.Branches]: true,
  [ShellNavigationRouteId.Inbox]: false,
  [ShellNavigationRouteId.MyIssues]: false,
  [ShellNavigationRouteId.Insights]: false,
  [ShellNavigationRouteId.Approvals]: false,
  [ShellNavigationRouteId.Requests]: false,
  [ShellNavigationRouteId.Documents]: true,
  [ShellNavigationRouteId.Issues]: true,
  [ShellNavigationRouteId.Agents]: false,
  [ShellNavigationRouteId.MyTasks]: false,
  [ShellNavigationRouteId.Packs]: false,
  [ShellNavigationRouteId.LostWork]: false,
  [ShellNavigationRouteId.TokenOpsWaste]: false,
  [ShellNavigationRouteId.Judges]: false,
  [ShellNavigationRouteId.Plans]: false,
  [ShellNavigationRouteId.Diagnostics]: false,
  [ShellNavigationRouteId.Settings]: false,
  [ShellNavigationRouteId.Help]: false,
} as const satisfies Record<ShellNavigationRouteId, boolean>;

/**
 * The group a destination occupies in ISS-8759's Labs-moved layout — the shape
 * the sidebar takes whenever the Labs container is there to receive it. Reading
 * from the same canonical list keeps {@link PrimaryNavGroup} the single owner of
 * grouping — the move is a different READING of these destinations, never a
 * second copy of them.
 */
export function labsMovedNavGroup(
  destination: PrimaryNavDestination
): PrimaryNavGroup {
  return NAV_LABS_MOVE_RETAINED_ROUTE_IDS[destination.shellRouteId]
    ? destination.group
    : PrimaryNavGroup.Labs;
}

/**
 * The group a destination occupies when the Labs container is absent, which is
 * the layout that predates ISS-8759's move. ISS-10244 retired the move's own
 * rollout key, so this is no longer a flag's off position: it is what the
 * sidebar reads through for any viewer outside the `labs-nav-section` rollout,
 * and for every viewer in the customer view, where that key is suppressed.
 * Without it the moved destinations would have no home at all.
 */
export function currentNavGroup(
  destination: PrimaryNavDestination
): PrimaryNavGroup {
  return destination.group;
}

/**
 * Where the web shell lands a signed-in visitor — Dashboard, for every
 * workspace, and the ONLY web landing constant.
 *
 * The entry href used to be resolved per `WorkspaceExperience`, so the legacy
 * tree landed on My Tasks while v2 landed here. That split is gone: Dashboard
 * is the canonical landing route (`SHELL_CANONICAL_LANDING_ROUTE_ID`), desktop
 * has always resolved its entry through that same id, and the route is
 * always-on rather than flag-gated (FEA-4155), so there is no workspace for
 * which it cannot render. Keeping one constant is what stops a second entry
 * point from quietly reintroducing a different landing.
 */
export const WEB_CANONICAL_LANDING_HREF =
  WEB_SHELL_ROUTE_HREFS[SHELL_CANONICAL_LANDING_ROUTE_ID];
