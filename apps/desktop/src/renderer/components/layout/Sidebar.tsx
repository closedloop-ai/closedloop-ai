import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarNavLinkItem,
  Sidebar as SidebarRoot,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@closedloop-ai/design-system/components/ui/sidebar-collapsible-section";
import { AgentsNavBadge } from "@repo/app/agents/components/agents-nav-badge";
import { useOptionalAuthSnapshot } from "@repo/app/shared/auth/use-auth-snapshot";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
  SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { ReactNode } from "react";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../../shared/feature-flags-labs-detail";
import {
  type NavEntry,
  NavSection,
  navItemsForSection,
} from "../../navigation/nav-config";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { DesktopGuidedOnboardingDialogHost } from "../onboarding/desktop-guided-onboarding-dialog-host";
import { DesktopSidebarTeams } from "../teams/desktop-sidebar-teams";
import { DesktopShellSidebar } from "./shell-navigation/desktop-shell-sidebar";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "./sidebar-persistence";
import {
  DesktopSidebarFooterItems,
  SidebarMacDragStrip,
  useDesktopFooterKeepsInvite,
  useDesktopSidebarSearch,
} from "./sidebar-shared-items";
import { DesktopWorkspaceHeaderSlot } from "./workspace-header-slot";

type SidebarProps = {
  activeNav: NavId;
  /** Nav ids to omit (e.g. feature-flagged-off routes). Defaults to none. */
  hiddenNavIds?: readonly NavId[];
};

/**
 * The desktop sidebar mount, and the ONE site on this shell that reads the v2
 * rollout key (ISS-9734, PLN-2016 D1).
 *
 * The key picks between two WHOLE trees rather than being handed down, so no
 * descendant can re-answer it and disagree with the tree it renders inside. Off
 * is today's sidebar, unchanged — and off is what every read that has not
 * resolved, every errored read and everyone outside the rollout gets, because
 * `DesktopFeatureFlagProvider` resolves the signed-in account's PostHog
 * assignment and fails closed on every other outcome. One key covers both
 * shells (ISS-4779): there is no desktop Labs toggle to pair with it and no
 * desktop flag-registry entry to add.
 *
 * The guided-onboarding dialog host sits OUTSIDE the branch, so it mounts under
 * both arms exactly as it did before there were two.
 */
export function Sidebar({ activeNav, hiddenNavIds }: SidebarProps) {
  const shellSidebarV2Enabled = useFeatureFlagEnabled(
    SHELL_SIDEBAR_V2_FEATURE_FLAG_KEY
  );

  return (
    <>
      <DesktopGuidedOnboardingDialogHost />
      {shellSidebarV2Enabled ? (
        <DesktopShellSidebar
          activeNav={activeNav}
          hiddenNavIds={hiddenNavIds}
        />
      ) : (
        <LegacyDesktopSidebar
          activeNav={activeNav}
          hiddenNavIds={hiddenNavIds}
        />
      )}
    </>
  );
}

/**
 * Today's desktop sidebar, mirroring the finalized web GlobalSidebar: the
 * top-level / Artifacts / Labs nav structure from nav-config, the Search control
 * inside Labs, the guided-onboarding recovery card in the footer under every
 * experience (ISS-8353), and the workspace header (ISS-8370 D7, below).
 * ISS-10195 retired the workspace-experience gate and deleted the legacy footer
 * account menu, so this tree has no experience branching of its own. Items
 * render port links (hrefForNavId), so navigation flows through the desktop
 * navigation adapter exactly like shared component links do.
 *
 * ISS-8759 (desktop mirror, operator direction 2026-09-03): Search moved out of
 * the fixed slot above the nav and into the Labs section, and the Gateway group
 * folded into Labs with everything else. Which SECTION an entry lands in stays
 * owned by `nav-config`'s `displaySection` — this file renders the sections it
 * is handed and never re-derives the grouping.
 *
 * It is NOT dead code while `shell-sidebar-v2` is closed by default: it is what
 * every desktop user has. Retiring it is the flag-retirement step — delete the
 * read, keep the on branch, delete this one, follow the orphans.
 */
function LegacyDesktopSidebar({ activeNav, hiddenNavIds }: SidebarProps) {
  const searchControl = useDesktopSidebarSearch();
  const footerKeepsInvite = useDesktopFooterKeepsInvite();
  const isHidden = (entry: NavEntry) =>
    hiddenNavIds?.includes(entry.id) ?? false;
  const visible = (section: Parameters<typeof navItemsForSection>[0]) =>
    navItemsForSection(section).filter((entry) => !isHidden(entry));

  const mainItems = visible(NavSection.Main);
  const artifactItems = visible(NavSection.Artifacts);
  const labsItems = visible(NavSection.Labs);

  return (
    <SidebarRoot collapsible="offcanvas" variant="inset">
      <SidebarMacDragStrip />
      {/* ISS-8370 D7: the workspace menu heads navigation and owns the
          account menu's old destinations (Settings, Diagnostics, the guest
          door). The guided card STAYS in the desktop footer — it is onboarding
          recovery that no menu owns.

          ISS-10362 moved the invite entry OUT of that footer and into this
          menu, where web's invite row already sits. Members is still
          unavailable here (ISS-8368 — Clerk's `<OrganizationProfile>` cannot
          mount in this renderer), so what the menu gained is an invite-only row
          rather than web's "Invite and manage members": the dialog needs
          nothing but `POST /organizations/invitations`, which desktop has. */}
      <WorkspaceSidebarHeader />
      <SidebarContent className="gap-1 pt-2">
        {mainItems.length > 0 && (
          <SidebarGroup className="px-0 py-1">
            <NavSectionMenu activeNav={activeNav} items={mainItems} />
          </SidebarGroup>
        )}

        {artifactItems.length > 0 && (
          <SidebarCollapsibleSection className="px-0 py-1" title="Artifacts">
            <NavSectionMenu activeNav={activeNav} items={artifactItems} />
          </SidebarCollapsibleSection>
        )}

        <LabsNavSection
          activeNav={activeNav}
          items={labsItems}
          leading={searchControl}
        />
      </SidebarContent>
      {/* `pb-1` only once the invite row has actually left this footer: the
          guided card is then the last child and would otherwise sit flush
          against the sidebar's bottom edge. While the row is still here — a
          signed-in reader with the key closed, or ISS-11247's signed-in reader
          whose workspace menu cannot hold the entry — nothing about the shipped
          footer moves. ISS-10942: a guest never holds it, so the padding
          reads the same hook rather than the key alone. */}
      <SidebarFooter
        className={`px-0 pt-1 ${footerKeepsInvite ? "pb-0" : "pb-1"}`}
      >
        <DesktopSidebarFooterItems />
      </SidebarFooter>
    </SidebarRoot>
  );
}

/**
 * The v2 header (ISS-8370 D7): the workspace menu at the top of navigation,
 * wrapped the way `packages/app/shell/v2/components/shell-sidebar.tsx` wraps
 * its `workspaceHeader` slot, so the node lands in the same place under both
 * arms — which is also why the slot's contents are shared rather than spelled
 * out here (ISS-10362 gave them the arrival nudge's anchor).
 */
function WorkspaceSidebarHeader() {
  return (
    <SidebarHeader className="px-0 pt-1 pb-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <DesktopWorkspaceHeaderSlot />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}

function NavSectionMenu({
  items,
  activeNav,
}: {
  items: NavEntry[];
  activeNav: NavId;
}) {
  return (
    <SidebarMenu className="gap-0">
      {items.map((item) => {
        const isActive = activeNav === item.id;
        return (
          <SidebarNavLinkItem
            className="text-sm"
            href={hrefForNavId(item.id)}
            icon={<item.icon />}
            isActive={isActive}
            key={item.id}
            title={item.label}
            tooltip={item.label}
            trailing={
              item.id === NavId.Agents ? (
                // The badge reads its org scope from the injected auth port, so
                // the per-org last-visited marker is scoped automatically — a
                // shared machine with more than one desktop login no longer
                // drains one org's badge with another's visit.
                <AgentsNavBadge isActive={isActive} />
              ) : undefined
            }
          />
        );
      })}
    </SidebarMenu>
  );
}

/**
 * The Labs sidebar section, and the one place a non-item surface joins it.
 *
 * `leading` renders INSIDE the collapsible body, above the rows — deliberately.
 * Operator ruling 2026-09-01, carried over from web's ISS-8759: "search should
 * not be visible when Labs is not present or collapsed." So collapsing Labs
 * hides Search with the rows, and the `labsNav` container gate emptying the
 * section (every id lands in `hiddenNavIds`) removes Search along with it.
 *
 * The section ships CLOSED, so on first load Search is not on screen. That is
 * the intended reading of the ruling above, not a regression: the PostHog
 * `labsNav` flag is what opens this surface, and a localStorage default must not
 * stand in for it (operator ruling 2026-09-03, "Labs ships closed under the
 * PostHog FF").
 *
 * The slot is app-local composition — plain children of the shared
 * `SidebarCollapsibleSection`. Web tried pinning Search outside the body via a
 * `leading` prop ADDED to that shared primitive; the same ruling retired both
 * the behaviour and the API change, so the primitive stays untouched here.
 */
function LabsNavSection({
  items,
  activeNav,
  leading,
}: {
  items: NavEntry[];
  activeNav: NavId;
  leading?: ReactNode;
}) {
  const teamsEnabled = useFeatureFlagEnabled(
    PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
  );
  const labsEnabled = useFeatureFlagEnabled(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY);
  const { isLoaded, orgId, userId } = useOptionalAuthSnapshot();
  if (
    items.length === 0 &&
    !(teamsEnabled && labsEnabled && isLoaded && orgId && userId)
  ) {
    return null;
  }
  return (
    <SidebarCollapsibleSection
      className="px-0 py-1"
      // ISS-4478: Labs starts collapsed by default (expands on click, its open
      // state then persists). Explicitly `false` rather than derived from
      // FOCUS_MODE so it stays collapsed even if FOCUS_MODE is later turned off.
      //
      // Unchanged by the Search/Gateway move, deliberately. The gate that
      // decides whether this surface exists is the PostHog `labsNav` flag; a
      // localStorage default is not a gate and must not act like one (operator
      // ruling 2026-09-03). Keeping the original key with it: with a collapsed
      // default, a fresh key would buy nothing and would discard the preference
      // of the one user it touches — someone who had EXPANDED Labs and whose
      // stored `"true"` is still exactly what they asked for.
      defaultOpen={false}
      persistenceKey={DESKTOP_LABS_NAV_SECTION_STORAGE_KEY}
      title="Labs"
    >
      {leading}
      <NavSectionMenu activeNav={activeNav} items={items} />
      <DesktopSidebarTeams />
    </SidebarCollapsibleSection>
  );
}
