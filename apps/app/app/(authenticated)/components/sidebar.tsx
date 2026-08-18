"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import { AgentsNavBadge } from "@repo/app/agents/components/agents-nav-badge";
import { useScrollFade } from "@repo/app/shared/hooks/use-scroll-fade";
import {
  ArtifactFlag,
  JUDGES_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  AGENTS_NAV_PATH,
  PRIMARY_NAV_DESTINATIONS,
  type PrimaryNavDestination,
  PrimaryNavGroup,
} from "@repo/app/shared/lib/primary-nav-destinations";
import { isAdminRole } from "@repo/app/shared/lib/role-utils";
import { useOrganization } from "@repo/auth/client";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarNavLinkItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { cn } from "@repo/design-system/lib/utils";
import { usePath } from "@repo/navigation/use-path";
import { useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { BarChart3, Coins, PackageIcon, TimerOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ComputeTargetPopover } from "@/components/compute-target-popover";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { AccountMenu } from "./account-menu";
import { InboxBadge } from "./inbox-badge";
import { Search } from "./search";
import { SidebarTeams } from "./sidebar-teams";

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
   * Agents activity badge, so renaming the visible title never detaches it.
   */
  path?: string;
};

// Per-item feature flags for the Artifacts nav section. Flag-gated items are
// gated individually; the Artifacts header is hidden when every gated item is
// off AND no always-on item survives. Issues shares its flag with the page
// route (see @repo/app/shared/lib/feature-flags). Agents (FEA-3994) and, as of
// FEA-4155, Branches/Sessions are always-on and carry no flag.
const ArtifactNavFlag = {
  Issues: ArtifactFlag.Issues,
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
    disabled: false,
    featureFlag: destination.featureFlag,
  };
}

function buildNavData(orgSlug: string) {
  // Derive the top-level and Artifacts nav rows from the shared canonical
  // destination list (the same source of truth the mobile bottom nav renders),
  // so a destination added there reaches both navs in the same order with the
  // same flag gating — no hand-maintained parallel copy to keep in sync.
  const topLevel: NavItem[] = PRIMARY_NAV_DESTINATIONS.filter(
    (destination) => destination.group === PrimaryNavGroup.TopLevel
  ).map((destination) => primaryDestinationToNavItem(orgSlug, destination));

  const artifacts: NavItem[] = PRIMARY_NAV_DESTINATIONS.filter(
    (destination) => destination.group === PrimaryNavGroup.Artifact
  ).map((destination) => primaryDestinationToNavItem(orgSlug, destination));

  const labs: NavItem[] = [
    {
      title: "Insights",
      url: `/${orgSlug}/insights`,
      icon: BarChart3,
      disabled: false,
      featureFlag: INSIGHTS_FEATURE_FLAG_KEY,
    },
    {
      title: "Lost work",
      url: `/${orgSlug}/insights/lost-work`,
      // Distinct from the Insights bar chart beside it: three identical icons
      // stacked means the icon stops doing any work. Lost work is about time
      // burnt, TokenOps is about money.
      icon: TimerOff,
      disabled: false,
    },
    {
      title: "TokenOps waste",
      url: `/${orgSlug}/insights/tokenops-waste`,
      icon: Coins,
      disabled: false,
    },
    {
      title: "Judges",
      url: `/${orgSlug}/judges-analytics`,
      icon: BarChart3,
      disabled: false,
      featureFlag: JUDGES_FEATURE_FLAG_KEY,
    },
    {
      title: "Packs",
      url: `/${orgSlug}/packs`,
      icon: PackageIcon,
      disabled: false,
    },
  ];

  return {
    topLevel,
    artifacts,
    labs,
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
  const orgSlug = useOrgSlug();
  const { organization, membership } = useOrganization();
  const isAdmin = isAdminRole(membership?.role);
  const queryClient = useQueryClient();
  const prevOrgIdRef = useRef<string | undefined>(undefined);
  const data = buildNavData(orgSlug);
  // Some Labs items may be admin-only; hide those from non-admins rather than
  // surface a bouncing link.
  const labsItems = data.labs.filter((item) => !item.adminOnly || isAdmin);
  const { ref: scrollRef, showTopFade, showBottomFade } = useScrollFade();

  // Clear cache when organization changes
  useEffect(() => {
    const currentOrgId = organization?.id;

    // Skip on initial load
    if (prevOrgIdRef.current === undefined) {
      prevOrgIdRef.current = currentOrgId;
      return;
    }

    // Clear cache when org ID changes
    if (prevOrgIdRef.current !== currentOrgId) {
      queryClient.clear();
      prevOrgIdRef.current = currentOrgId;
    }
  }, [organization?.id, queryClient]);

  return (
    <>
      <Sidebar variant="inset">
        <Search />
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
                    <SidebarNavLinkItem
                      className="text-sm"
                      disabled={item.disabled}
                      href={item.disabled ? undefined : item.url}
                      icon={<item.icon />}
                      isActive={
                        !item.disabled &&
                        isNavItemActive(pathname ?? "", item.url)
                      }
                      key={item.title}
                      title={item.title}
                      tooltip={item.title}
                      trailing={
                        item.title === "Inbox" ? <InboxBadge /> : undefined
                      }
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

            <SidebarTeams />

            <LabsNavSection items={labsItems} pathname={pathname ?? ""} />
          </SidebarContent>
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-sidebar to-transparent transition-opacity duration-200",
              showBottomFade ? "opacity-100" : "opacity-0"
            )}
          />
        </div>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <ComputeTargetPopover />
            </SidebarMenuItem>
            {envBadge && (
              <SidebarMenuItem>
                <div className="w-full rounded border border-warning/30 bg-warning/12 px-2 py-1.5">
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
                    <span className="font-bold font-mono text-[9px] text-warning-foreground uppercase tracking-wider">
                      local
                    </span>
                  </div>
                  <p
                    className="truncate font-mono text-[9px] text-warning-foreground/60 leading-tight"
                    title={envBadge}
                  >
                    {envBadge}
                  </p>
                </div>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <AccountMenu />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
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
  // Branches/Sessions are always-on now (their destinations carry no
  // featureFlag), so only Issues remains flag-gated here.
  const issuesEnabled =
    useFeatureFlag(ArtifactNavFlag.Issues)?.enabled === true;
  // Routines is gated behind the PostHog `routines` flag until GA. Resolve it
  // here (before the mounted guard, rules-of-hooks) so `visibleItems` keeps the
  // Routines row when the flag is ON — omitting it would drop the row from the
  // section entirely, hiding Routines even for a flag-ON user (one-way gate).
  const routinesEnabled =
    useFeatureFlag(ROUTINES_FEATURE_FLAG_KEY)?.enabled === true;

  if (!mounted) {
    return null;
  }

  const enabledByFlag: Record<string, boolean> = {
    [ArtifactNavFlag.Issues]: issuesEnabled,
    [ROUTINES_FEATURE_FLAG_KEY]: routinesEnabled,
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
        {visibleItems.map((item) => {
          const isActive =
            !item.disabled && isNavItemActive(pathname, item.url);
          return (
            <SidebarNavLinkItem
              className="text-sm"
              disabled={item.disabled}
              href={item.disabled ? undefined : item.url}
              icon={<item.icon />}
              isActive={isActive}
              key={item.title}
              title={item.title}
              tooltip={item.title}
              trailing={
                item.path === AGENTS_NAV_PATH ? (
                  <AgentsNavBadge isActive={isActive} />
                ) : undefined
              }
            />
          );
        })}
      </SidebarMenu>
    </SidebarCollapsibleSection>
  );
}

const LABS_NAV_SECTION_STORAGE_KEY = "closedloop.app.sidebar.labs.open";

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
 */
function LabsNavSection({
  items,
  pathname,
}: {
  items: NavItem[];
  pathname: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const labsEnabled =
    useFeatureFlag(LABS_NAV_SECTION_FEATURE_FLAG_KEY)?.enabled === true;

  if (!(mounted && labsEnabled)) {
    return null;
  }

  return (
    <SidebarCollapsibleSection
      persistenceKey={LABS_NAV_SECTION_STORAGE_KEY}
      title="Labs"
    >
      <SidebarMenu className="gap-0">
        {items.map((item) =>
          maybeFeatureFlagged(
            item,
            <SidebarNavLinkItem
              className="text-sm"
              disabled={item.disabled}
              href={item.disabled ? undefined : item.url}
              icon={<item.icon />}
              isActive={!item.disabled && isNavItemActive(pathname, item.url)}
              key={item.title}
              title={item.title}
              tooltip={item.title}
            />
          )
        )}
      </SidebarMenu>
    </SidebarCollapsibleSection>
  );
}
