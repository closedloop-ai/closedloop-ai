/**
 * @file prototype-shell-navigation.ts
 * @description Mock navigation fixture for `PrototypeShell` (ISS-10337): a
 * believable ClosedLoop-shaped hierarchy — Dashboard, Sessions, Branches,
 * Insights, Packs, Settings — matching the real route groups under
 * `apps/app/app/(authenticated)/[orgSlug]/`.
 *
 * Built through the REAL `buildNavigationSectionModel` derivation (this
 * module's sibling, `../lib/navigation-section-model`) so the shape a
 * prototype renders is identical to what a real actor's resolved sidebar would
 * be, not a hand-rolled approximation of `NavigationSectionModel`.
 *
 * Every destination resolves `Ready` with no host restriction and no badge
 * count. A prototype is mock-data only (`apps/prototypes/AGENTS.md`), and an
 * invented unread/queue number would read as a real measurement with nothing
 * behind it (`.claude/skills/componentize-prototype/SKILL.md`, section 5) —
 * so this fixture states no counts at all rather than inventing plausible
 * ones.
 */
import {
  NavigationActorStanding,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
} from "@repo/api/src/types/navigation-view-model";
import {
  BarChart3Icon,
  GitBranchIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  SettingsIcon,
} from "lucide-react";
import {
  buildNavigationSectionModel,
  type NavigationSectionInput,
  type NavigationSectionModel,
} from "../lib/navigation-section-model";

const PROTOTYPE_SHELL_HIERARCHY = [
  {
    collapsible: false,
    defaultOpen: true,
    destinations: [
      {
        href: "/dashboard",
        id: "dashboard",
        label: "Dashboard",
        offeredOnHost: true,
      },
    ],
    id: "primary",
    label: "Primary",
  },
  {
    collapsible: true,
    defaultOpen: true,
    destinations: [
      {
        href: "/sessions",
        id: "sessions",
        label: "Sessions",
        offeredOnHost: true,
      },
      {
        href: "/branches",
        id: "branches",
        label: "Branches",
        offeredOnHost: true,
      },
    ],
    id: "artifacts",
    label: "Artifacts",
  },
  {
    collapsible: true,
    defaultOpen: true,
    destinations: [
      {
        href: "/insights",
        id: "insights",
        label: "Insights",
        offeredOnHost: true,
      },
      { href: "/packs", id: "packs", label: "Packs", offeredOnHost: true },
    ],
    id: "workspace",
    label: "Workspace",
  },
  {
    collapsible: false,
    defaultOpen: true,
    destinations: [
      {
        href: "/settings",
        id: "settings",
        label: "Settings",
        offeredOnHost: true,
      },
    ],
    id: "settings",
    label: "Settings",
  },
] as const satisfies readonly NavigationSectionInput[];

/**
 * Every destination in the hierarchy above, resolved `Ready` with no count.
 * The prototype shell has no actor, no organization, and no live projection
 * to read — this is the one static answer the fixture ever gives.
 */
function readyNavigationViewModel(): NavigationViewModel {
  const destinationIds = PROTOTYPE_SHELL_HIERARCHY.flatMap(
    (section) =>
      section.destinations?.map((destination) => destination.id) ?? []
  );
  const destinations: NavigationViewModel["destinations"] = Object.fromEntries(
    destinationIds.map((id) => [
      id,
      { status: NavigationDestinationStatus.Ready },
    ])
  );
  return {
    destinations,
    organizationId: "org-prototype",
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
  };
}

/**
 * The resolved sections `PrototypeShell` feeds `ShellSidebar`. Computed once
 * at module load — the fixture is static, so there is nothing to recompute
 * per render.
 */
export const PROTOTYPE_SHELL_NAVIGATION_SECTIONS: readonly NavigationSectionModel[] =
  buildNavigationSectionModel(
    PROTOTYPE_SHELL_HIERARCHY,
    readyNavigationViewModel()
  );

/**
 * Every destination id the hierarchy above declares, as a literal union rather
 * than `string`. Derived from the fixture itself so the icon map below cannot
 * be written without naming all of them.
 */
export type PrototypeShellDestinationId = NonNullable<
  (typeof PROTOTYPE_SHELL_HIERARCHY)[number]["destinations"]
>[number]["id"];

/** Per-destination icon, matching the icon vocabulary the real sidebars use
 * (`apps/prototypes/app/p/web-ui-kit/components/app-sidebar.tsx`'s
 * `navIcons`, `shell-sidebar.stories.tsx`'s `ICONS`).
 *
 * Keyed by {@link PrototypeShellDestinationId}, not `string`: a `Record` over
 * `string` let a destination added to the hierarchy above compile with no icon
 * and render that nav row blank (`renderIcon` returned null). Keyed by the
 * union, `tsc` fails until the new destination is given one — the side-inventory
 * lesson in the root `AGENTS.md`. */
export const PROTOTYPE_SHELL_NAVIGATION_ICONS: Record<
  PrototypeShellDestinationId,
  LucideIcon
> = {
  branches: GitBranchIcon,
  dashboard: LayoutDashboardIcon,
  insights: BarChart3Icon,
  packs: PackageIcon,
  sessions: HistoryIcon,
  settings: SettingsIcon,
};
