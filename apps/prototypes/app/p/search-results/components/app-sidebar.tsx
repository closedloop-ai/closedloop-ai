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
  SidebarNavLinkItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import {
  BarChart3,
  BotIcon,
  ChevronsUpDownIcon,
  CopyCheckIcon,
  EllipsisIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
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
  agents: BotIcon,
  insights: BarChart3,
  loops: RotateCcwIcon,
  "agent-monitoring": BarChart3,
  judges: BarChart3,
};

const NavLink = ({ item }: { item: NavItem }) => {
  const Icon = navIcons[item.icon];
  return (
    <SidebarNavLinkItem
      className="text-sm"
      icon={<Icon />}
      isActive={item.isActive}
      key={item.label}
      title={item.label}
      tooltip={item.label}
      trailing={
        item.count === undefined ? undefined : (
          <SidebarCountBadge count={item.count} />
        )
      }
    />
  );
};

// The sidebar search box is where /search is reached from. The query already
// lives on the results page bar, so this is a static entry point for context.
const SidebarSearch = () => (
  <div className="flex items-center px-2 pt-2.5">
    <div className="relative w-full">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        size={14}
      />
      <Input
        aria-label="Search"
        className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-8 pl-8 text-xs shadow-none focus-visible:bg-background"
        placeholder="Search"
        readOnly
        type="text"
        value="agent"
      />
    </div>
  </div>
);

const AddTeamAction = () => (
  <button
    className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
    type="button"
  >
    <PlusIcon className="h-3.5 w-3.5" />
    <span className="sr-only">Add Team</span>
  </button>
);

const AccountFooterButton = () => (
  <SidebarMenuButton size="lg" tooltip="Closedloop">
    <Avatar className="size-7 rounded-md">
      <AvatarFallback className="rounded-md bg-primary text-primary-foreground text-xs">
        C
      </AvatarFallback>
    </Avatar>
    <div className="grid flex-1 text-left text-sm leading-tight">
      <span className="truncate font-medium">Closedloop</span>
    </div>
    <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
  </SidebarMenuButton>
);

export const AppSidebar = () => (
  <Sidebar variant="inset">
    <SidebarSearch />
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

      <SidebarCollapsibleSection action={<AddTeamAction />} title="Your Teams">
        <SidebarMenu className="gap-0">
          {teams.map((team) => (
            <SidebarMenuItem key={team.id}>
              <SidebarMenuButton className="text-sm" tooltip={team.name}>
                <UsersIcon />
                <span className="truncate">{team.name}</span>
              </SidebarMenuButton>
              <SidebarMenuAction
                aria-label="Team options"
                className="[&>svg]:size-3.5"
                showOnHover
              >
                <EllipsisIcon />
              </SidebarMenuAction>
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
          <AccountFooterButton />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
);
