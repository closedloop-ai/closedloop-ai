"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@repo/design-system/components/ui/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { cn } from "@repo/design-system/lib/utils";
import {
  BarChart3Icon,
  BotIcon,
  ChevronsUpDownIcon,
  ClipboardListIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  SettingsIcon,
  ShieldIcon,
  StethoscopeIcon,
  UserPlusIcon,
} from "lucide-react";
import { InviteAnnouncementContent } from "./invite-announcement";

// The Sessions-page left sidebar, mirroring the production desktop Sidebar
// (apps/desktop/src/renderer/components/layout/Sidebar.tsx) under FOCUS_MODE:
// the focus pages in the top group, a visible Gateway group, a collapsed Labs
// section, and a footer carrying "Invite your team" above the account menu.
// Nav items are presentational (this prototype is a single Sessions screen);
// "Invite your team" is the live affordance the flow's Card #5 pop-up points at.

const NavItemId = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Agents: "agents",
  Approvals: "approvals",
  Requests: "requests",
  Insights: "insights",
  Plans: "plans",
  Packs: "packs",
} as const;
type NavItemId = (typeof NavItemId)[keyof typeof NavItemId];

type NavItem = { id: NavItemId; label: string; icon: LucideIcon };

const MAIN_ITEMS: readonly NavItem[] = [
  { id: NavItemId.Dashboard, label: "Dashboard", icon: LayoutDashboardIcon },
  { id: NavItemId.Sessions, label: "Sessions", icon: HistoryIcon },
  { id: NavItemId.Branches, label: "Branches", icon: GitBranchIcon },
  { id: NavItemId.Agents, label: "Agents", icon: BotIcon },
];

const GATEWAY_ITEMS: readonly NavItem[] = [
  { id: NavItemId.Approvals, label: "Approvals", icon: ShieldIcon },
  { id: NavItemId.Requests, label: "Requests", icon: InboxIcon },
];

const LABS_ITEMS: readonly NavItem[] = [
  { id: NavItemId.Insights, label: "Insights", icon: BarChart3Icon },
  { id: NavItemId.Plans, label: "Plans", icon: ClipboardListIcon },
  { id: NavItemId.Packs, label: "Packs", icon: PackageIcon },
];

const NavMenu = ({ items }: { items: readonly NavItem[] }) => (
  <SidebarMenu className="gap-0">
    {items.map((item) => (
      <SidebarMenuItem key={item.id}>
        <SidebarMenuButton
          className="text-sm"
          isActive={item.id === NavItemId.Sessions}
          tooltip={item.label}
        >
          <item.icon />
          <span className="flex-1 truncate">{item.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ))}
  </SidebarMenu>
);

type SessionsSidebarProps = {
  workspaceName: string;
  // Clicking the footer "Invite your team" item opens the invite dialog.
  onOpenInvite: () => void;
  // Card #5 arrival pop-up, anchored to the invite item so it points at where
  // invite lives. Suppressed in the takeover backdrop (showAnnouncement=false).
  showAnnouncement: boolean;
  announceOpen: boolean;
  onAnnounceOpenChange: (open: boolean) => void;
  onAnnounceInvite: () => void;
};

export const SessionsSidebar = ({
  workspaceName,
  onOpenInvite,
  showAnnouncement,
  announceOpen,
  onAnnounceOpenChange,
  onAnnounceInvite,
}: SessionsSidebarProps) => {
  // On mobile the sidebar is offcanvas, so its "Invite your team" footer item —
  // the desktop pop-up anchor — is off screen. There the topbar owns the pop-up
  // (anchored to the always-visible menu trigger); this component renders the
  // plain item so the anchor only attaches to a visible element on desktop.
  const { isMobile } = useSidebar();
  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarContent className="gap-1 pt-2">
        <SidebarGroup className="px-0 py-1">
          <NavMenu items={MAIN_ITEMS} />
        </SidebarGroup>
        <SidebarGroup className="px-0 py-1">
          <SidebarGroupLabel>Gateway</SidebarGroupLabel>
          <NavMenu items={GATEWAY_ITEMS} />
        </SidebarGroup>
        <SidebarCollapsibleSection
          className="px-0 py-1"
          defaultOpen={false}
          title="Labs"
        >
          <NavMenu items={LABS_ITEMS} />
        </SidebarCollapsibleSection>
      </SidebarContent>
      <SidebarFooter className="px-0 pt-1 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            {showAnnouncement && !isMobile ? (
              <Popover onOpenChange={onAnnounceOpenChange} open={announceOpen}>
                <PopoverAnchor asChild>
                  {/* Anchor directly to the ref-forwarding SidebarMenuButton and
                    highlight it while the CTA is open so the pop-up points at
                    where invite lives. Desktop-only: on mobile this item is
                    offcanvas, so the topbar menu trigger carries the pop-up. */}
                  <SidebarMenuButton
                    className={cn(
                      announceOpen && "ring-2 ring-primary/50 ring-offset-1"
                    )}
                    onClick={onOpenInvite}
                    tooltip="Invite your team"
                  >
                    <UserPlusIcon className="size-4" />
                    <span className="truncate">Invite your team</span>
                  </SidebarMenuButton>
                </PopoverAnchor>
                <PopoverContent
                  align="end"
                  className="w-80"
                  side="right"
                  sideOffset={8}
                >
                  <InviteAnnouncementContent
                    onDismiss={() => onAnnounceOpenChange(false)}
                    onInvite={onAnnounceInvite}
                  />
                </PopoverContent>
              </Popover>
            ) : (
              <SidebarMenuButton
                onClick={onOpenInvite}
                tooltip="Invite your team"
              >
                <UserPlusIcon className="size-4" />
                <span className="truncate">Invite your team</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <AccountMenu workspaceName={workspaceName} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
};

// Footer account trigger, mirroring the production AccountMenu: the Closedloop
// mark as the avatar, the organization name, and a chevron opening Settings /
// Diagnostics (presentational here).
const AccountMenu = ({ workspaceName }: { workspaceName: string }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <SidebarMenuButton
        aria-label="Open account menu"
        size="lg"
        tooltip={workspaceName}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <ClosedloopMark />
        </div>
        <span className="truncate font-medium">{workspaceName}</span>
        <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
      </SidebarMenuButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      className="min-w-56 rounded-md"
      side="top"
    >
      <DropdownMenuItem>
        <SettingsIcon className="size-4" />
        Settings
      </DropdownMenuItem>
      <DropdownMenuItem>
        <StethoscopeIcon className="size-4" />
        Diagnostics
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

const ClosedloopMark = () => (
  <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 100 100">
    <path
      d="M0.424623 49.6765C0.339767 56.2176 1.55939 62.7103 4.01272 68.7779C6.46604 74.8455 10.1042 80.3673 14.7161 85.0227C19.3281 89.6781 24.8219 93.3744 30.8788 95.8973C36.9358 98.4202 43.4352 99.7193 50 99.7193C56.5648 99.7193 63.0643 98.4202 69.1212 95.8973C75.1782 93.3744 80.672 89.6781 85.2839 85.0227C89.8958 80.3673 93.534 74.8455 95.9873 68.7779C98.4406 62.7103 99.6603 56.2176 99.5754 49.6765C99.5754 49.5115 99.5754 49.3546 99.5754 49.1895H71.7496C71.7496 49.3546 71.7496 49.5115 71.7496 49.6765C71.7496 53.9658 70.473 58.1587 68.0814 61.7249C65.6898 65.2912 62.2906 68.0706 58.3136 69.7117C54.3367 71.3527 49.9606 71.7817 45.739 70.9443C41.5174 70.1069 37.6398 68.0408 34.5966 65.0072C31.5535 61.9737 29.4815 58.109 28.6428 53.902C27.804 49.695 28.2361 45.3346 29.8845 41.3723C31.5329 37.4101 34.3235 34.0239 37.9033 31.6421C41.4831 29.2603 45.6914 27.9899 49.9959 27.9915H50.0704L50.0373 0.280626C43.524 0.275203 37.0735 1.54886 31.0545 4.02881C25.0354 6.50876 19.5659 10.1464 14.9583 14.7338C10.3508 19.3211 6.69575 24.7683 4.20197 30.764C1.70819 36.7597 0.424621 43.1863 0.424623 49.6765Z"
      fill="currentColor"
    />
    <path
      d="M57.1534 0.801147V29.2137C60.1811 30.2616 62.939 31.9629 65.2303 34.1961C67.5215 36.4293 69.2895 39.1392 70.4077 42.1323H99.004C97.3792 31.6897 92.4381 22.0411 84.906 14.6024C77.3738 7.16375 67.6471 2.32669 57.1534 0.801147Z"
      fill="#41A3FF"
    />
  </svg>
);
