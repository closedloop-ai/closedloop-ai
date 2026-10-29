"use client";

import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import {
  type NavigationDestinationCount,
  withNavigationCounts,
} from "@repo/api/src/types/navigation-view-model";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { useAgentsNavActivity } from "@repo/app/agents/hooks/use-agents-nav-activity";
import {
  AGENTS_NAV_BADGE_MAX,
  AGENTS_NAV_COUNT_NOUN,
} from "@repo/app/agents/lib/agents-nav-count";
import { GuidedGettingStartedCard } from "@repo/app/onboarding/components/guided-getting-started-card";
import { useFeatureFlagSettleDeadline } from "@repo/app/shared/components/feature-flag-pending";
import { DevModeSidebarItem } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-sidebar-item";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import {
  ArtifactFlag,
  JUDGES_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LOST_WORK_NAV_FEATURE_FLAG_KEY,
  TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { WEB_SHELL_ROUTE_HREFS } from "@repo/app/shared/lib/primary-nav-destinations";
import {
  type ShellNavigationGateDescriptor,
  ShellNavigationGroupId,
  ShellNavigationItemId,
  ShellNavigationRouteId,
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
  type ShellNavigationRouteResolution,
  shellNavigationDestinationIds,
} from "@repo/app/shell/v2/lib/shell-navigation-sections";
import {
  SidebarMenu,
  SidebarSeparator,
} from "@repo/design-system/components/ui/sidebar";
import { usePath } from "@repo/navigation/use-path";
import type { ReactNode } from "react";
import { useFeatureFlagsSettledForUser } from "@/components/feature-flags-settled";
import { useNavOrgSlug } from "@/hooks/use-org-slug";
import { Search } from "../search";
import { SidebarEnvBadge } from "../sidebar-chrome";
import { SidebarTeams } from "../sidebar-teams";
import {
  useLabsMenuVisible,
  useLabsNavMoveVisible,
} from "../use-labs-nav-move-visible";
import { webDestinationIcon } from "./web-shell-destination-icons";

export type WebShellNavigation = {
  /** The finished hierarchy, actor applied, in contract order. */
  readonly sections: readonly NavigationSectionModel[];
  readonly activePath: string | null;
  readonly renderControl: (controlId: string) => ReactNode;
  readonly renderIcon: (destinationId: string) => ReactNode;
  readonly footer: ReactNode;
};

type WebShellNavigationParams = {
  /** The local-dev API origin badge, or null off localhost. */
  readonly envBadge: string | null;
  /**
   * The unread-inbox count, read by whichever component owns the subscription
   * (`web-shell-sidebar.tsx`) and handed in rather than read here.
   *
   * This adapter is mounted on every authenticated page, and Liveblocks has a
   * bootstrap window where `CollaborationProviderWrapper` holds inbox hooks off
   * with `isAvailable === false`. A subscription opened from here would run
   * through that window and on every page whether or not an Inbox row exists,
   * which is the read the legacy `InboxBadge` avoids by mounting the counting
   * component inside the row.
   */
  readonly inboxCount: NavigationDestinationCount;
};

/**
 * Everything the web shell hands the shared `ShellSidebar` (ISS-9734,
 * PLN-2016 D5–D8): the folded hierarchy, the host controls, the footer, and the
 * active path.
 *
 * This module is the WEB half of "the same view model and the same offered set
 * render the same hierarchy on both shells". It answers only the four narrow
 * questions the shared builder asks — which surface, what a route resolves to,
 * whether a gate is open, whether a control is offered — and never orders or
 * groups anything itself; that belongs to the contract.
 *
 * It does NOT read `shell-sidebar-v2`. Which sidebar exists at all is decided
 * once, above, by `GlobalSidebar`, and a read here could disagree with the tree
 * it is rendering inside.
 */
export function useWebShellNavigation({
  envBadge,
  inboxCount,
}: WebShellNavigationParams): WebShellNavigation {
  const orgSlug = useNavOrgSlug();
  const activePath = usePath() ?? null;
  const mounted = useIsMounted();
  const flagsSettledForUser = useFeatureFlagsSettledForUser();
  const settleDeadlineElapsed = useFeatureFlagSettleDeadline(
    !flagsSettledForUser
  );

  // Every web gate key the contract declares, each read EXACTLY ONCE, here
  // (PLN-2016 D6). `useLabsNavMoveVisible` owns the `labs-nav-section` read and
  // its mounted guard, and is the one module that answers "is Labs there to
  // receive what ISS-8759/9888/9891 moved into it" — so this module consumes
  // that answer instead of reading the key a second time and risking a
  // different one at the two ends of the same move.
  const labsOwnsControls = useLabsNavMoveVisible();
  // The MENU's own answer, which is NOT the gate above. `labs-nav-section` keeps
  // deciding the SHAPE — which group each moved destination belongs to, whether
  // a closed container re-homes it, and whether its route resolves — and stays
  // the value the gate map below publishes. Whether the Labs SECTION mounts at
  // all is `enable-labs-nav-section`, read here through the one hook that ANDs
  // the shape in. Without this split, rolling `shell-sidebar-v2` out would show
  // the Labs menu to everyone the shape flag reaches.
  const labsMenuVisible = useLabsMenuVisible();
  const insightsEnabled = useFeatureFlagEnabled(INSIGHTS_FEATURE_FLAG_KEY);
  const judgesEnabled = useFeatureFlagEnabled(JUDGES_FEATURE_FLAG_KEY);
  const lostWorkEnabled = useFeatureFlagEnabled(LOST_WORK_NAV_FEATURE_FLAG_KEY);
  const tokenOpsWasteEnabled = useFeatureFlagEnabled(
    TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY
  );
  const documentsEnabled = useFeatureFlagEnabled(ArtifactFlag.Documents);
  const issuesEnabled = useFeatureFlagEnabled(ArtifactFlag.Issues);
  const agentsEnabled = useFeatureFlagEnabled(AGENTS_NAV_FLAG_KEY);
  // ISS-10006 — the two web utility routes, each behind the key that already
  // gates its surface on desktop rather than a second one minted for the mount.
  const diagnosticsEnabled = useFeatureFlagEnabled(
    DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY
  );
  const helpEnabled = useFeatureFlagEnabled(HELP_COMPLETE_SURFACE_FLAG_KEY);

  // Before mount every gate reads CLOSED, matching the legacy sections that
  // render `null` until mounted: an unresolved flag must not disagree with the
  // server render, and the pre-resolution answer is the narrower tree.
  const gates: ReadonlyMap<string, boolean> = new Map([
    [LABS_NAV_SECTION_FEATURE_FLAG_KEY, labsOwnsControls],
    [INSIGHTS_FEATURE_FLAG_KEY, mounted && insightsEnabled],
    [JUDGES_FEATURE_FLAG_KEY, mounted && judgesEnabled],
    [LOST_WORK_NAV_FEATURE_FLAG_KEY, mounted && lostWorkEnabled],
    [TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY, mounted && tokenOpsWasteEnabled],
    [ArtifactFlag.Documents, mounted && documentsEnabled],
    [ArtifactFlag.Issues, mounted && issuesEnabled],
    [AGENTS_NAV_FLAG_KEY, mounted && agentsEnabled],
    [DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY, mounted && diagnosticsEnabled],
    [HELP_COMPLETE_SURFACE_FLAG_KEY, mounted && helpEnabled],
  ]);

  const host: ShellNavigationHostResolution = {
    isGateOpen: (gate) => isGateOpen(gates, gate),
    offersControl: (itemId) => WEB_OFFERED_CONTROLS.has(itemId),
    resolveRoute: (routeId) => resolveWebRoute(orgSlug, routeId),
    surface: ShellNavigationSurface.Web,
  };

  // The menu mount, applied to the BUILT sections rather than to a gate, and
  // deliberately so. A second gate on the Labs group would also close the
  // container, and a closed container re-homes Inbox, My Tasks, Agents and
  // Search back into the nav
  // (`SHELL_CONTAINER_ABSENT_HOME`) — the opposite of what the shape at 100% is
  // for. Dropping the section after the build leaves the shape exactly as the
  // contract computed it and removes only the render, which is precisely what
  // `LabsNavSection` returning `null` does on the legacy arm.
  const builtSections = buildShellNavigationSectionInputs(host);
  const sectionInputs = labsMenuVisible
    ? builtSections
    : builtSections.filter(
        (section) => section.id !== ShellNavigationGroupId.Labs
      );
  const destinationIds = shellNavigationDestinationIds(sectionInputs);
  // Drains the badge when Agents is the open route, on the same boundary the
  // composite lights the row with — and reads nothing at all when this tree has
  // no Agents row, so a closed gate does not leave a five-minute poll running
  // for a row the sidebar never renders.
  const agentsActivity = useAgentsNavActivity({
    isActive: isActiveDestination(
      activePath,
      webHref(orgSlug, ShellNavigationRouteId.Agents)
    ),
    offered: destinationIds.includes(ShellNavigationItemId.Agents),
  });
  // Held until PostHog has answered FOR THE SIGNED-IN USER, which is when the
  // gates above stop reading closed-because-unresolved. The requested set is
  // derived from them, so an unheld read asks about the pre-resolution tree and
  // then asks again about the real one — a different id list is a different
  // query key, so nothing ever renders from the first.
  //
  // `mounted` stays alongside it because it answers a different question: a
  // build with no PostHog key reports settled from the very first render, and
  // that render is still the pre-mount one whose gates all read closed.
  //
  // BOUNDED on purpose. A held read reports PENDING, which renders every row
  // non-navigable, and a failed `/flags` leaves the settled signal false forever
  // (ISS-4566) — a sidebar that never becomes clickable is a worse answer than a
  // second read. The bound is armed PER UNSETTLED WINDOW, not once: this adapter
  // outlives every wait it holds, and a deadline epoched on its mount would
  // expire once and then wave the next window straight through — a mid-session
  // `identify()` flag reload would issue its read against gates that have gone
  // back to reading closed.
  const viewModel = useNavigationViewModel(destinationIds, {
    enabled: mounted && (flagsSettledForUser || settleDeadlineElapsed),
  });

  // The route projects no counts, so the host layers its own onto it. Only the
  // count OBJECT crosses over, never the hook's `label`: that label folds a
  // pending or unavailable read to a settled zero and would announce "0 recently
  // finished sessions" while the read is still in flight (review constraint,
  // PR #7266). The badge's accessible name is built by the fold from the noun
  // below, which only a ready, presentable, non-zero count ever reaches.
  const counts = new Map<string, NavigationDestinationCount>([
    [ShellNavigationItemId.Inbox, inboxCount],
  ]);
  if (agentsActivity.count !== undefined) {
    counts.set(ShellNavigationItemId.Agents, agentsActivity.count);
  }

  return {
    activePath,
    footer: (
      <>
        <GuidedGettingStartedCard
          analysisStarted={false}
          host={OnboardingHost.Web}
        />
        <SidebarMenu>
          <SidebarEnvBadge envBadge={envBadge} />
          {/* ISS-11248: the dev-mode switch is the ONLY control with a home
              outside Labs; this row stays because it is the way back out of
              the customer view that closes Labs. It
              keys off the MENU, not the shape: with the shape at 100% and the
              menu closed the switch's home inside Labs never mounts, so a
              shape-only predicate would leave this shell with no way in or out
              of the customer view. */}
          {labsMenuVisible ? null : <DevModeSidebarItem />}
        </SidebarMenu>
      </>
    ),
    renderControl: renderWebControl,
    renderIcon: renderWebIcon,
    sections: buildNavigationSectionModel(
      sectionInputs,
      withNavigationCounts(viewModel, counts)
    ),
  };
}

/**
 * The controls this host renders. `TeamFavorites` is absent because
 * `SidebarTeams` renders favorites itself — offering it as a second control
 * would put favorites in the model twice and render them once, which reads as a
 * bug the first time someone counts the rows.
 */
const WEB_OFFERED_CONTROLS: ReadonlySet<string> = new Set<string>([
  ShellNavigationItemId.Search,
  ShellNavigationItemId.Teams,
  ShellNavigationItemId.DevMode,
]);

/** What the Inbox count counts, for the badge's accessible name. */
export const INBOX_NAV_COUNT_NOUN = "unread notifications" as const;

function renderWebControl(controlId: string): ReactNode {
  if (controlId === ShellNavigationItemId.Search) {
    return <Search />;
  }
  if (controlId === ShellNavigationItemId.Teams) {
    // Nested inside the Labs group, so it drops its own group inset rather than
    // double-inseting against its siblings.
    return <SidebarTeams className="px-0 py-1" />;
  }
  if (controlId === ShellNavigationItemId.DevMode) {
    // The rule marks where "go somewhere" becomes "change something". It rides
    // the first control of the footer group rather than being drawn by the
    // group, because the model hands controls over one at a time. The dev-mode
    // switch is the footer group's only control, matching the legacy sidebar's
    // `LabsControls`.
    return (
      <>
        <SidebarSeparator className="my-1" />
        <SidebarMenu className="gap-0">
          <DevModeSidebarItem />
        </SidebarMenu>
      </>
    );
  }
  return null;
}

function renderWebIcon(destinationId: string): ReactNode {
  const Icon = webDestinationIcon(destinationId);
  return Icon === null ? null : <Icon />;
}

function resolveWebRoute(
  orgSlug: string,
  routeId: ShellNavigationRouteId
): ShellNavigationRouteResolution {
  // Offered is about the SHELL, not the org: a route this build does not ship
  // has no row, while a route whose org slug has not resolved keeps its row and
  // loses only its link — exactly what the legacy sidebar's disabled rows do.
  const offered = WEB_SHELL_ROUTE_HREFS[routeId] !== null;
  const href = webHref(orgSlug, routeId);
  if (routeId === ShellNavigationRouteId.Agents) {
    // The cap and the noun are the ones the count's hook and the legacy badge
    // read, so the two cannot disagree on how it reads or where it overflows.
    return {
      badgeMax: AGENTS_NAV_BADGE_MAX,
      countNoun: AGENTS_NAV_COUNT_NOUN,
      href,
      offered,
    };
  }
  if (routeId === ShellNavigationRouteId.Inbox) {
    // No cap: "47 unread" and "9+" are different facts to the person reading it.
    return { countNoun: INBOX_NAV_COUNT_NOUN, href, offered };
  }
  return { href, offered };
}

function webHref(
  orgSlug: string,
  routeId: ShellNavigationRouteId
): string | null {
  const path = WEB_SHELL_ROUTE_HREFS[routeId];
  if (path === null || !orgSlug) {
    return null;
  }
  return `/${orgSlug}${path}`;
}

/**
 * A gate the adapter does not read is CLOSED, never open. A key reaching here
 * that this module never read is a gate nobody evaluated, and opening a row on
 * that would grant a destination off an unasked question.
 */
function isGateOpen(
  gates: ReadonlyMap<string, boolean>,
  gate: ShellNavigationGateDescriptor
): boolean {
  if (gate.key === undefined) {
    return false;
  }
  return gates.get(gate.key) ?? false;
}
