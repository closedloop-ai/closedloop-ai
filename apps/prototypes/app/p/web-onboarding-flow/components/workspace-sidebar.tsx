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
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import {
  FolderOpenIcon,
  GitBranchIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  type LucideIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import {
  AppRoute,
  type AppRoute as AppRouteType,
  NavIconName,
  type NavIconName as NavIconNameType,
  navItems,
} from "../mock";
import { InviteTeamDialog } from "./invite-team-dialog";

const navIcons: Record<NavIconNameType, LucideIcon> = {
  [NavIconName.Branches]: GitBranchIcon,
  [NavIconName.Dashboard]: LayoutDashboardIcon,
  [NavIconName.MyTasks]: ListChecksIcon,
  [NavIconName.Sessions]: HistoryIcon,
};

type WorkspaceSidebarProps = {
  activeRoute: AppRouteType;
  branchCount?: number;
  onNavigate: (route: AppRouteType) => void;
  onOpenSettings: () => void;
  onInvited: () => void;
  projectName: string;
  projectDescription?: string;
  sessionCount?: number;
  workspaceName: string;
};

export const WorkspaceSidebar = ({
  activeRoute,
  branchCount,
  onNavigate,
  onOpenSettings,
  onInvited,
  projectName,
  projectDescription,
  sessionCount,
  workspaceName,
}: WorkspaceSidebarProps) => (
  <Sidebar variant="inset">
    <SidebarContent className="gap-1 pt-2">
      {/* Presentational chrome only: this prototype has no search backend, so
          the field is non-interactive rather than a control that accepts text
          and does nothing. */}
      <div className="flex items-center px-2 pt-0.5">
        <div className="relative w-full">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            size={14}
          />
          <Input
            aria-label="Search"
            className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-8 pl-8 text-xs shadow-none"
            disabled
            placeholder="Search"
            type="search"
          />
        </div>
      </div>
      <SidebarGroup className="p-1">
        <SidebarMenu className="gap-0">
          {navItems.map((item) => {
            const Icon = navIcons[item.icon];
            return (
              <SidebarMenuItem key={item.route}>
                <SidebarMenuButton
                  isActive={item.route === activeRoute}
                  onClick={() => onNavigate(item.route)}
                  tooltip={item.label}
                >
                  <Icon />
                  <span className="flex-1">{item.label}</span>
                  {getRouteCount(item.route, sessionCount, branchCount)}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup className="p-1">
        <SidebarGroupLabel>Your team</SidebarGroupLabel>
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
          <UsersIcon className="size-4 text-muted-foreground" />
          <span className="truncate">{workspaceName}</span>
        </div>
      </SidebarGroup>
      <SidebarGroup className="p-1">
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <div className="flex items-start gap-2 px-2 py-1.5 text-sm">
          <FolderOpenIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <span className="block truncate">{projectName}</span>
            {projectDescription ? (
              <span className="block truncate text-muted-foreground text-xs">
                {projectDescription}
              </span>
            ) : null}
          </div>
        </div>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <InviteTeamDialog
            onInvited={onInvited}
            trigger={
              <SidebarMenuButton tooltip="Invite team">
                <UsersIcon />
                Invite team
              </SidebarMenuButton>
            }
          />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={activeRoute === AppRoute.Settings}
            onClick={onOpenSettings}
            tooltip="Settings"
          >
            <SettingsIcon />
            Settings
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" tooltip="Your account">
            <Avatar className="size-7 rounded-md">
              <AvatarFallback className="rounded-md bg-primary text-primary-foreground text-xs">
                KC
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left leading-tight">
              <span className="truncate font-medium text-sm">Kaiti</span>
              <span className="truncate text-muted-foreground text-xs">
                {workspaceName}
              </span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
);

const getRouteCount = (
  route: AppRouteType,
  sessionCount: number | undefined,
  branchCount: number | undefined
) => {
  if (route === AppRoute.Sessions && sessionCount !== undefined) {
    return <SidebarCountBadge count={sessionCount} />;
  }
  if (route === AppRoute.Branches && branchCount !== undefined) {
    return <SidebarCountBadge count={branchCount} />;
  }
  return null;
};
