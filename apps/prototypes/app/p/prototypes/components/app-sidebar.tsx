"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarNavLinkItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import {
  BarChart3Icon,
  BotIcon,
  ChevronsUpDownIcon,
  CopyCheckIcon,
  EllipsisIcon,
  FileCode2Icon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  Layers2Icon,
  LayoutDashboardIcon,
  type LucideIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SquareCheckIcon,
  UsersIcon,
} from "lucide-react";
import {
  artifactsNav,
  labsNav,
  type NavIconName,
  type NavItem,
  primaryNav,
  teams,
} from "../mock";

const navIcons: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboardIcon,
  inbox: InboxIcon,
  "my-issues": CopyCheckIcon,
  documents: FileIcon,
  issues: SquareCheckIcon,
  sessions: HistoryIcon,
  branches: GitBranchIcon,
  prototypes: FileCode2Icon,
  agents: BotIcon,
  insights: BarChart3Icon,
  loops: RotateCcwIcon,
  "agent-monitoring": BarChart3Icon,
  judges: BarChart3Icon,
};

function NavLink({ item }: { item: NavItem }) {
  const Icon = navIcons[item.icon];
  return (
    <SidebarNavLinkItem
      className="text-sm"
      icon={<Icon />}
      isActive={item.isActive}
      title={item.label}
      tooltip={item.label}
      trailing={
        item.count === undefined ? undefined : (
          <SidebarCountBadge count={item.count} />
        )
      }
    />
  );
}

export function AppSidebar() {
  return (
    <Sidebar variant="inset">
      <div className="flex items-center px-2 pt-2.5">
        <div className="relative w-full">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search"
            className="h-8 rounded-full bg-transparent pr-8 pl-8 text-xs shadow-none"
            placeholder="Search"
            readOnly
          />
        </div>
      </div>
      <SidebarContent className="gap-1 pt-2">
        <SidebarGroup className="p-1">
          <SidebarMenu className="gap-0">
            {primaryNav.map((item) => (
              <NavLink item={item} key={item.label} />
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarCollapsibleSection title="Artifacts">
          <SidebarMenu className="gap-0">
            {artifactsNav.map((item) => (
              <NavLink item={item} key={item.label} />
            ))}
          </SidebarMenu>
        </SidebarCollapsibleSection>

        <SidebarCollapsibleSection
          action={
            <button
              aria-label="Add team"
              className="flex size-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
              type="button"
            >
              <PlusIcon className="size-3.5" />
            </button>
          }
          title="Your Teams"
        >
          <SidebarMenu className="gap-0">
            {teams.map((team) => (
              <SidebarMenuItem key={team.id}>
                <SidebarMenuButton className="text-sm" tooltip={team.name}>
                  <UsersIcon />
                  <span className="truncate">{team.name}</span>
                </SidebarMenuButton>
                <SidebarMenuAction
                  aria-label={`${team.name} options`}
                  showOnHover
                >
                  <EllipsisIcon />
                </SidebarMenuAction>
                {team.favorites ? (
                  <SidebarMenuSub className="mr-0 gap-0 pr-0">
                    {team.favorites.map((favorite) => (
                      <SidebarMenuSubItem key={favorite.id}>
                        <SidebarMenuSubButton asChild>
                          <button type="button">
                            <Layers2Icon />
                            <span>{favorite.name}</span>
                          </button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarCollapsibleSection>

        <SidebarCollapsibleSection title="Labs">
          <SidebarMenu className="gap-0">
            {labsNav.map((item) => (
              <NavLink item={item} key={item.label} />
            ))}
          </SidebarMenu>
        </SidebarCollapsibleSection>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip="Closedloop">
              <Avatar className="size-7 rounded-md">
                <AvatarFallback className="rounded-md bg-primary text-primary-foreground text-xs">
                  C
                </AvatarFallback>
              </Avatar>
              <span className="truncate font-medium text-sm">Closedloop</span>
              <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
