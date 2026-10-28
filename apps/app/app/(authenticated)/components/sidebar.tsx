"use client";

import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { AgentsNavBadge } from "@repo/app/agents/components/agents-nav-badge";
import { GuidedGettingStartedCard } from "@repo/app/onboarding/components/guided-getting-started-card";
import { DevModeSidebarItem } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-sidebar-item";
import { FeatureFlagged } from "@repo/app/shared/feature-flags/feature-flagged";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import { useScrollFade } from "@repo/app/shared/hooks/use-scroll-fade";
import {
  AGENTS_NAV_FEATURE_FLAG_KEY,
  ArtifactFlag,
  JUDGES_FEATURE_FLAG_KEY,
  LOST_WORK_NAV_FEATURE_FLAG_KEY,
  SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY,
  TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  AGENTS_NAV_PATH,
  currentNavGroup,
  INBOX_NAV_PATH,
  labsMovedNavGroup,
  PRIMARY_NAV_DESTINATIONS,
  type PrimaryNavDestination,
  PrimaryNavGroup,
} from "@repo/app/shared/lib/primary-nav-destinations";
import { isAdminRole } from "@repo/app/shared/lib/role-utils";
import { useRetiredMetricCardSnapshotCleanup } from "@repo/app/shared/query/retired-metric-card-snapshot-cleanup";
import { useOrganization } from "@repo/auth/client";
import { LiveblocksErrorBoundary } from "@repo/collaboration/client/liveblocks-error-boundary";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarNavLinkItem,
  SidebarSeparator,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { cn } from "@repo/design-system/lib/utils";
import { usePath } from "@repo/navigation/use-path";
import type { LucideIcon } from "lucide-react";
import { BarChart3, Coins, PackageIcon, TimerOff } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useFeatureFlagsSettledForUser } from "@/components/feature-flags-settled";
import { useClearQueryCacheOnOrgChange } from "@/hooks/use-clear-query-cache-on-org-change";
import { useNavOrgSlug } from "@/hooks/use-org-slug";
import { WebGuidedOnboardingDialogHost } from "./guided-onboarding-dialog-host";
import { InboxBadge } from "./inbox-badge";
import { Search } from "./search";
import { WebShellSidebar } from "./shell-navigation/web-shell-sidebar";
import { SidebarChrome, WorkspaceSidebarHeader } from "./sidebar-chrome";
import { SidebarTeams } from "./sidebar-teams";
import {
  useLabsMenuVisible,
  useLabsNavMoveVisible,
} from "./use-labs-nav-move-visible";

type GlobalSidebarProperties = {
  readonly children: ReactNode;
  readonly envBadge?: string | null;
};

type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  disabled: boolean;
  featureFlag?: string;
  /** When true, the item is only rendered for org admins/owners. */
  adminOnly?: boolean;
  /**
   * Org-relative destination path (no `/${orgSlug}` prefix), when the item maps
   * to a canonical primary destination. Stable identity used to attach the
   * Agents and Inbox badges, so renaming the visible title never detaches them
   * — and so a destination that changes SECTION keeps its badge (ISS-8759).
   */
  path?: string;
};

// Per-item feature flags for the Artifacts nav section. Flag-gated items are
// gated individually; the Artifacts header is hidden when every gated item is
// off AND no always-on item survives. Issues shares its flag with the page
// route (see @repo/app/shared/lib/feature-flags), and so does Agents. As of
// FEA-4155, Branches/Sessions are always-on and carry no flag.
//
// ISS-5041/ISS-7835: Agents is gated again — FEA-3994 had graduated it to
// always-on, which is precisely why dev mode could not produce the customer
// view. There was no flag for customer-view suppression to act on, so a staff
// viewer who turned dev mode off still saw Agents.
const ArtifactNavFlag = {
  Documents: ArtifactFlag.Documents,
  Issues: ArtifactFlag.Issues,
  Agents: AGENTS_NAV_FEATURE_FLAG_KEY,
} as const;

function primaryDestinationToNavItem(
  orgSlug: string,
  destination: PrimaryNavDestination
): NavItem {
  return {
    title: destination.title,
    url: `/${orgSlug}${destination.path}`,
    path: destination.path,
    icon: destination.icon,
    disabled: !orgSlug,
    featureFlag: destination.featureFlag,
  };
}

// ISS-7344: an empty `orgSlug` is "the active org has not resolved yet", and
// every `url` below would interpolate it into a protocol-relative `//…`. Every
// href site already reads `item.disabled ? undefined : item.url`, so marking the
// rows disabled is what keeps that string out of the DOM — and keeps the shell
// from linking into an org it cannot yet name.
//
// `groupOf` is which READING of the canonical list to use. Owned by the
// canonical module, so `PrimaryNavGroup` stays the one owner of grouping and
// this file never re-derives a nav model.
function buildNavData(
  orgSlug: string,
  groupOf: (destination: PrimaryNavDestination) => PrimaryNavGroup
) {
  // Derive the top-level and Artifacts nav rows from the shared canonical
  // destination list (the same source of truth the mobile bottom nav renders),
  // so a destination added there reaches both navs in the same order with the
  // same flag gating — no hand-maintained parallel copy to keep in sync.
  const inGroup = (group: PrimaryNavGroup): NavItem[] =>
    PRIMARY_NAV_DESTINATIONS.filter(
      (destination) => groupOf(destination) === group
    ).map((destination) => primaryDestinationToNavItem(orgSlug, destination));

  // Labs surfaces that are NOT canonical primary destinations — they have no
  // `PRIMARY_NAV_DESTINATIONS` entry, so no regrouping can reach them.
  const labsNative: NavItem[] = [
    {
      title: "Insights",
      url: `/${orgSlug}/insights`,
      icon: BarChart3,
      disabled: !orgSlug,
      featureFlag: INSIGHTS_FEATURE_FLAG_KEY,
    },
    {
      title: "Lost work",
      url: `/${orgSlug}/insights/lost-work`,
      // Distinct from the Insights bar chart beside it: three identical icons
      // stacked means the icon stops doing any work. Lost work is about time
      // burnt, TokenOps is about money.
      icon: TimerOff,
      disabled: !orgSlug,
      featureFlag: LOST_WORK_NAV_FEATURE_FLAG_KEY,
    },
    {
      title: "TokenOps waste",
      url: `/${orgSlug}/insights/tokenops-waste`,
      icon: Coins,
      disabled: !orgSlug,
      featureFlag: TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
    },
    {
      title: JUDGES_NAV_TITLE,
      url: `/${orgSlug}/judges-analytics`,
      icon: BarChart3,
      disabled: !orgSlug,
      featureFlag: JUDGES_FEATURE_FLAG_KEY,
    },
    {
      title: "Packs",
      url: `/${orgSlug}/packs`,
      icon: PackageIcon,
      disabled: !orgSlug,
    },
  ];

  return {
    topLevel: inGroup(PrimaryNavGroup.TopLevel),
    artifacts: inGroup(PrimaryNavGroup.Artifact),
    labs: [...inGroup(PrimaryNavGroup.Labs), ...labsNative],
  };
}

function isNavItemActive(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`));
}

export function GlobalSidebar({
  children,
  envBadge = null,
}: GlobalSidebarProperties) {
  const pathname = usePath();
  const orgSlug = useNavOrgSlug();
  // PLN-2016 D1: the ONE read of the rollout key, at the mount site, choosing
  // between two whole trees. The boolean is never passed down, so no descendant
  // of either arm can re-answer it and disagree with the tree it renders in.
  const shellSidebarV2Rollout = useFeatureFlagEnabled(
    SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY
  );
  // AND the assignment must describe THIS user. The client keeps serving the
  // anonymous bootstrap value across the post-identify reload, so a bootstrap
  // `true` would mount v2 for a user whose real assignment is off — and would
  // keep it mounted, because a failed `/flags` never delivers the correction.
  // For a closed-by-default rollout key that is the policy inverted, so an
  // unresolved answer keeps the legacy tree. Unbounded on purpose, unlike the
  // adapter's view-model hold: the fallback here is the whole working legacy
  // sidebar, not a tree of non-navigable rows, so there is nothing a deadline
  // would rescue.
  const flagsSettledForUser = useFeatureFlagsSettledForUser();
  // AND not before mount, the same guard `useLabsNavMoveVisible` states for the
  // other gate in this shell. Settled does not cover it: a build with no PostHog
  // key reports settled from the very first render and resolves the key off the
  // local fixture, which `readFallbackFeatureFlagFixture` reads only when
  // `globalThis.window` is defined — so the server renders the legacy tree and
  // the client's first render would render v2. That disagreement is the whole
  // sidebar subtree, not one row.
  const mounted = useIsMounted();
  const shellSidebarV2Enabled =
    mounted && flagsSettledForUser && shellSidebarV2Rollout;
  const { organization, membership } = useOrganization();
  const isAdmin = isAdminRole(membership?.role);
  // ISS-9888 / ISS-9891: whether the Labs container is present, and therefore
  // whether Labs owns the surfaces ISS-8759 moved into it. Read once, used at
  // BOTH ends of every move, so nothing can be in two homes or in none.
  const labsOwnsControls = useLabsNavMoveVisible();
  // The MENU's own predicate, read here because this is the site that swaps the
  // footer between the fallback row and nothing. It is not `labsOwnsControls`
  // narrowed by hand: `useLabsMenuVisible` already ANDs the shape in.
  const labsMenuVisible = useLabsMenuVisible();
  // ISS-10244 retired `nav-labs-move`, so the Labs-moved layout is no longer
  // one of two rollout positions — it is the shape the sidebar takes WHENEVER
  // Labs is there to receive it. ISS-11248 then split the two questions that
  // one key used to answer, and only the SHAPE half is decided here:
  //
  // `labs-nav-section` (`labsOwnsControls`) picks the SHAPE. Off — outside the
  // rollout, and forced for every viewer in the customer view, because the key
  // is not in `DEV_MODE_EXEMPT_FLAG_KEYS` — the nav keeps its pre-move groups,
  // so Inbox, My Tasks, Documents, Issues, Agents and Search render
  // in their own homes. Reading the canonical list through `labsMovedNavGroup`
  // in THAT position would take them out of the nav with nothing to receive
  // them, which is why this key answers WHERE a destination renders rather
  // than whether it renders at all.
  //
  // `enable-labs-nav-section` (`labsMenuVisible`) picks the MENU MOUNT, and
  // that one is not shape at all: with the shape open and the mount closed,
  // `LabsNavSection` returns `null` and the moved destinations are out of the
  // nav — deliberately, because the shape has already taken them out of their
  // pre-move groups. They stay reachable by URL (Documents, Inbox, My Tasks,
  // Issues and Agents are ungated routes; Insights, Packs, Judges
  // and Help gate on `labs-nav-section`, which is open in that position), so
  // re-homing them here would undo the move instead of rescuing anything.
  //
  // ISS-11248 carved Your Teams out of that rule. It is internal-only and has no
  // pre-Labs home any more: the operator ruled on 2026-09-26 that with the
  // container absent it is simply HIDDEN, not relocated, so web stops leaking
  // it to a customer in the customer view and matches what desktop has always
  // rendered. The dev-mode switch is the one control that still keeps a
  // fallback, because it is the way back OUT of that view.
  const shape = labsOwnsControls
    ? LABS_MOVED_SIDEBAR_SHAPE
    : CURRENT_SIDEBAR_SHAPE;
  const data = buildNavData(orgSlug, shape.groupOf);
  // Some Labs items may be admin-only; hide those from non-admins rather than
  // surface a bouncing link. Nothing ISS-8759 moves sets `adminOnly`, and the
  // moved Search control is not a NavItem at all, so this filter cannot make a
  // moved surface admin-only.
  const labsItems = data.labs.filter((item) => !item.adminOnly || isAdmin);
  // The sidebar's fallback home for the dev-mode switch (PR #6961). ISS-10195
  // retired the workspace-experience gate and with it the account menu that used
  // to carry the fallback row, so this footer row is now the ONLY way back:
  // without it, turning dev mode OFF would unmount Labs (suppression) and strand
  // the viewer in the customer view. It keys off whether the MENU renders, not
  // off the shape: the shape going to 100% with `enable-labs-nav-section` closed
  // leaves `LabsControls` — which is where the switch lives — inside a section
  // that never mounts, so a shape-only predicate here would leave the whole
  // legacy shell with no dev-mode switch at all. Same one-owner predicate as the
  // menu mount, so the switch keeps exactly one home in every gate position; the
  // row itself renders nothing for a viewer who cannot operate dev mode.
  const devModeInV2Footer = labsMenuVisible ? null : <DevModeSidebarItem />;
  const { ref: scrollRef, showTopFade, showBottomFade } = useScrollFade();

  useClearQueryCacheOnOrgChange(organization?.id);
  // ISS-9897 retired the metric-card snapshot store. Its reader is gone, but
  // `localStorage` has no expiry, so an upgraded profile still carries the
  // entries the previous build wrote. Reclaimed here — where the store's own
  // owner-reconciliation sweep used to be mounted — so the bytes go whatever
  // route the profile lands on first, not only the Sessions page.
  useRetiredMetricCardSnapshotCleanup();

  const nav = (
    <>
      {shape.searchAboveNav}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-4 bg-gradient-to-b from-sidebar to-transparent transition-opacity duration-200",
            showTopFade ? "opacity-100" : "opacity-0"
          )}
        />
        <SidebarContent
          className="scrollbar-overlay gap-1 pt-2"
          ref={scrollRef}
        >
          <SidebarGroup className="p-1">
            <SidebarMenu className="gap-0">
              {data.topLevel.map((item) =>
                maybeFeatureFlagged(
                  item,
                  <NavLinkRow
                    item={item}
                    key={item.title}
                    pathname={pathname ?? ""}
                  />
                )
              )}
            </SidebarMenu>
          </SidebarGroup>

          <ArtifactsNavSection
            isAdmin={isAdmin}
            items={data.artifacts}
            pathname={pathname ?? ""}
          />

          <LabsNavSection
            items={labsItems}
            leading={shape.searchInLabs}
            pathname={pathname ?? ""}
            persistenceKey={shape.labsPersistenceKey}
          >
            {shape.teamsInLabs}
            {labsOwnsControls ? <LabsControls /> : null}
          </LabsNavSection>
        </SidebarContent>
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-sidebar to-transparent transition-opacity duration-200",
            showBottomFade ? "opacity-100" : "opacity-0"
          )}
        />
      </div>
    </>
  );
  const gettingStartedCard = (
    <GuidedGettingStartedCard
      analysisStarted={false}
      host={OnboardingHost.Web}
    />
  );

  return (
    <>
      <WebGuidedOnboardingDialogHost />
      {shellSidebarV2Enabled ? (
        <WebShellSidebar envBadge={envBadge} />
      ) : (
        <Sidebar variant="inset">
          <SidebarChrome
            envBadge={envBadge}
            footerEntries={devModeInV2Footer}
            footerLead={gettingStartedCard}
            header={<WorkspaceSidebarHeader />}
          >
            {nav}
          </SidebarChrome>
        </Sidebar>
      )}
      <SidebarInset>{children}</SidebarInset>
    </>
  );
}

function maybeFeatureFlagged(item: NavItem, children: ReactNode): ReactNode {
  if (item.featureFlag) {
    return (
      <FeatureFlagged flag={item.featureFlag} key={item.title}>
        {children}
      </FeatureFlagged>
    );
  }
  return children;
}

/**
 * The badge a nav row carries, keyed by canonical destination path rather than
 * by which SECTION renders the row. ISS-8759 moves Inbox and Agents into Labs;
 * the badges used to be resolved per-section — Inbox by title in the top-level
 * block, Agents by path in Artifacts, neither in Labs — so the move would have
 * silently dropped both.
 */
function navItemTrailing(item: NavItem, isActive: boolean): ReactNode {
  if (item.path === INBOX_NAV_PATH) {
    return (
      <LiveblocksErrorBoundary>
        <InboxBadge />
      </LiveblocksErrorBoundary>
    );
  }
  if (item.path === AGENTS_NAV_PATH) {
    return <AgentsNavBadge isActive={isActive} />;
  }
  return undefined;
}

/**
 * One nav row. Extracted because the badge unification above made the three
 * sections' rows identical; keeping three copies is what let them drift.
 */
function NavLinkRow({ item, pathname }: { item: NavItem; pathname: string }) {
  const isActive = !item.disabled && isNavItemActive(pathname, item.url);
  return (
    <SidebarNavLinkItem
      className="text-sm"
      disabled={item.disabled}
      href={item.disabled ? undefined : item.url}
      icon={<item.icon />}
      isActive={isActive}
      title={item.title}
      tooltip={item.title}
      trailing={navItemTrailing(item, isActive)}
    />
  );
}

function ArtifactsNavSection({
  items,
  pathname,
  isAdmin,
}: {
  items: NavItem[];
  pathname: string;
  isAdmin: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Resolve every flag used by the artifact items up front so the hook call
  // order stays stable across renders (rules-of-hooks). The header below is
  // only rendered when at least one item survives flag filtering. FEA-4155:
  // Branches/Sessions are always-on (their destinations carry no featureFlag);
  // Documents, Issues and — since ISS-5041 — Agents are the gated ones.
  // Documents and Issues stay in this section in both shapes; under ISS-8759's
  // move Agents renders in Labs instead, and its flag is applied there by
  // `maybeFeatureFlagged`.
  const documentsEnabled = useFeatureFlagEnabled(ArtifactNavFlag.Documents);
  const issuesEnabled = useFeatureFlagEnabled(ArtifactNavFlag.Issues);
  // ISS-5041/ISS-7835: Agents is gated again, default off. Resolved here with
  // the other artifact flags (rules-of-hooks) so the row — and the
  // `AgentsNavBadge` that rides on it as `trailing` — drop together when the
  // flag is off. The badge cannot outlive the row: it is rendered as a prop OF
  // the row, so filtering the row out removes both.
  const agentsEnabled = useFeatureFlagEnabled(ArtifactNavFlag.Agents);

  if (!mounted) {
    return null;
  }

  const enabledByFlag: Record<string, boolean> = {
    [ArtifactNavFlag.Documents]: documentsEnabled,
    [ArtifactNavFlag.Issues]: issuesEnabled,
    [ArtifactNavFlag.Agents]: agentsEnabled,
  };

  const visibleItems = items.filter((item) => {
    if (item.adminOnly && !isAdmin) {
      return false;
    }
    return item.featureFlag === undefined || enabledByFlag[item.featureFlag];
  });

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <SidebarCollapsibleSection title="Artifacts">
      <SidebarMenu className="gap-0">
        {visibleItems.map((item) => (
          <NavLinkRow item={item} key={item.title} pathname={pathname} />
        ))}
      </SidebarMenu>
    </SidebarCollapsibleSection>
  );
}

export const LABS_NAV_SECTION_STORAGE_KEY = "closedloop.app.sidebar.labs.open";

/**
 * ISS-8759: the moved Labs section persists under its OWN key.
 *
 * A user who collapsed today's Labs — five optional extras — wrote `"false"`
 * under {@link LABS_NAV_SECTION_STORAGE_KEY}. Reusing that key would let the
 * pre-rollout preference decide the post-rollout section, whose contents are no
 * longer optional: Your Teams and six moved routes would hydrate collapsed for
 * that user, leaving a sidebar of Dashboard/Sessions/Branches plus a collapsed
 * header. The preference is not wrong, it is about a DIFFERENT section, so the
 * move gets a key nobody has written and `defaultOpen` (open) decides the first
 * render.
 *
 * Two keys, not a migration: the flag-off shape keeps reading and writing the
 * original key untouched, so a rollback restores the user's real Labs
 * preference rather than whatever they did to the moved section.
 */
export const LABS_MOVED_NAV_SECTION_STORAGE_KEY =
  "closedloop.app.sidebar.labs-moved.open";

/**
 * ISS-5037 (ISS-4779 closed-by-default): the Labs nav section behind ONE
 * container flag, default off.
 *
 * Flag off returns `null` — no header, no items, no empty collapsed shell —
 * rather than rendering an empty `SidebarCollapsibleSection`, which would still
 * occupy the sidebar and invite a click. The `mounted` guard mirrors
 * `ArtifactsNavSection`: it avoids a hydration mismatch while PostHog resolves,
 * and because the pre-resolution render is `null` the section stays CLOSED
 * during that window instead of flashing on.
 *
 * The container flag sits ABOVE the per-item gates, it does not replace them:
 * each item still passes through `maybeFeatureFlagged` (its own `featureFlag`)
 * and the caller's `adminOnly` filter is applied before the items reach here.
 * Toggling the container writes nothing to those per-item values, so flipping
 * it back on restores exactly what was showing before.
 *
 * ISS-8759: `leading` and `children` are the slots the moved NON-item surfaces
 * render into — the Search control, the Your Teams dynamic section — so a
 * control and a dynamic section can join the move without a second Labs
 * container. Both are plain nodes: the caller composes the shape, and nothing
 * here re-reads the flag that chose it.
 *
 * Both render INSIDE the collapsible body: `leading` above the rows, `children`
 * below them. So everything that moved under Labs shares the section's fate —
 * collapsing it hides Search with the rows, and the container flag being off
 * removes Search entirely along with the section. Operator ruling 2026-09-01:
 * "search should not be visible when Labs is not present or collapsed." An
 * earlier revision pinned Search outside the body via a `leading` prop added to
 * `SidebarCollapsibleSection`; that ruling retired both the behaviour and the
 * shared-primitive API change, so the slot is app-local again.
 */
function LabsNavSection({
  items,
  pathname,
  persistenceKey,
  leading,
  children,
}: {
  items: NavItem[];
  pathname: string;
  persistenceKey: string;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const labsMenuVisible = useLabsMenuVisible();

  if (!(mounted && labsMenuVisible)) {
    return null;
  }

  return (
    <SidebarCollapsibleSection persistenceKey={persistenceKey} title="Labs">
      {leading}
      <SidebarMenu className="gap-0">
        {items.map((item) =>
          maybeFeatureFlagged(
            item,
            <NavLinkRow item={item} key={item.title} pathname={pathname} />
          )
        )}
      </SidebarMenu>
      {children}
    </SidebarCollapsibleSection>
  );
}

/**
 * The two whole sidebar shapes the Labs container picks between.
 *
 * Each names the grouping the canonical destination list is read through, where
 * Search — the one non-nav surface that has a home on both shapes — renders,
 * and which localStorage key the Labs section persists under. Written out as
 * two complete shapes so a reader can see both at once, and so no consumer has
 * to re-derive "is Labs there" from a boolean handed down to it.
 *
 * Your Teams renders in ONE shape only. ISS-11248 retired its pre-Labs home
 * rather than moving it, so the `teamsAboveLabs` slot that carried it is gone
 * from both shapes rather than left permanently `null`. `teamsInLabs` still
 * exists on both and is `null` here, because `shape` is read as the union of the
 * two objects and every slot one names the other must name too.
 */
const CURRENT_SIDEBAR_SHAPE = {
  groupOf: currentNavGroup,
  labsPersistenceKey: LABS_NAV_SECTION_STORAGE_KEY,
  searchAboveNav: <Search />,
  searchInLabs: null,
  teamsInLabs: null,
} as const;

const LABS_MOVED_SIDEBAR_SHAPE = {
  groupOf: labsMovedNavGroup,
  labsPersistenceKey: LABS_MOVED_NAV_SECTION_STORAGE_KEY,
  searchAboveNav: null,
  searchInLabs: <Search />,
  // Nested inside the Labs group, so it drops its own group inset rather than
  // double-inseting against its siblings — the same `nested` delta
  // `packages/app/shell/v2/components/shell-sidebar.tsx` already applies to a
  // section inside a section.
  teamsInLabs: <SidebarTeams className="px-0 py-1" />,
} as const;

/**
 * The CONTROL Labs takes over: the dev-mode switch (ISS-9891, from the account
 * menu).
 *
 * Last inside the collapsible body, after the rows and Your Teams: Labs reads as
 * destinations first, then the things you operate. It shares the section's
 * fate the same way Search does — collapsing Labs takes it with it — which is
 * the operator's 2026-09-01 ruling applied to the slot it now lives in.
 *
 * Renders no heading of its own, but it does open with a `SidebarSeparator`:
 * the rule is what marks the join where "go somewhere" becomes "change
 * something", at less cost than a heading.
 *
 * Nothing here reads a flag: the caller resolved the placement once, and only
 * the dev-mode switch has a second home to be rendered into instead.
 */
function LabsControls() {
  return (
    <>
      <SidebarSeparator className="my-1" />
      <SidebarMenu className="gap-0">
        <DevModeSidebarItem />
      </SidebarMenu>
    </>
  );
}

export const JUDGES_NAV_TITLE = "Judges";
