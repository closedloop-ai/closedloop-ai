/**
 * @file shell-navigation-sections.ts
 * @description The one builder that turns the shell navigation CONTRACT into the
 * ordered section inputs the sidebar fold consumes (ISS-9734, PLN-2016 D2).
 *
 * Both hosts call it. A host answers four narrow questions — which surface it
 * is, what a route resolves to there, whether a gate is open, and whether it
 * offers a control — and ORDER and GROUPING come only from the contract. That is
 * what makes "the same view model and the same offered set render the same
 * hierarchy on Web and Desktop" true by construction rather than by two adapters
 * happening to agree.
 *
 * It reads no rollout key: which shell exists at all is chosen once per shell,
 * at that shell's sidebar mount site, which reads `shell-sidebar-v2` and
 * branches between two whole trees (PLN-2016 D1/D6) — `GlobalSidebar` on web
 * today, and the desktop mount when that half lands. The source gate that used
 * to enforce this, `no-descendant-experience-flag-read`, was deleted along with
 * the `workspace-experience-v2` key it policed (ISS-10195); it is deliberately
 * NOT re-homed onto the new key. `no-threaded-feature-flag` covers the
 * threading half, and the web adapter's suite asserts it never reads that key.
 */
import {
  SHELL_NAVIGATION_GROUPS,
  SHELL_NAVIGATION_ITEMS,
  type ShellNavigationGateDescriptor,
  type ShellNavigationGroupDescriptor,
  ShellNavigationGroupId,
  type ShellNavigationItemDescriptor,
  ShellNavigationItemId,
  ShellNavigationItemKind,
  type ShellNavigationRouteId,
  type ShellNavigationSurface,
  type ShellNavigationSurfaceGateMap,
} from "../../../shared/lib/shell-navigation-contract";
import {
  type NavigationControlInput,
  NavigationControlPlacement,
  type NavigationCountNoun,
  type NavigationDestinationInput,
  type NavigationSectionInput,
} from "./navigation-section-model";

export type ShellNavigationRouteResolution = {
  /** Whether this host has the route at all, before any contract gate. */
  readonly offered: boolean;
  /** Where the row navigates. Null keeps a row that is not a link. */
  readonly href: string | null;
  /** See {@link NavigationDestinationInput.badgeMax}. */
  readonly badgeMax?: number;
  /** See {@link NavigationDestinationInput.countNoun}. */
  readonly countNoun?: NavigationCountNoun;
};

export type ShellNavigationHostResolution = {
  readonly surface: ShellNavigationSurface;
  readonly resolveRoute: (
    routeId: ShellNavigationRouteId
  ) => ShellNavigationRouteResolution;
  /** Asked only about gates the contract declares for {@link surface}. */
  readonly isGateOpen: (gate: ShellNavigationGateDescriptor) => boolean;
  readonly offersControl: (itemId: ShellNavigationItemId) => boolean;
};

/**
 * The sidebar hierarchy for one host, in contract order. Route items become
 * destinations, and control and dynamic-section items become controls.
 *
 * A closed group gate takes the group's own SECTION off the sidebar, not the
 * surfaces inside it: each member that declares a home for that case renders
 * there instead, with its own gates still applied
 * ({@link SHELL_CONTAINER_ABSENT_HOME}).
 */
export function buildShellNavigationSectionInputs(
  host: ShellNavigationHostResolution
): readonly NavigationSectionInput[] {
  const relocated = relocatedItemsByGroup(host);
  const sections: NavigationSectionInput[] = [];
  for (const group of SHELL_NAVIGATION_GROUPS) {
    if (group.parentId !== undefined) {
      continue;
    }
    const section = buildGroupSection(group, host, true, relocated);
    if (section !== null) {
      sections.push(section);
    }
  }
  return sections;
}

/**
 * The ids of the route destinations the host offers, in hierarchy order: what a
 * host asks the view-model route about. Controls are never included, because
 * the actor projection has nothing to say about them.
 */
export function shellNavigationDestinationIds(
  sections: readonly NavigationSectionInput[]
): string[] {
  const ids: string[] = [];
  collectOfferedDestinationIds(sections, ids);
  return ids;
}

type ShellSectionDisclosure = {
  readonly collapsible: boolean;
  readonly defaultOpen: boolean;
};

/**
 * How each contract group renders, or null for a group that is never a sidebar
 * section: Account's entries are workspace-menu commands (ISS-8363/8370) and
 * Gateway is empty. Exhaustive, so a new group fails `tsc` here until someone
 * decides whether and how it shows.
 *
 * Labs ships closed (PRD-690 R3, the prototype's `defaultOpen={false}`). Labs ›
 * Teams and Labs › Footer are headless runs of host controls, so they do not
 * collapse.
 */
const SHELL_SECTION_DISCLOSURE: Record<
  ShellNavigationGroupId,
  ShellSectionDisclosure | null
> = {
  [ShellNavigationGroupId.Primary]: { collapsible: false, defaultOpen: true },
  [ShellNavigationGroupId.Artifacts]: { collapsible: true, defaultOpen: true },
  [ShellNavigationGroupId.Labs]: { collapsible: true, defaultOpen: false },
  [ShellNavigationGroupId.LabsArtifacts]: {
    collapsible: true,
    defaultOpen: true,
  },
  [ShellNavigationGroupId.LabsTeams]: { collapsible: false, defaultOpen: true },
  [ShellNavigationGroupId.LabsFooter]: {
    collapsible: false,
    defaultOpen: true,
  },
  [ShellNavigationGroupId.Gateway]: null,
  [ShellNavigationGroupId.Account]: null,
};

function buildGroupSection(
  group: ShellNavigationGroupDescriptor,
  host: ShellNavigationHostResolution,
  parentOpen: boolean,
  relocated: RelocatedItems
): NavigationSectionInput | null {
  const disclosure = SHELL_SECTION_DISCLOSURE[group.id];
  if (disclosure === null) {
    return null;
  }
  const groupOpen = parentOpen && gatesOpen(group.gates, host);
  const items = SHELL_NAVIGATION_ITEMS.filter(
    (item) => item.groupId === group.id
  );
  const firstRouteIndex = items.findIndex(
    (item) => item.kind === ShellNavigationItemKind.Route
  );

  const destinations: NavigationDestinationInput[] = [];
  const controls: NavigationControlInput[] = [];
  for (const [index, item] of items.entries()) {
    pushItem(item, {
      controls,
      destinations,
      groupOpen,
      host,
      placement: controlPlacement(index, firstRouteIndex),
    });
  }
  // The re-homed nodes land after this group's own, so a group that receives
  // them still reads as itself with the returning rows appended, rather than as
  // a merged list whose order nobody chose.
  for (const entry of groupOpen ? (relocated.get(group.id) ?? []) : []) {
    pushItem(entry.item, {
      controls,
      destinations,
      groupOpen,
      host,
      placement: entry.placement ?? NavigationControlPlacement.Trailing,
    });
  }

  const sections: NavigationSectionInput[] = [];
  for (const child of SHELL_NAVIGATION_GROUPS) {
    if (child.parentId !== group.id) {
      continue;
    }
    const section = buildGroupSection(child, host, groupOpen, relocated);
    if (section !== null) {
      sections.push(section);
    }
  }

  return {
    id: group.id,
    label: group.label,
    collapsible: disclosure.collapsible,
    defaultOpen: disclosure.defaultOpen,
    destinations,
    controls,
    sections,
  };
}

function destinationInput(
  item: ShellNavigationItemDescriptor,
  host: ShellNavigationHostResolution,
  gatesAllow: boolean
): NavigationDestinationInput {
  if (item.routeId === undefined) {
    // A route item with no route id resolves on no host.
    return { id: item.id, label: item.label, href: null, offeredOnHost: false };
  }
  const route = host.resolveRoute(item.routeId);
  return {
    id: item.id,
    label: item.label,
    href: route.href,
    offeredOnHost: gatesAllow && route.offered,
    badgeMax: route.badgeMax,
    countNoun: route.countNoun,
  };
}

/**
 * A control is leading only when a route row follows it in its group, so a group
 * made entirely of controls (Labs › Teams, Labs › Footer) is all trailing.
 */
function controlPlacement(
  index: number,
  firstRouteIndex: number
): NavigationControlPlacement {
  if (firstRouteIndex !== -1 && index < firstRouteIndex) {
    return NavigationControlPlacement.Leading;
  }
  return NavigationControlPlacement.Trailing;
}

function gatesOpen(
  gates: ShellNavigationSurfaceGateMap | undefined,
  host: ShellNavigationHostResolution
): boolean {
  return (gates?.[host.surface] ?? []).every((gate) => host.isGateOpen(gate));
}

function collectOfferedDestinationIds(
  sections: readonly NavigationSectionInput[],
  ids: string[]
): void {
  for (const section of sections) {
    for (const destination of section.destinations ?? []) {
      if (destination.offeredOnHost) {
        ids.push(destination.id);
      }
    }
    collectOfferedDestinationIds(section.sections ?? [], ids);
  }
}

/** Where one node renders when the container it belongs to is closed. */
type ShellContainerAbsentHome = {
  readonly groupId: ShellNavigationGroupId;
  /**
   * Where a re-homed CONTROL sits among its new group's rows. Stated rather
   * than derived: the derivation reads a manifest index against the receiving
   * group's first route row, and every re-homed control sits after that row.
   */
  readonly placement?: NavigationControlPlacement;
};

/**
 * Where each node renders when the container it belongs to is CLOSED — the
 * shared reading of what `currentNavGroup` answers for the legacy web sidebar.
 *
 * A container answers WHERE these surfaces render, not WHETHER. Closing Labs
 * and taking its subtree with it leaves Dashboard, Sessions and Branches and
 * nothing else, which is exactly why the legacy arm switches to
 * `CURRENT_SIDEBAR_SHAPE` instead of reading the moved grouping through a closed
 * gate: `labs-nav-section` is outside `DEV_MODE_EXEMPT_FLAG_KEYS`, so the
 * customer view forces it closed for every viewer.
 *
 * `null` means three different things, and the difference matters. For a surface
 * the container genuinely owns it decides nothing on its own: that surface
 * already declares the container's key as its OWN gate — on web Insights, Packs,
 * Lost work, TokenOps waste and Judges; on desktop those plus Approvals,
 * Requests, Plans, Help and Agents — so the removal comes
 * from the item's gate and this table only declines to re-home it. The dev-mode
 * switch is `null` because the host re-homes it into its own sidebar footer, and
 * a second home here would render it twice. Your Teams is `null` because
 * ISS-11248 gave it no home outside Labs at all: with the container closed it
 * is ABSENT, which is what Desktop has always rendered and what web owed it.
 *
 * Exhaustive over {@link ShellNavigationItemId}, for the reason
 * `NAV_LABS_MOVE_RETAINED_ROUTE_IDS` spells out: a partial record or a set of
 * the re-homed ids widens to `string`, so an item added later would compile,
 * miss the inventory, and silently leave the shell with its container.
 */
const SHELL_CONTAINER_ABSENT_HOME: Record<
  ShellNavigationItemId,
  ShellContainerAbsentHome | null
> = {
  [ShellNavigationItemId.Dashboard]: null,
  [ShellNavigationItemId.Sessions]: null,
  [ShellNavigationItemId.Branches]: null,
  [ShellNavigationItemId.Inbox]: { groupId: ShellNavigationGroupId.Primary },
  [ShellNavigationItemId.MyIssues]: null,
  [ShellNavigationItemId.Insights]: null,
  [ShellNavigationItemId.Approvals]: null,
  [ShellNavigationItemId.Requests]: null,
  [ShellNavigationItemId.Documents]: null,
  [ShellNavigationItemId.Issues]: null,
  [ShellNavigationItemId.Agents]: { groupId: ShellNavigationGroupId.Artifacts },
  [ShellNavigationItemId.MyTasks]: { groupId: ShellNavigationGroupId.Primary },
  [ShellNavigationItemId.Packs]: null,
  [ShellNavigationItemId.LostWork]: null,
  [ShellNavigationItemId.TokenOpsWaste]: null,
  [ShellNavigationItemId.Judges]: null,
  [ShellNavigationItemId.Plans]: null,
  [ShellNavigationItemId.Diagnostics]: null,
  [ShellNavigationItemId.Settings]: null,
  [ShellNavigationItemId.Help]: null,
  // Above the primary rows, which is where the legacy fallback shape puts it.
  [ShellNavigationItemId.Search]: {
    groupId: ShellNavigationGroupId.Primary,
    placement: NavigationControlPlacement.Leading,
  },
  // ISS-11248: `null` because Your Teams has NO home outside Labs any more. It
  // used to re-home after the Artifacts rows, mirroring the legacy web shape —
  // and that placement was leaking an internal-only surface to every viewer the
  // customer view closes Labs for. The operator ruled on 2026-09-26 that it is
  // hidden rather than relocated, which is also what Desktop has always
  // rendered, so one table now gives both surfaces the same answer.
  [ShellNavigationItemId.Teams]: null,
  [ShellNavigationItemId.TeamFavorites]: null,
  [ShellNavigationItemId.DevMode]: null,
};

type RelocatedItem = {
  readonly item: ShellNavigationItemDescriptor;
  readonly placement?: NavigationControlPlacement;
};

type RelocatedItems = ReadonlyMap<
  ShellNavigationGroupId,
  readonly RelocatedItem[]
>;

/**
 * The nodes whose own container is closed and that declare a home for that
 * case, keyed by the group receiving them.
 *
 * Their own gates are NOT consulted here — only the container's. A re-homed node
 * still passes every gate it declares once it reaches its new group, so the
 * container's absence changes where a row renders and never whether its own gate
 * is honoured.
 */
function relocatedItemsByGroup(
  host: ShellNavigationHostResolution
): RelocatedItems {
  const relocated = new Map<ShellNavigationGroupId, RelocatedItem[]>();
  const containerOpen = new Map<ShellNavigationGroupId, boolean>();
  for (const item of SHELL_NAVIGATION_ITEMS) {
    const home = SHELL_CONTAINER_ABSENT_HOME[item.id];
    if (home === null || isContainerOpen(item.groupId, host, containerOpen)) {
      continue;
    }
    const entries = relocated.get(home.groupId) ?? [];
    entries.push({ item, placement: home.placement });
    relocated.set(home.groupId, entries);
  }
  return relocated;
}

/** Whether every gate from `groupId` up through its ancestors is open. */
function isContainerOpen(
  groupId: ShellNavigationGroupId,
  host: ShellNavigationHostResolution,
  cache: Map<ShellNavigationGroupId, boolean>
): boolean {
  const cached = cache.get(groupId);
  if (cached !== undefined) {
    return cached;
  }
  const group = SHELL_NAVIGATION_GROUPS.find(
    (candidate) => candidate.id === groupId
  );
  const open =
    group !== undefined &&
    gatesOpen(group.gates, host) &&
    (group.parentId === undefined ||
      isContainerOpen(group.parentId, host, cache));
  cache.set(groupId, open);
  return open;
}

type PushItemTarget = {
  readonly controls: NavigationControlInput[];
  readonly destinations: NavigationDestinationInput[];
  readonly groupOpen: boolean;
  readonly host: ShellNavigationHostResolution;
  readonly placement: NavigationControlPlacement;
};

function pushItem(
  item: ShellNavigationItemDescriptor,
  target: PushItemTarget
): void {
  const itemOpen = target.groupOpen && gatesOpen(item.gates, target.host);
  if (item.kind === ShellNavigationItemKind.Route) {
    target.destinations.push(destinationInput(item, target.host, itemOpen));
    return;
  }
  target.controls.push({
    id: item.id,
    offeredOnHost: itemOpen && target.host.offersControl(item.id),
    placement: target.placement,
  });
}
