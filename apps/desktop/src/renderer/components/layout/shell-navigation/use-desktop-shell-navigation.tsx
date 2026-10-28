import {
  type NavigationDestinationCount,
  withNavigationCounts,
} from "@repo/api/src/types/navigation-view-model";
import { useAgentsNavActivity } from "@repo/app/agents/hooks/use-agents-nav-activity";
import { useOptionalAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { useFeatureFlagSettleDeadline } from "@repo/app/shared/components/feature-flag-pending";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  type ShellNavigationGateDescriptor,
  ShellNavigationGateKind,
  ShellNavigationItemId,
  ShellNavigationSurface,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { useNavigationViewModel } from "@repo/app/shell/v2/hooks/use-navigation-view-model";
import { isActiveDestination } from "@repo/app/shell/v2/lib/active-destination";
import {
  buildNavigationSectionModel,
  type NavigationSectionModel,
} from "@repo/app/shell/v2/lib/navigation-section-model";
import {
  buildShellNavigationSectionInputs,
  type ShellNavigationHostResolution,
  shellNavigationDestinationIds,
} from "@repo/app/shell/v2/lib/shell-navigation-sections";
import type { ReactNode } from "react";
import { hrefForNavId, NavId } from "../../../navigation/route-table";
import { useDesktopNavGates } from "../../../navigation/use-nav-gates";
import { DesktopSidebarTeams } from "../../teams/desktop-sidebar-teams";
import {
  DesktopSidebarFooterItems,
  useDesktopSidebarSearch,
} from "../sidebar-shared-items";
import { desktopDestinationIcon } from "./desktop-shell-destination-icons";
import { resolveDesktopRoute } from "./desktop-shell-route-resolution";

export type DesktopShellNavigation = {
  /** The finished hierarchy, actor applied, in contract order. */
  readonly sections: readonly NavigationSectionModel[];
  readonly activePath: string | null;
  readonly renderControl: (controlId: string) => ReactNode;
  readonly renderIcon: (destinationId: string) => ReactNode;
  readonly footer: ReactNode;
};

type DesktopShellNavigationParams = {
  /** The nav id the shell is currently showing, route-table canonical. */
  readonly activeNav: NavId;
  /** Nav ids `App.tsx` has already resolved as hidden. Defaults to none. */
  readonly hiddenNavIds?: readonly NavId[];
};

/**
 * Everything the desktop shell hands the shared `ShellSidebar` (ISS-9734,
 * PLN-2016 D5–D8).
 *
 * This module is the DESKTOP half of "the same view model and the same offered
 * set render the same hierarchy on both shells". It answers only the four narrow
 * questions the shared builder asks — which surface, what a route resolves to,
 * whether a gate is open, whether a control is offered — and never orders or
 * groups anything itself; that belongs to the contract.
 *
 * It does NOT read `shell-sidebar-v2`. Which sidebar exists at all is decided
 * once, above, by `Sidebar`, and a read here could disagree with the tree it is
 * rendering inside.
 *
 * NO INBOX COUNT IS READ HERE, and that is the whole gate rather than a missing
 * one. `DESKTOP_SHELL_ROUTE_NAV_IDS` maps Inbox to null, so this shell has no
 * Inbox row to badge; the web mount gates its Liveblocks subscription on
 * availability because web offers Inbox whenever the shell renders, and the
 * desktop answer to the same question is not to open the subscription at all.
 */
export function useDesktopShellNavigation({
  activeNav,
  hiddenNavIds,
}: DesktopShellNavigationParams): DesktopShellNavigation {
  // Every desktop gate the contract declares, resolved ONCE by the host's
  // existing evaluator (PLN-2016 D6). `useDesktopNavGates` derives its per-item
  // map from `SHELL_NAVIGATION_ITEMS` itself, so a gate added to the contract is
  // resolved here the moment it is declared rather than defaulting open.
  const { desktopFlagsResolved, labsItemGates, labsNavOn } =
    useDesktopNavGates();
  const searchControl = useDesktopSidebarSearch();
  const teamsEnabled = useFeatureFlagEnabled(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  const { isLoaded, orgId, userId } = useOptionalAuthSnapshot();
  const hidden = hiddenNavIds ?? EMPTY_NAV_IDS;
  // D8: the CANONICAL nav id's href, not the raw hash path, so a session detail
  // and a route-table alias light the row they light today.
  const activePath = hrefForNavId(activeNav);
  // BOUNDED on purpose. A held read reports PENDING, which renders every row
  // non-navigable, and a PostHog assignment that never arrives would leave a
  // sidebar that never becomes clickable. Armed per unsettled window, because
  // this adapter outlives every wait it holds.
  const settleDeadlineElapsed = useFeatureFlagSettleDeadline(
    !desktopFlagsResolved
  );

  const host: ShellNavigationHostResolution = {
    isGateOpen: (gate) => isDesktopGateOpen(gate, { labsItemGates, labsNavOn }),
    // The Labs container gate decides whether Search is offered, mirroring the
    // legacy section that drops Search along with an empty Labs (operator ruling
    // 2026-09-01). Without it the contract's container-absent home would re-home
    // Search above the primary rows, which is the web answer, not this one.
    offersControl: (itemId) => {
      if (itemId === ShellNavigationItemId.Teams) {
        return teamsEnabled && labsNavOn && isLoaded && !!orgId && !!userId;
      }
      return itemId === ShellNavigationItemId.Search && labsNavOn;
    },
    resolveRoute: (routeId) => resolveDesktopRoute(routeId, hidden),
    surface: ShellNavigationSurface.Desktop,
  };

  const sectionInputs = buildShellNavigationSectionInputs(host);
  const destinationIds = shellNavigationDestinationIds(sectionInputs);
  // Drains the badge when Agents is the open route, on the same boundary the
  // composite lights the row with — and reads nothing at all when this tree has
  // no Agents row, which is the DEFAULT desktop shape: Labs ships closed and
  // takes the row with it, while the visit marker of anyone who opened Agents
  // once would otherwise hold a five-minute poll open for a row nobody renders.
  const agentsActivity = useAgentsNavActivity({
    isActive: isActiveDestination(activePath, hrefForNavId(NavId.Agents)),
    offered: destinationIds.includes(ShellNavigationItemId.Agents),
  });
  // Held until the PostHog assignment has actually arrived, which is when the
  // gates above stop reading closed-because-unresolved. The requested set is
  // derived from them, so an unheld read asks about the pre-resolution tree and
  // then asks again about the real one — a different id list is a different
  // query key, so nothing ever renders from the first.
  const viewModel = useNavigationViewModel(destinationIds, {
    enabled: desktopFlagsResolved || settleDeadlineElapsed,
  });

  // The route projects no counts, so the host layers its own onto it. Only the
  // count OBJECT crosses over, never the hook's `label`: that label folds a
  // pending or unavailable read to a settled zero and would announce "0 recently
  // finished sessions" while the read is still in flight (review constraint,
  // PR #7266). The badge's accessible name is built by the fold from the noun
  // the hook exports, which only a ready, presentable, non-zero count reaches.
  const counts = new Map<string, NavigationDestinationCount>();
  if (agentsActivity.count !== undefined) {
    counts.set(ShellNavigationItemId.Agents, agentsActivity.count);
  }

  return {
    activePath,
    footer: <DesktopSidebarFooterItems inviteClassName="text-sm" />,
    renderControl: (controlId) => {
      if (controlId === ShellNavigationItemId.Teams) {
        return <DesktopSidebarTeams />;
      }
      return controlId === ShellNavigationItemId.Search ? searchControl : null;
    },
    renderIcon: renderDesktopIcon,
    sections: buildNavigationSectionModel(
      sectionInputs,
      withNavigationCounts(viewModel, counts)
    ),
  };
}

const EMPTY_NAV_IDS: readonly NavId[] = [];

type DesktopGateState = {
  readonly labsItemGates: Readonly<Record<string, boolean>>;
  readonly labsNavOn: boolean;
};

/**
 * How each gate KIND is answered on this host. Exhaustive over
 * {@link ShellNavigationGateKind}, so a new kind fails `tsc` here rather than
 * falling through to a default that grants a destination nobody evaluated.
 *
 * A declared key with no resolved value is CLOSED, never open — the same rule
 * `resolveLabsItemGate` states for the route half.
 */
const DESKTOP_GATE_RESOLVERS: Record<
  ShellNavigationGateKind,
  (gate: ShellNavigationGateDescriptor, state: DesktopGateState) => boolean
> = {
  [ShellNavigationGateKind.DesktopLabsContainer]: (_gate, state) =>
    state.labsNavOn,
  [ShellNavigationGateKind.DesktopLabsItem]: (gate, state) =>
    gate.key !== undefined && state.labsItemGates[gate.key] === true,
  // A web-surface gate is never asked of a desktop resolution: `gatesOpen` only
  // walks the descriptors declared for this surface. Closed rather than absent,
  // because the one way it could arrive is a contract that moved a gate between
  // surfaces, and granting a row off that is worse than withdrawing one.
  [ShellNavigationGateKind.WebFeatureFlag]: () => false,
};

function isDesktopGateOpen(
  gate: ShellNavigationGateDescriptor,
  state: DesktopGateState
): boolean {
  return DESKTOP_GATE_RESOLVERS[gate.kind](gate, state);
}

function renderDesktopIcon(destinationId: string): ReactNode {
  const Icon = desktopDestinationIcon(destinationId);
  return Icon === null ? null : <Icon />;
}
