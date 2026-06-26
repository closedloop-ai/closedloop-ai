"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { useScrollFade } from "@repo/app/shared/hooks/use-scroll-fade";
import {
  AGENTS_FEATURE_FLAG_KEY,
  ArtifactFlag,
  JUDGES_FEATURE_FLAG_KEY,
  SESSIONS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
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
import {
  BarChart3,
  BotIcon,
  CopyCheckIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  RotateCcwIcon,
  SquareCheckIcon,
} from "lucide-react";
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
};

// Per-item feature flags for the Artifacts nav section. Every item is gated
// individually; the Artifacts header is hidden when none are enabled.
// Documents/Issues/Branches share their flags with the page routes (see
// @repo/app/shared/lib/feature-flags); Sessions/Agents reuse flags that gate
// them elsewhere.
const ArtifactNavFlag = {
  Documents: ArtifactFlag.Documents,
  Issues: ArtifactFlag.Issues,
  Branches: ArtifactFlag.Branches,
  Sessions: SESSIONS_FEATURE_FLAG_KEY,
  Agents: AGENTS_FEATURE_FLAG_KEY,
} as const;

function buildNavData(orgSlug: string) {
  const topLevel: NavItem[] = [
    {
      title: "Dashboard",
      url: `/${orgSlug}/dashboard`,
      icon: LayoutDashboardIcon,
      disabled: false,
    },
    {
      title: "Inbox",
      url: `/${orgSlug}/inbox`,
      icon: InboxIcon,
      disabled: false,
    },
    {
      title: "My Issues",
      url: `/${orgSlug}/my-tasks`,
      icon: CopyCheckIcon,
      disabled: false,
    },
  ];

  const artifacts: NavItem[] = [
    {
      title: "Documents",
      url: `/${orgSlug}/documents`,
      icon: FileIcon,
      disabled: false,
      featureFlag: ArtifactNavFlag.Documents,
    },
    {
      title: "Issues",
      url: `/${orgSlug}/issues`,
      icon: SquareCheckIcon,
      disabled: false,
      featureFlag: ArtifactNavFlag.Issues,
    },
    {
      title: "Sessions",
      url: `/${orgSlug}/sessions`,
      icon: HistoryIcon,
      disabled: false,
      featureFlag: ArtifactNavFlag.Sessions,
    },
    {
      title: "Branches",
      url: `/${orgSlug}/branches`,
      icon: GitBranchIcon,
      disabled: false,
      featureFlag: ArtifactNavFlag.Branches,
    },
    {
      title: "Agents",
      url: `/${orgSlug}/agents`,
      icon: BotIcon,
      disabled: false,
      featureFlag: ArtifactNavFlag.Agents,
    },
  ];

  const labs: NavItem[] = [
    {
      title: "Insights",
      url: `/${orgSlug}/insights`,
      icon: BarChart3,
      disabled: false,
      featureFlag: INSIGHTS_FEATURE_FLAG_KEY,
    },
    {
      title: "Loops",
      url: `/${orgSlug}/loops`,
      icon: RotateCcwIcon,
      disabled: false,
    },
    {
      title: "Agent Monitoring",
      url: `/${orgSlug}/loops/monitoring`,
      icon: BarChart3,
      disabled: false,
      featureFlag: SESSIONS_FEATURE_FLAG_KEY,
    },
    {
      title: "Judges",
      url: `/${orgSlug}/judges-analytics`,
      icon: BarChart3,
      disabled: false,
      featureFlag: JUDGES_FEATURE_FLAG_KEY,
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
  const { organization } = useOrganization();
  const queryClient = useQueryClient();
  const prevOrgIdRef = useRef<string | undefined>(undefined);
  const data = buildNavData(orgSlug);
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
              items={data.artifacts}
              pathname={pathname ?? ""}
            />

            <SidebarTeams />

            <SidebarCollapsibleSection
              persistenceKey={LABS_NAV_SECTION_STORAGE_KEY}
              title="Labs"
            >
              <SidebarMenu className="gap-0">
                {data.labs.map((item) =>
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
                    />
                  )
                )}
              </SidebarMenu>
            </SidebarCollapsibleSection>
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
}: {
  items: NavItem[];
  pathname: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Resolve every flag used by the artifact items up front so the hook call
  // order stays stable across renders (rules-of-hooks). The header below is
  // only rendered when at least one item survives flag filtering.
  const documentsEnabled =
    useFeatureFlag(ArtifactNavFlag.Documents)?.enabled === true;
  const issuesEnabled =
    useFeatureFlag(ArtifactNavFlag.Issues)?.enabled === true;
  const branchesEnabled =
    useFeatureFlag(ArtifactNavFlag.Branches)?.enabled === true;
  const sessionsEnabled =
    useFeatureFlag(ArtifactNavFlag.Sessions)?.enabled === true;
  const agentsEnabled =
    useFeatureFlag(ArtifactNavFlag.Agents)?.enabled === true;

  if (!mounted) {
    return null;
  }

  const enabledByFlag: Record<string, boolean> = {
    [ArtifactNavFlag.Documents]: documentsEnabled,
    [ArtifactNavFlag.Issues]: issuesEnabled,
    [ArtifactNavFlag.Branches]: branchesEnabled,
    [ArtifactNavFlag.Sessions]: sessionsEnabled,
    [ArtifactNavFlag.Agents]: agentsEnabled,
  };

  const visibleItems = items.filter(
    (item) => item.featureFlag === undefined || enabledByFlag[item.featureFlag]
  );

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <SidebarCollapsibleSection title="Artifacts">
      <SidebarMenu className="gap-0">
        {visibleItems.map((item) => (
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
        ))}
      </SidebarMenu>
    </SidebarCollapsibleSection>
  );
}

const LABS_NAV_SECTION_STORAGE_KEY = "closedloop.app.sidebar.labs.open";
