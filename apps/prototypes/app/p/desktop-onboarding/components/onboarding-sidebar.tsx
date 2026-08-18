"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarNavLinkItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import {
  BotIcon,
  CpuIcon,
  FileTextIcon,
  GitBranchIcon,
  HammerIcon,
  InboxIcon,
  LaptopIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  RotateCwIcon,
  UsersIcon,
} from "lucide-react";
import {
  agentNav,
  artifactsNav,
  type NavIconName,
  type NavItem,
  primaryNav,
} from "../mock";

const navIcons: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboardIcon,
  sessions: RotateCwIcon,
  inbox: InboxIcon,
  agents: BotIcon,
  skills: HammerIcon,
  models: CpuIcon,
  documents: FileTextIcon,
  branches: GitBranchIcon,
};

const NavLink = ({ item }: { item: NavItem }) => {
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
};

export const OnboardingSidebar = ({
  onInviteTeam,
}: {
  onInviteTeam: () => void;
}) => (
  <Sidebar variant="inset">
    <SidebarContent className="scrollbar-overlay gap-1 pt-2">
      {/* Local-first identity: this is the user's own machine, no org yet. */}
      <div className="flex items-center gap-2 px-3 pt-1 pb-1 text-muted-foreground">
        <LaptopIcon className="size-4" />
        <span className="truncate font-medium text-xs">Local · This Mac</span>
      </div>

      <SidebarGroup className="p-1">
        <SidebarMenu className="gap-0">
          {primaryNav.map((item) => (
            <NavLink item={item} key={item.label} />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      <SidebarCollapsibleSection title="Agent Management">
        <SidebarMenu className="gap-0">
          {agentNav.map((item) => (
            <NavLink item={item} key={item.label} />
          ))}
        </SidebarMenu>
      </SidebarCollapsibleSection>

      <SidebarCollapsibleSection title="Artifacts">
        <SidebarMenu className="gap-0">
          {artifactsNav.map((item) => (
            <NavLink item={item} key={item.label} />
          ))}
        </SidebarMenu>
      </SidebarCollapsibleSection>
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
