"use client";

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
import { Button } from "@repo/design-system/components/ui/button";
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
import { NotificationsTrigger } from "@repo/notifications/components/trigger";
import { useQueryClient } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Boxes,
  CodeIcon,
  InboxIcon,
  LifeBuoyIcon,
  RotateCcwIcon,
  SendIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { useIsMounted } from "@/hooks/use-is-mounted";
import { type AppEnvironment, appEnvironment } from "@/lib/environment";
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
      gap: "0.5rem",
      width: "100%",
      padding: "0.5rem",
      borderRadius: "0.375rem",
      color: "hsl(var(--sidebar-foreground))",
      backgroundColor: "transparent",
      "&:hover": {
        backgroundColor: "hsl(var(--sidebar-accent))",
        color: "hsl(var(--sidebar-accent-foreground))",
      },
      "&:focus-visible": {
        outline: "2px solid hsl(var(--sidebar-ring))",
        outlineOffset: "2px",
      },
    },
    organizationSwitcherTriggerIcon: {
      color: "hsl(var(--sidebar-foreground))",
      opacity: "0.7",
    },
    organizationPreviewMainIdentifier: {
      fontSize: "0.875rem",
      fontWeight: "500",
      color: "hsl(var(--sidebar-foreground))",
    },
    organizationPreviewAvatarContainer: {
      width: "1.75rem",
      height: "1.75rem",
    },
    organizationPreviewAvatarBox: {
      width: "1.75rem",
      height: "1.75rem",
    },
  },
} as const;

const envBadge: Record<AppEnvironment, string | null> = {
  local: process.env.NEXT_PUBLIC_API_URL ?? "localhost",
  stage: null,
  prod: null,
};

type GlobalSidebarProperties = {
  readonly children: ReactNode;
};

type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  disabled: boolean;
};

const baseWorkspaceItems: NavItem[] = [
  {
    title: "Inbox",
    url: "/inbox",
    icon: InboxIcon,
    disabled: false,
  },
  {
    title: "My Tasks",
    url: "/my-tasks",
    icon: Boxes,
    disabled: false,
  },
  {
    title: "Loops",
    url: "/loops",
    icon: RotateCcwIcon,
    disabled: false,
  },
  {
    title: "Members",
    url: "/members",
    icon: UsersIcon,
    disabled: false,
  },
];

const engineerNavItem: NavItem = {
  title: "Engineer",
  url: "/engineer",
  icon: CodeIcon,
  disabled: false,
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
    },
    {
      title: "Settings",
      url: "/settings",
      icon: SettingsIcon,
      disabled: false,
    },
    {
      title: "Support",
      url: "#",
      icon: LifeBuoyIcon,
      disabled: true,
    },
    {
      title: "Feedback",
      url: "#",
      icon: SendIcon,
      disabled: true,
    },
  ],
};

function isNavItemActive(pathname: string, url: string): boolean {
  return pathname === url || (url !== "/" && pathname.startsWith(`${url}/`));
}

export function GlobalSidebar({ children }: GlobalSidebarProperties) {
  const pathname = usePathname();
  const sidebar = useSidebar();
  const { organization } = useOrganization();
  const queryClient = useQueryClient();
  const prevOrgIdRef = useRef<string | undefined>(undefined);
  const mounted = useIsMounted();
  const isLocalhost =
    mounted &&
    (globalThis.location.hostname === "localhost" ||
      globalThis.location.hostname === "127.0.0.1");
  const activeEnvBadge = isLocalhost ? envBadge[appEnvironment] : null;

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
                  sidebar.open && activeEnvBadge
                    ? "flex-col items-start gap-1 px-2 py-1"
                    : "h-[36px] items-center gap-2",
                  !sidebar.open && "justify-center px-0",
                  sidebar.open && !activeEnvBadge && "px-2"
                )}
              >
                {!mounted && (
                  <div className="h-8 w-full animate-pulse rounded bg-muted" />
                )}
                {mounted && sidebar.open && (
                  <>
                    <OrganizationSwitcher appearance={orgSwitcherAppearance} />
                    {activeEnvBadge && (
                      <div className="w-full rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 dark:border-amber-500/20 dark:bg-amber-500/10">
                        <div className="mb-0.5 flex items-center gap-1.5">
                          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
                          <span className="font-bold font-mono text-[9px] text-amber-700 uppercase tracking-wider dark:text-amber-400">
                            local
                          </span>
                        </div>
                        <p
                          className="truncate font-mono text-[9px] text-amber-700/60 leading-tight dark:text-amber-400/60"
                          title={activeEnvBadge}
                        >
                          {activeEnvBadge}
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
              {data.workspace.map((item) => (
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
                        {item.title === "Inbox" && <InboxBadge />}
                        {item.title === engineerNavItem.title && (
                          <EngineerBadge />
                        )}
                      </Link>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

          <SidebarFavorites />

          <SidebarTeams />

          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <SidebarMenu>
                {data.navSecondary.map((item) => (
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
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-2">
              <div className="h-8 w-full">
                {mounted && (
                  <UserButton
                    appearance={{
                      elements: {
                        rootBox: "flex overflow-hidden w-full",
                        userButtonBox: "flex-row-reverse",
                        userButtonOuterIdentifier: "truncate pl-0",
                      },
                    }}
                    showName
                  />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-px">
                <ModeToggle />
                <Button
                  asChild
                  className="shrink-0"
                  size="icon"
                  variant="ghost"
                >
                  <div className="h-4 w-4">
                    <NotificationsTrigger />
                  </div>
                </Button>
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>{children}</SidebarInset>
    </>
  );
}
