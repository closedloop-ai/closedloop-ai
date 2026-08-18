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
  GitBranchIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  SearchIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import {
  AppRoute,
  type AppRoute as AppRouteType,
  NavIconName,
  type NavIconName as NavIconNameType,
  navItems,
} from "../mock";

const navIcons: Record<NavIconNameType, LucideIcon> = {
  [NavIconName.Branches]: GitBranchIcon,
  [NavIconName.Dashboard]: LayoutDashboardIcon,
  [NavIconName.Sessions]: HistoryIcon,
};

type WorkspaceSidebarProps = {
  activeRoute: AppRouteType;
  branchCount?: number;
  inviteSent: boolean;
  onInvite: () => void;
  onNavigate: (route: AppRouteType) => void;
  onSignUp: () => void;
  sessionCount?: number;
  signedIn: boolean;
  workspaceName: string;
};

export const WorkspaceSidebar = ({
  activeRoute,
  branchCount,
  inviteSent,
  onInvite,
  onNavigate,
  onSignUp,
  sessionCount,
  signedIn,
  workspaceName,
}: WorkspaceSidebarProps) => (
  <Sidebar variant="inset">
    <SidebarContent className="gap-1 pt-2">
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
            type="search"
          />
        </div>
      </form>
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
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={onInvite} tooltip="Invite team">
            <UsersIcon />
            {inviteSent ? "Invite more teammates" : "Invite team"}
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <AccountFooterRow
            onSignUp={onSignUp}
            signedIn={signedIn}
            workspaceName={workspaceName}
          />
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

const AccountFooterRow = ({
  onSignUp,
  signedIn,
  workspaceName,
}: {
  onSignUp: () => void;
  signedIn: boolean;
  workspaceName: string;
}) => {
  if (signedIn) {
    // Presentational row, not a control: this prototype owns no account-switch,
    // settings, or sign-out route, so a focusable button here would go nowhere.
    return (
      <div className="flex items-center gap-2 px-2 py-1.5">
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
      </div>
    );
  }
  return (
    <SidebarMenuButton onClick={onSignUp} size="lg" tooltip="Create account">
      <Avatar className="size-7 rounded-md">
        <AvatarFallback className="rounded-md bg-muted text-muted-foreground">
          <UserRoundIcon className="size-4" />
        </AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left leading-tight">
        <span className="truncate font-medium text-sm">Guest</span>
        <span className="truncate text-muted-foreground text-xs">
          Sign up to save your work
        </span>
      </div>
    </SidebarMenuButton>
  );
};
