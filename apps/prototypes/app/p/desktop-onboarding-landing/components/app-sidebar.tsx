"use client";

import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import {
  GitBranchIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  RotateCwIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import {
  type AppRoute,
  type NavIconName,
  type NavItem,
  navItems,
} from "../app-mock";

const navIcons: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboardIcon,
  sessions: RotateCwIcon,
  branches: GitBranchIcon,
};

const NavLink = ({
  item,
  count,
  activeRoute,
  onNavigate,
}: {
  item: NavItem;
  /** Live count from the parse-progress snapshot; hidden until it is > 0. */
  count?: number;
  activeRoute: AppRoute;
  onNavigate: (route: AppRoute) => void;
}) => {
  const Icon = navIcons[item.icon];
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="text-sm"
        isActive={item.route === activeRoute}
        onClick={() => onNavigate(item.route)}
        tooltip={item.label}
      >
        <Icon />
        <span className="flex-1 truncate">{item.label}</span>
        {count ? <SidebarCountBadge count={count} /> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};

export const AppSidebar = ({
  activeRoute,
  counts,
  onNavigate,
  onInviteTeam,
}: {
  activeRoute: AppRoute;
  /** Live per-route counts, driven by the parse-progress snapshot. */
  counts: Partial<Record<AppRoute, number>>;
  onNavigate: (route: AppRoute) => void;
  onInviteTeam: () => void;
}) => (
  <Sidebar variant="inset">
    <SidebarContent className="scrollbar-overlay gap-1 pt-2">
      {/* Mirrors the web sidebar search (SidebarSearchForm): rounded field with
          a leading search icon. Presentational here. */}
      <form
        className="flex items-center px-2 pt-0.5"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="relative w-full">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            size={14}
          />
          <Input
            aria-label="Search"
            className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-8 pl-8 text-xs shadow-none focus-visible:bg-background"
            placeholder="Search"
            type="text"
          />
        </div>
      </form>

      <SidebarGroup className="p-1">
        <SidebarMenu className="gap-0">
          {navItems.map((item) => (
            <NavLink
              activeRoute={activeRoute}
              count={counts[item.route]}
              item={item}
              key={item.route}
              onNavigate={onNavigate}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={onInviteTeam} tooltip="Invite your team">
            <UsersIcon />
            <span className="truncate">Invite your team</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
);
