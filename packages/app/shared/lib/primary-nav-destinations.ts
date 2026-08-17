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
 * {@link resolveMobileNavDestinations}), not a prefix slice — so its shape does
 * not shift with flag state (FEA-4155); everything else stays reachable from the
 * sidebar Sheet its menu affordance opens.
 *
 * `path` is org-relative (no `/${orgSlug}` prefix) so each surface can resolve
 * it through its own org-path builder — the mobile nav via the navigation
 * port's `useOrgPath`, the sidebar by prefixing `/${orgSlug}`.
 */

import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import {
  BotIcon,
  CalendarClockIcon,
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

/**
 * Which visual group a destination belongs to in the web app's desktop-width
 * sidebar. The mobile nav ignores grouping and renders a flat, capped row; the
 * sidebar uses it to keep its existing "top level" vs "Artifacts" sections.
 */
export const PrimaryNavGroup = {
  TopLevel: "topLevel",
  Artifact: "artifact",
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

export type PrimaryNavDestination = {
  /** Visible label and accessible destination name. */
  title: string;
  /** Org-relative path (no leading `/${orgSlug}`), resolved per surface. */
  path: string;
  icon: LucideIcon;
  /** Sidebar grouping; the mobile nav renders the flat ordered list. */
  group: PrimaryNavGroup;
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
  },
  {
    title: "Inbox",
    path: "/inbox",
    icon: InboxIcon,
    group: PrimaryNavGroup.TopLevel,
  },
  {
    title: "My Tasks",
    path: "/my-tasks",
    icon: CopyCheckIcon,
    group: PrimaryNavGroup.TopLevel,
  },
  {
    // PRD-566 / FEA-4348: Routines (the renamed "Scheduled Tasks" feature) lives
    // in the Artifacts group alongside the other primary artifact surfaces
    // (Sessions, Branches, Agents). The interactive list/editor/run-history lives
    // in the desktop app; the web surface names the feature and points there
    // (see `routines/components/routines-index-view.tsx`). Gated behind the
    // PostHog `routines` flag (default off) until GA — belt-and-suspenders with
    // the desktop `routines` Labs setting — so an unfinished feature never
    // surfaces in prod. The `/routines` route carries the same gate.
    title: "Routines",
    path: "/routines",
    icon: CalendarClockIcon,
    group: PrimaryNavGroup.Artifact,
    featureFlag: ROUTINES_FEATURE_FLAG_KEY,
  },
  {
    // Org-level Documents index (FEA-4140): the project-less DOC artifacts
    // (evergreen docs). Ordered FIRST in the Artifacts group; shipped always-on
    // (no flag), consistent with Agents.
    title: "Documents",
    path: "/documents",
    icon: FileTextIcon,
    group: PrimaryNavGroup.Artifact,
  },
  {
    title: "Issues",
    path: "/issues",
    icon: SquareCheckIcon,
    group: PrimaryNavGroup.Artifact,
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
  },
  {
    // FEA-4155: always-on (no featureFlag), same reasoning as Sessions above.
    title: "Branches",
    path: "/branches",
    icon: GitBranchIcon,
    group: PrimaryNavGroup.Artifact,
  },
  {
    title: "Agents",
    path: AGENTS_NAV_PATH,
    icon: BotIcon,
    group: PrimaryNavGroup.Artifact,
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
 * Naming the four phone destinations explicitly fixes the bar shape and puts
 * both unblanked surfaces (Sessions, Branches) on it. All four are always-on
 * (they carry no `featureFlag`), so the bar shape no longer varies by flag
 * state; any still-gated destination here would still resolve through the
 * feature-flag port before rendering.
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
