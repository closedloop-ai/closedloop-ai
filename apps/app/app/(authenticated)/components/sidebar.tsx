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
  FileTextIcon,
  InboxIcon,
  LifeBuoyIcon,
  LightbulbIcon,
  SendIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useRef } from "react";
import { useIsMounted } from "@/hooks/use-is-mounted";
import { type AppEnvironment, appEnvironment } from "@/lib/environment";
import { InboxBadge } from "./inbox-badge";
import { Search } from "./search";
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

const envBadge: Record<
  AppEnvironment,
  { label: string; className: string } | null
> = {
  local: {
    label: "DEV",
    className:
      "rounded bg-blue-100 px-1.5 py-0.5 font-medium text-[10px] text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
  stage: {
    label: "STAGE",
    className:
      "rounded bg-amber-100 px-1.5 py-0.5 font-medium text-[10px] text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  },
  prod: null,
};

type GlobalSidebarProperties = {
  readonly children: ReactNode;
};

const data: {
  workspace: {
    title: string;
    url: string;
    icon: LucideIcon;
    disabled: boolean;
  }[];
  navSecondary: {
    title: string;
    url: string;
    icon: LucideIcon;
    disabled: boolean;
  }[];
} = {
  workspace: [
    {
      title: "Inbox",
      url: "/inbox",
      icon: InboxIcon,
      disabled: false,
    },
    {
      title: "Initiatives",
      url: "/initiatives",
      icon: LightbulbIcon,
      disabled: true,
    },
    {
      title: "My Documents",
      url: "/my-documents",
      icon: FileTextIcon,
      disabled: true,
    },
    {
      title: "Members",
      url: "/members",
      icon: UsersIcon,
      disabled: false,
    },
  ],
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

export function GlobalSidebar({ children }: GlobalSidebarProperties) {
  const sidebar = useSidebar();
  const { organization } = useOrganization();
  const queryClient = useQueryClient();
  const prevOrgIdRef = useRef<string | undefined>(undefined);
  const mounted = useIsMounted();
  const activeEnvBadge = envBadge[appEnvironment];

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
                  "flex h-[36px] items-center gap-2 overflow-hidden transition-all",
                  sidebar.open ? "px-2" : "justify-center"
                )}
              >
                {!mounted && (
                  <div className="h-8 w-full animate-pulse rounded bg-muted" />
                )}
                {mounted && sidebar.open && (
                  <>
                    <OrganizationSwitcher appearance={orgSwitcherAppearance} />
                    {activeEnvBadge && (
                      <span className={activeEnvBadge.className}>
                        {activeEnvBadge.label}
                      </span>
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
                    tooltip={item.title}
                  >
                    {item.disabled ? (
                      <span className="flex items-center gap-2">
                        <item.icon />
                        <span>{item.title}</span>
                      </span>
                    ) : (
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                        {item.title === "Inbox" && <InboxBadge />}
                      </Link>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>

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
                    >
                      {item.disabled ? (
                        <span className="flex items-center gap-2">
                          <item.icon />
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
              {mounted ? (
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
              ) : (
                <div className="h-8 w-full" />
              )}
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
