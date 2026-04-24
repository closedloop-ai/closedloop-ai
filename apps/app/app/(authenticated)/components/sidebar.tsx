"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import {
  OrganizationSwitcher,
  UserButton,
  useOrganization,
} from "@repo/auth/client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BotIcon,
  Boxes,
  CodeIcon,
  InboxIcon,
  RotateCcwIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { ComputeTargetPopover } from "@/components/compute-target-popover";
import { useIsMounted } from "@/hooks/use-is-mounted";
import { EngineerBadge } from "./engineer-badge";
import { InboxBadge } from "./inbox-badge";
import { Search } from "./search";
import { SidebarFavorites } from "./sidebar-favorites";
import { SidebarTeams } from "./sidebar-teams";

const orgSwitcherAppearance = {
  elements: {
    rootBox: {
      display: "flex",
      overflow: "hidden",
      width: "100%",
    },
    organizationSwitcherTrigger: {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-start",
      gap: "0.5rem",
      width: "100%",
      padding: "0.5rem",
      borderRadius: "0.375rem",
      color: "var(--sidebar-foreground)",
      backgroundColor: "transparent",
      "&:hover": {
        backgroundColor: "var(--sidebar-accent)",
        color: "var(--sidebar-accent-foreground)",
      },
      "&:focus-visible": {
        outline: "2px solid var(--sidebar-ring)",
        outlineOffset: "2px",
      },
    },
    organizationSwitcherTriggerIcon: {
      color: "var(--sidebar-foreground)",
      opacity: "0.7",
      marginLeft: "auto",
      flexShrink: "0",
    },
    organizationPreview: {
      minWidth: "0",
      overflow: "hidden",
    },
    organizationPreviewMainIdentifier: {
      fontSize: "0.875rem",
      fontWeight: "500",
      color: "var(--sidebar-foreground)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    organizationPreviewAvatarContainer: {
      width: "1.75rem",
      height: "1.75rem",
      flexShrink: "0",
    },
    organizationPreviewAvatarBox: {
      width: "1.75rem",
      height: "1.75rem",
    },
  },
} as const;

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

const baseWorkspaceItems: NavItem[] = [
  {
    title: "My Tasks",
    url: "/my-tasks",
    icon: Boxes,
    disabled: false,
  },
  {
    title: "Notifications",
    url: "/inbox",
    icon: InboxIcon,
    disabled: false,
  },
  {
    title: "Loops",
    url: "/loops",
    icon: RotateCcwIcon,
    disabled: false,
  },
  {
    title: "Agents",
    url: "/agents",
    icon: BotIcon,
    disabled: false,
  },
];

const engineerNavItem: NavItem = {
  title: "Engineer",
  url: "/engineer",
  icon: CodeIcon,
  disabled: false,
  featureFlag: "engineer-view",
};

const workspaceItems: NavItem[] = [...baseWorkspaceItems, engineerNavItem];

const data: {
  workspace: NavItem[];
  navSecondary: NavItem[];
} = {
  workspace: workspaceItems,
  navSecondary: [
    {
      title: "Judges",
      url: "/judges-analytics",
      icon: BarChart3,
      disabled: false,
      featureFlag: "the-one-flag",
    },
  ],
};

function isNavItemActive(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`));
}

export function GlobalSidebar({
  children,
  envBadge = null,
}: GlobalSidebarProperties) {
  const pathname = usePathname();
  const sidebar = useSidebar();
  const { organization } = useOrganization();
  const queryClient = useQueryClient();
  const prevOrgIdRef = useRef<string | undefined>(undefined);
  const mounted = useIsMounted();

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
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <div
                className={cn(
                  "flex overflow-hidden transition-all",
                  sidebar.open && envBadge
                    ? "flex-col items-start gap-1 py-1"
                    : "h-[36px] items-center gap-2",
                  !sidebar.open && "justify-center"
                )}
              >
                {sidebar.open && (
                  <>
                    {mounted ? (
                      <OrganizationSwitcher
                        appearance={orgSwitcherAppearance}
                      />
                    ) : (
                      <div className="h-8 w-full animate-pulse rounded bg-muted" />
                    )}
                    {envBadge && (
                      <div className="w-full rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 dark:border-amber-500/20 dark:bg-amber-500/10">
                        <div className="mb-0.5 flex items-center gap-1.5">
                          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
                          <span className="font-bold font-mono text-[9px] text-amber-700 uppercase tracking-wider dark:text-amber-400">
                            local
                          </span>
                        </div>
                        <p
                          className="truncate font-mono text-[9px] text-amber-700/60 leading-tight dark:text-amber-400/60"
                          title={envBadge}
                        >
                          {envBadge}
                        </p>
                      </div>
                    )}
                  </>
                )}
                {mounted && !sidebar.open && (
                  <Avatar className="size-7">
                    <AvatarImage
                      alt={organization?.name || "Organization"}
                      src={organization?.imageUrl}
                    />
                    <AvatarFallback className="text-xs">
                      {organization?.name?.charAt(0)?.toUpperCase() || "O"}
                    </AvatarFallback>
                  </Avatar>
                )}
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <Search />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarMenu>
              {data.workspace.map((item) =>
                maybeFeatureFlagged(
                  item,
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild={!item.disabled}
                      className={cn(
                        item.disabled
                          ? "pointer-events-none cursor-not-allowed opacity-50"
                          : ""
                      )}
                      isActive={
                        !item.disabled &&
                        isNavItemActive(pathname ?? "", item.url)
                      }
                      tooltip={item.title}
                    >
                      {item.disabled ? (
                        <span className="flex items-center gap-2">
                          <item.icon className="size-4" />
                          <span>{item.title}</span>
                        </span>
                      ) : (
                        <Link href={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                          {item.title === "Notifications" && <InboxBadge />}
                          {item.title === engineerNavItem.title && (
                            <EngineerBadge />
                          )}
                        </Link>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              )}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarFavorites />

          <SidebarTeams />

          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <SidebarMenu>
                {data.navSecondary.map((item) =>
                  maybeFeatureFlagged(
                    item,
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild={!item.disabled}
                        className={cn(
                          item.disabled
                            ? "pointer-events-none cursor-not-allowed opacity-50"
                            : ""
                        )}
                        isActive={
                          !item.disabled &&
                          isNavItemActive(pathname ?? "", item.url)
                        }
                      >
                        {item.disabled ? (
                          <span className="flex items-center gap-2">
                            <item.icon className="size-4" />
                            <span>{item.title}</span>
                          </span>
                        ) : (
                          <Link href={item.url}>
                            <item.icon />
                            <span>{item.title}</span>
                          </Link>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <ComputeTargetPopover />
            </SidebarMenuItem>
            <SidebarMenuItem className="flex items-center gap-2">
              <div className="h-8 w-full">
                {mounted && (
                  <UserButton
                    appearance={{
                      elements: {
                        rootBox:
                          "flex overflow-hidden w-full text-sidebar-foreground",
                        userButtonBox:
                          "flex-row-reverse text-sidebar-foreground",
                        userButtonOuterIdentifier:
                          "truncate pl-0 text-sidebar-foreground",
                        userButtonTrigger:
                          "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground rounded-md",
                      },
                    }}
                    showName
                    userProfileMode="navigation"
                    userProfileUrl="/settings"
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-px">
                <ModeToggle className="text-sidebar-foreground" />
              </div>
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
