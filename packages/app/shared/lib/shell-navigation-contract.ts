import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { ArtifactFlag } from "./artifact-flags";
import {
  JUDGES_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LOST_WORK_NAV_FEATURE_FLAG_KEY,
  TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
} from "./feature-flags";

/**
 * Shared shell navigation contract for shell-owned composition.
 *
 * This module is intentionally pure data and small helpers: it defines stable
 * route identities, one-level navigation groups, extension slots, and slot
 * resolution rules without importing Web, Desktop, or design-system modules.
 * Existing renderers can keep their local nav implementations while using this
 * contract to describe the shared surface safely.
 */

export const SHELL_WEB_LABS_NAV_GATE_KEY = LABS_NAV_SECTION_FEATURE_FLAG_KEY;
export const SHELL_INSIGHTS_NAV_GATE_KEY = INSIGHTS_FEATURE_FLAG_KEY;
export const SHELL_AGENTS_NAV_GATE_KEY = AGENTS_NAV_FLAG_KEY;
export const SHELL_JUDGES_NAV_GATE_KEY = JUDGES_FEATURE_FLAG_KEY;
export const SHELL_DESKTOP_LABS_NAV_GATE_KEY = "labsNav" as const;
export const SHELL_DESKTOP_DOCS_HELP_NAV_GATE_KEY = "docsHelp" as const;

export const ShellNavigationRouteId = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Inbox: "inbox",
  MyIssues: "my-issues",
  Insights: "insights",
  Approvals: "approvals",
  Requests: "requests",
  Documents: "documents",
  Issues: "issues",
  Agents: "agents",
  MyTasks: "my-tasks",
  Packs: "packs",
  LostWork: "lost-work",
  TokenOpsWaste: "tokenops-waste",
  Judges: "judges",
  Plans: "plans",
  Diagnostics: "diagnostics",
  Settings: "settings",
  Help: "help",
} as const;
export type ShellNavigationRouteId =
  (typeof ShellNavigationRouteId)[keyof typeof ShellNavigationRouteId];

export const ShellNavigationGroupId = {
  Primary: "primary",
  Artifacts: "artifacts",
  Labs: "labs",
  LabsArtifacts: "labs-artifacts",
  LabsTeams: "labs-teams",
  LabsFooter: "labs-footer",
  Gateway: "gateway",
  Account: "account",
} as const;
export type ShellNavigationGroupId =
  (typeof ShellNavigationGroupId)[keyof typeof ShellNavigationGroupId];

export const ShellNavigationItemId = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Inbox: "inbox",
  MyIssues: "my-issues",
  Insights: "insights",
  Approvals: "approvals",
  Requests: "requests",
  Documents: "documents",
  Issues: "issues",
  Agents: "agents",
  MyTasks: "my-tasks",
  Packs: "packs",
  LostWork: "lost-work",
  TokenOpsWaste: "tokenops-waste",
  Judges: "judges",
  Plans: "plans",
  Diagnostics: "diagnostics",
  Settings: "settings",
  Help: "help",
  Search: "search",
  Teams: "teams",
  TeamFavorites: "team-favorites",
  DevMode: "dev-mode",
} as const;
export type ShellNavigationItemId =
  (typeof ShellNavigationItemId)[keyof typeof ShellNavigationItemId];

export const ShellNavigationItemKind = {
  Route: "route",
  Control: "control",
  DynamicSection: "dynamic-section",
} as const;
export type ShellNavigationItemKind =
  (typeof ShellNavigationItemKind)[keyof typeof ShellNavigationItemKind];

export const ShellNavigationIconToken = {
  Agents: "agents",
  Approvals: "approvals",
  Branches: "branches",
  Dashboard: "dashboard",
  DevMode: "dev-mode",
  Diagnostics: "diagnostics",
  Documents: "documents",
  Help: "help",
  Inbox: "inbox",
  Insights: "insights",
  Issues: "issues",
  Judges: "judges",
  LostWork: "lost-work",
  MyIssues: "my-issues",
  MyTasks: "my-tasks",
  Packs: "packs",
  Plans: "plans",
  Requests: "requests",
  Search: "search",
  Sessions: "sessions",
  Settings: "settings",
  Teams: "teams",
  TokenOpsWaste: "tokenops-waste",
} as const;
export type ShellNavigationIconToken =
  (typeof ShellNavigationIconToken)[keyof typeof ShellNavigationIconToken];

export const ShellTourTargetId = {
  DashboardNav: "dashboard-nav",
  ArtifactsNav: "artifacts-nav",
  LabsNav: "labs-nav",
  SessionsNav: "sessions-nav",
  BranchesNav: "branches-nav",
  WorkspaceHeader: "workspace-header",
  SidebarFooter: "sidebar-footer",
  ContentBanner: "content-banner",
} as const;
export type ShellTourTargetId =
  (typeof ShellTourTargetId)[keyof typeof ShellTourTargetId];

export const ShellExtensionSlot = {
  WorkspaceHeader: "workspace-header",
  SidebarFooter: "sidebar-footer",
  ContentBanner: "content-banner",
  Overlay: "overlay",
} as const;
export type ShellExtensionSlot =
  (typeof ShellExtensionSlot)[keyof typeof ShellExtensionSlot];

export const ShellNavigationGateKind = {
  WebFeatureFlag: "web-feature-flag",
  DesktopLabsContainer: "desktop-labs-container",
  DesktopLabsItem: "desktop-labs-item",
} as const;
export type ShellNavigationGateKind =
  (typeof ShellNavigationGateKind)[keyof typeof ShellNavigationGateKind];

export const ShellNavigationSurface = {
  Web: "web",
  Desktop: "desktop",
} as const;
export type ShellNavigationSurface =
  (typeof ShellNavigationSurface)[keyof typeof ShellNavigationSurface];

export type ShellNavigationGroupDescriptor = {
  readonly id: ShellNavigationGroupId;
  readonly label: string;
  readonly parentId?: ShellNavigationGroupId;
  readonly gates?: ShellNavigationSurfaceGateMap;
};

export type ShellNavigationGateDescriptor = {
  readonly kind: ShellNavigationGateKind;
  readonly key?: string;
};

export type ShellNavigationSurfaceGateMap = Partial<
  Record<ShellNavigationSurface, readonly ShellNavigationGateDescriptor[]>
>;

export type ShellNavigationItemDescriptor = {
  readonly id: ShellNavigationItemId;
  readonly kind: ShellNavigationItemKind;
  readonly label: string;
  readonly groupId: ShellNavigationGroupId;
  readonly iconToken: ShellNavigationIconToken;
  readonly routeId?: ShellNavigationRouteId;
  readonly tourTargetId?: ShellTourTargetId;
  readonly gates?: ShellNavigationSurfaceGateMap;
};

export type ShellExtensionTargetId =
  | ShellNavigationGroupId
  | ShellNavigationItemId
  | ShellTourTargetId;

export type ShellExtensionProvider = {
  readonly id: string;
  readonly slot: string;
  readonly targetId?: string;
  readonly enabled?: boolean;
  readonly order?: number;
};

export type ResolvedShellExtensionProvider = Omit<
  ShellExtensionProvider,
  "slot" | "targetId"
> & {
  readonly slot: ShellExtensionSlot;
  readonly targetId?: ShellExtensionTargetId;
};

/**
 * One-level shell navigation groups. Nested children exist only directly under
 * Labs, matching the Web Master v2 contract without requiring current renderers
 * to adopt that hierarchy immediately.
 */
export const SHELL_NAVIGATION_GROUPS: readonly ShellNavigationGroupDescriptor[] =
  [
    { id: ShellNavigationGroupId.Primary, label: "Primary" },
    { id: ShellNavigationGroupId.Artifacts, label: "Artifacts" },
    {
      // The web gate here is the CONTAINER, not the menu mount: it answers
      // whether Labs is open to receive the moved nodes, and a closed container
      // is what re-homes them (`SHELL_CONTAINER_ABSENT_HOME`). Whether the
      // section RENDERS is `enable-labs-nav-section`, which the web host applies
      // to the built sections — declaring it here would close the container too
      // and re-home every moved row back into the nav, which is the opposite of
      // what that key is for.
      id: ShellNavigationGroupId.Labs,
      label: "Labs",
      gates: {
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(LABS_NAV_SECTION_FEATURE_FLAG_KEY),
        ],
        [ShellNavigationSurface.Desktop]: [desktopLabsContainerGate()],
      },
    },
    {
      id: ShellNavigationGroupId.LabsArtifacts,
      label: "Artifacts",
      parentId: ShellNavigationGroupId.Labs,
    },
    {
      id: ShellNavigationGroupId.LabsTeams,
      label: "Teams",
      parentId: ShellNavigationGroupId.Labs,
    },
    {
      id: ShellNavigationGroupId.LabsFooter,
      label: "Footer",
      parentId: ShellNavigationGroupId.Labs,
    },
    { id: ShellNavigationGroupId.Gateway, label: "Gateway" },
    { id: ShellNavigationGroupId.Account, label: "Account" },
  ] as const;

/**
 * Canonical shell items and current reachability identities. Some entries are
 * production-compatibility items rather than Web Master v2 targets; their
 * concrete Web/Desktop support is declared by the surface-specific reachability
 * maps instead of implied from this manifest.
 */
export const SHELL_NAVIGATION_ITEMS: readonly ShellNavigationItemDescriptor[] =
  [
    {
      id: ShellNavigationItemId.Dashboard,
      kind: ShellNavigationItemKind.Route,
      label: "Dashboard",
      groupId: ShellNavigationGroupId.Primary,
      iconToken: ShellNavigationIconToken.Dashboard,
      routeId: ShellNavigationRouteId.Dashboard,
      tourTargetId: ShellTourTargetId.DashboardNav,
    },
    {
      // Documents and Issues sit in Artifacts ahead of Sessions and Branches,
      // each behind its own key and outside the Labs container on both surfaces.
      id: ShellNavigationItemId.Documents,
      kind: ShellNavigationItemKind.Route,
      label: "Documents",
      groupId: ShellNavigationGroupId.Artifacts,
      iconToken: ShellNavigationIconToken.Documents,
      routeId: ShellNavigationRouteId.Documents,
      gates: {
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(ArtifactFlag.Documents),
        ],
        [ShellNavigationSurface.Desktop]: [
          desktopLabsItemGate(ArtifactFlag.Documents),
        ],
      },
    },
    {
      id: ShellNavigationItemId.Issues,
      kind: ShellNavigationItemKind.Route,
      label: "Issues",
      groupId: ShellNavigationGroupId.Artifacts,
      iconToken: ShellNavigationIconToken.Issues,
      routeId: ShellNavigationRouteId.Issues,
      gates: {
        [ShellNavigationSurface.Web]: [webFeatureFlagGate(ArtifactFlag.Issues)],
        [ShellNavigationSurface.Desktop]: [
          desktopLabsItemGate(ArtifactFlag.Issues),
        ],
      },
    },
    {
      id: ShellNavigationItemId.Sessions,
      kind: ShellNavigationItemKind.Route,
      label: "Sessions",
      groupId: ShellNavigationGroupId.Artifacts,
      iconToken: ShellNavigationIconToken.Sessions,
      routeId: ShellNavigationRouteId.Sessions,
      tourTargetId: ShellTourTargetId.SessionsNav,
    },
    {
      id: ShellNavigationItemId.Branches,
      kind: ShellNavigationItemKind.Route,
      label: "Branches",
      groupId: ShellNavigationGroupId.Artifacts,
      iconToken: ShellNavigationIconToken.Branches,
      routeId: ShellNavigationRouteId.Branches,
      tourTargetId: ShellTourTargetId.BranchesNav,
    },
    {
      id: ShellNavigationItemId.Search,
      kind: ShellNavigationItemKind.Control,
      label: "Search",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Search,
    },
    {
      id: ShellNavigationItemId.Inbox,
      kind: ShellNavigationItemKind.Route,
      label: "Inbox",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Inbox,
      routeId: ShellNavigationRouteId.Inbox,
    },
    {
      id: ShellNavigationItemId.MyIssues,
      kind: ShellNavigationItemKind.Route,
      label: "My Issues",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.MyIssues,
      routeId: ShellNavigationRouteId.MyIssues,
    },
    {
      id: ShellNavigationItemId.Insights,
      kind: ShellNavigationItemKind.Route,
      label: "Insights",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Insights,
      routeId: ShellNavigationRouteId.Insights,
      gates: {
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(LABS_NAV_SECTION_FEATURE_FLAG_KEY),
          webFeatureFlagGate(INSIGHTS_FEATURE_FLAG_KEY),
        ],
        [ShellNavigationSurface.Desktop]: [desktopLabsContainerGate()],
      },
    },
    {
      // ISS-8759 (desktop mirror, operator direction 2026-09-03): the Desktop
      // shell used to render these two in a `gateway` group of their own, exempt
      // from its Labs fold, so they carried no gate. They now DISPLAY under
      // Labs, which on Desktop means inside the ISS-5037 `labsNav` container —
      // hidden from the sidebar and unreachable by hash while it is off. Both
      // declare that here so the contract states the reachability the shell
      // actually enforces. Web has no route for either (WEB_SHELL_ROUTE_HREFS
      // maps both to null), so there is no Web gate to keep in lockstep.
      id: ShellNavigationItemId.Approvals,
      kind: ShellNavigationItemKind.Route,
      label: "Approvals",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Approvals,
      routeId: ShellNavigationRouteId.Approvals,
      gates: {
        [ShellNavigationSurface.Desktop]: [desktopLabsContainerGate()],
      },
    },
    {
      id: ShellNavigationItemId.Requests,
      kind: ShellNavigationItemKind.Route,
      label: "Requests",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Requests,
      routeId: ShellNavigationRouteId.Requests,
      gates: {
        [ShellNavigationSurface.Desktop]: [desktopLabsContainerGate()],
      },
    },
    {
      id: ShellNavigationItemId.Agents,
      kind: ShellNavigationItemKind.Route,
      label: "Agents",
      groupId: ShellNavigationGroupId.LabsArtifacts,
      iconToken: ShellNavigationIconToken.Agents,
      routeId: ShellNavigationRouteId.Agents,
      gates: {
        [ShellNavigationSurface.Web]: [webFeatureFlagGate(AGENTS_NAV_FLAG_KEY)],
        [ShellNavigationSurface.Desktop]: [
          desktopLabsContainerGate(),
          desktopLabsItemGate(AGENTS_NAV_FLAG_KEY),
        ],
      },
    },
    {
      id: ShellNavigationItemId.Teams,
      kind: ShellNavigationItemKind.DynamicSection,
      label: "Teams",
      groupId: ShellNavigationGroupId.LabsTeams,
      iconToken: ShellNavigationIconToken.Teams,
    },
    {
      id: ShellNavigationItemId.TeamFavorites,
      kind: ShellNavigationItemKind.DynamicSection,
      label: "Favorites",
      groupId: ShellNavigationGroupId.LabsTeams,
      iconToken: ShellNavigationIconToken.Teams,
    },
    {
      // ISS-9891 put the dev-mode switch in Labs. Declaring it here, rather than
      // leaving it a host-only node, is what makes "one home per affordance"
      // checkable against the contract (PLN-2016 D3/D7).
      id: ShellNavigationItemId.DevMode,
      kind: ShellNavigationItemKind.Control,
      label: "Dev mode",
      groupId: ShellNavigationGroupId.LabsFooter,
      iconToken: ShellNavigationIconToken.DevMode,
    },
    {
      id: ShellNavigationItemId.MyTasks,
      kind: ShellNavigationItemKind.Route,
      label: "My Tasks",
      // PRD-690 R3 / ISS-8759 keep only Dashboard, Sessions and Branches outside
      // Labs. Everything else, including this and Packs, is a Labs row
      // (PLN-2016 D2).
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.MyTasks,
      routeId: ShellNavigationRouteId.MyTasks,
    },
    {
      id: ShellNavigationItemId.Packs,
      kind: ShellNavigationItemKind.Route,
      label: "Packs",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Packs,
      routeId: ShellNavigationRouteId.Packs,
      gates: {
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(LABS_NAV_SECTION_FEATURE_FLAG_KEY),
        ],
        [ShellNavigationSurface.Desktop]: [desktopLabsContainerGate()],
      },
    },
    {
      id: ShellNavigationItemId.LostWork,
      kind: ShellNavigationItemKind.Route,
      label: "Lost work",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.LostWork,
      routeId: ShellNavigationRouteId.LostWork,
      gates: {
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(LABS_NAV_SECTION_FEATURE_FLAG_KEY),
          webFeatureFlagGate(LOST_WORK_NAV_FEATURE_FLAG_KEY),
        ],
      },
    },
    {
      id: ShellNavigationItemId.TokenOpsWaste,
      kind: ShellNavigationItemKind.Route,
      label: "TokenOps waste",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.TokenOpsWaste,
      routeId: ShellNavigationRouteId.TokenOpsWaste,
      gates: {
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(LABS_NAV_SECTION_FEATURE_FLAG_KEY),
          webFeatureFlagGate(TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY),
        ],
      },
    },
    {
      id: ShellNavigationItemId.Judges,
      kind: ShellNavigationItemKind.Route,
      label: "Judges",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Judges,
      routeId: ShellNavigationRouteId.Judges,
      gates: {
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(LABS_NAV_SECTION_FEATURE_FLAG_KEY),
          webFeatureFlagGate(JUDGES_FEATURE_FLAG_KEY),
        ],
      },
    },
    {
      id: ShellNavigationItemId.Plans,
      kind: ShellNavigationItemKind.Route,
      label: "Plans",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Plans,
      routeId: ShellNavigationRouteId.Plans,
      gates: {
        [ShellNavigationSurface.Desktop]: [desktopLabsContainerGate()],
      },
    },
    {
      id: ShellNavigationItemId.Diagnostics,
      kind: ShellNavigationItemKind.Route,
      label: "Diagnostics",
      groupId: ShellNavigationGroupId.Account,
      iconToken: ShellNavigationIconToken.Diagnostics,
      routeId: ShellNavigationRouteId.Diagnostics,
      gates: {
        // ISS-10006. Web reaches Diagnostics now, closed by default behind the
        // key that already gates the surface on desktop. The gate is declared
        // here and not only at the route so the workspace-menu entry and the
        // page cannot disagree about whether this build has a Diagnostics page.
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY),
        ],
      },
    },
    {
      id: ShellNavigationItemId.Settings,
      kind: ShellNavigationItemKind.Route,
      label: "Settings",
      groupId: ShellNavigationGroupId.Account,
      iconToken: ShellNavigationIconToken.Settings,
      routeId: ShellNavigationRouteId.Settings,
    },
    {
      id: ShellNavigationItemId.Help,
      kind: ShellNavigationItemKind.Route,
      label: "Help",
      groupId: ShellNavigationGroupId.Labs,
      iconToken: ShellNavigationIconToken.Help,
      routeId: ShellNavigationRouteId.Help,
      gates: {
        [ShellNavigationSurface.Desktop]: [
          desktopLabsContainerGate(),
          desktopLabsItemGate(SHELL_DESKTOP_DOCS_HELP_NAV_GATE_KEY),
        ],
        // ISS-10006 — same shape as the desktop stack: the Labs container, then
        // the surface's own key. Web's container gate is the Labs nav section.
        [ShellNavigationSurface.Web]: [
          webFeatureFlagGate(LABS_NAV_SECTION_FEATURE_FLAG_KEY),
          webFeatureFlagGate(HELP_COMPLETE_SURFACE_FLAG_KEY),
        ],
      },
    },
  ] as const;

/** Ordered route ids covered by the shared shell contract. */
export const SHELL_NAVIGATION_ROUTE_IDS: readonly ShellNavigationRouteId[] =
  Object.values(ShellNavigationRouteId);

/** Ordered extension slots providers may target. */
export const SHELL_EXTENSION_SLOTS: readonly ShellExtensionSlot[] =
  Object.values(ShellExtensionSlot);

/** Known target ids a shell extension provider may attach to. */
export const SHELL_EXTENSION_TARGET_IDS: readonly ShellExtensionTargetId[] = [
  ...Object.values(ShellNavigationGroupId),
  ...Object.values(ShellNavigationItemId),
  ...Object.values(ShellTourTargetId),
] as const;

/** Returns whether a raw value is a supported shell extension slot. */
export function isShellExtensionSlot(
  value: string
): value is ShellExtensionSlot {
  return KNOWN_EXTENSION_SLOTS.has(value);
}

/** Returns whether a raw value is a supported shell extension target. */
export function isShellExtensionTargetId(
  value: string
): value is ShellExtensionTargetId {
  return KNOWN_EXTENSION_TARGET_IDS.has(value);
}

/**
 * Resolves extension providers by dropping disabled providers, unknown slots,
 * and unknown targets. This makes extension registration additive: older shells
 * safely ignore providers they do not understand.
 */
export function resolveShellExtensionProviders(
  providers: readonly ShellExtensionProvider[] | null | undefined
): ResolvedShellExtensionProvider[] {
  if (!providers) {
    return [];
  }
  return providers
    .map(resolveShellExtensionProvider)
    .filter(
      (provider): provider is ResolvedShellExtensionProvider =>
        provider !== null
    )
    .sort(compareResolvedExtensionProviders);
}

const KNOWN_EXTENSION_SLOTS = new Set<string>(SHELL_EXTENSION_SLOTS);
const KNOWN_EXTENSION_TARGET_IDS = new Set<string>(SHELL_EXTENSION_TARGET_IDS);

const EXTENSION_SLOT_ORDER = createExtensionSlotOrder();

function resolveShellExtensionProvider(
  provider: ShellExtensionProvider
): ResolvedShellExtensionProvider | null {
  if (provider.enabled === false || !isShellExtensionSlot(provider.slot)) {
    return null;
  }
  if (provider.targetId === undefined) {
    return {
      enabled: provider.enabled,
      id: provider.id,
      order: provider.order,
      slot: provider.slot,
    };
  }
  if (!isShellExtensionTargetId(provider.targetId)) {
    return null;
  }
  return {
    enabled: provider.enabled,
    id: provider.id,
    order: provider.order,
    slot: provider.slot,
    targetId: provider.targetId,
  };
}

function compareResolvedExtensionProviders(
  left: ResolvedShellExtensionProvider,
  right: ResolvedShellExtensionProvider
): number {
  const slotDelta =
    EXTENSION_SLOT_ORDER[left.slot] - EXTENSION_SLOT_ORDER[right.slot];
  if (slotDelta !== 0) {
    return slotDelta;
  }
  const orderDelta =
    extensionProviderOrder(left) - extensionProviderOrder(right);
  if (orderDelta !== 0) {
    return orderDelta;
  }
  return left.id.localeCompare(right.id);
}

function extensionProviderOrder(
  provider: ResolvedShellExtensionProvider
): number {
  const order = provider.order;
  return order === undefined || !Number.isFinite(order) ? 0 : order;
}

function webFeatureFlagGate(key: string): ShellNavigationGateDescriptor {
  return { kind: ShellNavigationGateKind.WebFeatureFlag, key };
}

function desktopLabsContainerGate(): ShellNavigationGateDescriptor {
  return {
    kind: ShellNavigationGateKind.DesktopLabsContainer,
    key: SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  };
}

function desktopLabsItemGate(key: string): ShellNavigationGateDescriptor {
  return { kind: ShellNavigationGateKind.DesktopLabsItem, key };
}

function createExtensionSlotOrder(): Record<ShellExtensionSlot, number> {
  const order = Object.create(null) as Record<ShellExtensionSlot, number>;
  SHELL_EXTENSION_SLOTS.forEach((slot, index) => {
    order[slot] = index;
  });
  return order;
}

export const SHELL_CANONICAL_LANDING_ROUTE_ID =
  ShellNavigationRouteId.Dashboard;

/**
 * Every gate key the contract declares for one surface, once each, in contract
 * order. A host adapter holds the set of keys it actually reads against this, so
 * a gate added to the contract fails that host's suite until the host reads it
 * instead of silently evaluating as closed.
 */
export function shellNavigationGateKeys(
  surface: ShellNavigationSurface
): readonly string[] {
  const keys = new Set<string>();
  const descriptors = [...SHELL_NAVIGATION_GROUPS, ...SHELL_NAVIGATION_ITEMS];
  for (const descriptor of descriptors) {
    for (const gate of descriptor.gates?.[surface] ?? []) {
      if (gate.key !== undefined) {
        keys.add(gate.key);
      }
    }
  }
  return Array.from(keys);
}
