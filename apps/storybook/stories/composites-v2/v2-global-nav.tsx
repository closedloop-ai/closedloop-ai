import { AGENTS_NAV_BADGE_MAX } from "@repo/app/agents/lib/agents-nav-count";
import { WorkspaceMenu } from "@repo/app/settings/v2/components/workspace-menu/workspace-menu";
import { WorkspaceMenuHostAdapterProvider } from "@repo/app/shared/workspace-menu-host/provider";
import { createWebWorkspaceMenuHostAdapterFixture } from "@repo/app/shared/workspace-menu-host/workspace-menu-host-fixtures";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarNavLinkItem,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { Link } from "@repo/navigation/link";
import {
  BarChart3,
  BotIcon,
  CoinsIcon,
  CopyCheckIcon,
  FileTextIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  TimerOffIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";

// The Global Nav of Composites/Shared/Navigation/Sidebar, shared by its
// story and by every Surfaces page, which renders inside V2AppFrame
// (Nerys, 2026-10-06: Surfaces use this sidebar, not the live GlobalSidebar).
//
// Mirrors the live web sidebar (app.closedloop.ai, 2026-09-29): the
// GlobalSidebar in apps/app/app/(authenticated)/components/sidebar.tsx with
// the labs-nav-section rollout on. Workspace menu in the header, Dashboard,
// then the Artifacts, Labs and Your Teams sections. Issues and Judges are
// left out because the live app does not show them (their flags
// are off).

type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

const TOP_LEVEL_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboardIcon },
];

const ARTIFACT_ITEMS: NavItem[] = [
  { title: "Sessions", href: "/sessions", icon: HistoryIcon },
  { title: "Branches", href: "/branches", icon: GitBranchIcon },
];

const LABS_ITEMS: NavItem[] = [
  { title: "Inbox", href: "/inbox", icon: InboxIcon },
  { title: "My Tasks", href: "/my-tasks", icon: CopyCheckIcon },
  { title: "Documents", href: "/documents", icon: FileTextIcon },
  { title: "Agents", href: "/agents", icon: BotIcon },
  { title: "Insights", href: "/insights", icon: BarChart3 },
  { title: "Lost work", href: "/insights/lost-work", icon: TimerOffIcon },
  {
    title: "TokenOps waste",
    href: "/insights/tokenops-waste",
    icon: CoinsIcon,
  },
  { title: "Packs", href: "/packs", icon: PackageIcon },
];

// A sample count above the cap, so the badge renders the capped "9+" the
// live sidebar shows.
const AGENTS_BADGE_SAMPLE_COUNT = 12;

type TeamEntry = {
  name: string;
  href: string;
};

const TEAMS: TeamEntry[] = [
  { name: "ClosedLoop Demo", href: "/teams/closedloop-demo/projects" },
  { name: "ClosedLoop", href: "/teams/closedloop/projects" },
  {
    name: "Platform Engineering",
    href: "/teams/platform-engineering/projects",
  },
];

function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

function NavItemList({
  items,
  activePath,
}: {
  items: NavItem[];
  activePath: string;
}) {
  return (
    <SidebarMenu className="gap-0">
      {items.map((item) => (
        <SidebarNavLinkItem
          className="text-sm"
          href={item.href}
          icon={<item.icon />}
          isActive={isNavItemActive(activePath, item.href)}
          key={item.title}
          title={item.title}
          tooltip={item.title}
          trailing={
            item.href === "/agents" ? (
              <SidebarCountBadge
                count={AGENTS_BADGE_SAMPLE_COUNT}
                max={AGENTS_NAV_BADGE_MAX}
              />
            ) : undefined
          }
        />
      ))}
    </SidebarMenu>
  );
}

/** The Global Nav sidebar, with `activePath` as the current view. */
export function V2GlobalNav({ activePath }: { activePath: string }) {
  return (
    <Sidebar variant="inset">
      <SidebarHeader className="pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceMenuHostAdapterProvider
              adapter={createWebWorkspaceMenuHostAdapterFixture()}
            >
              <WorkspaceMenu />
            </WorkspaceMenuHostAdapterProvider>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-1 pt-2">
        <SidebarGroup className="p-1">
          <NavItemList activePath={activePath} items={TOP_LEVEL_ITEMS} />
        </SidebarGroup>

        <SidebarCollapsibleSection title="Artifacts">
          <NavItemList activePath={activePath} items={ARTIFACT_ITEMS} />
        </SidebarCollapsibleSection>

        <SidebarCollapsibleSection title="Labs">
          <form className="flex items-center px-1 pb-1">
            <div className="relative w-full">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                size={14}
              />
              <Input
                className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-3 pl-8 text-xs shadow-none focus-visible:bg-background"
                name="q"
                placeholder="Search"
                type="text"
              />
            </div>
          </form>
          <NavItemList activePath={activePath} items={LABS_ITEMS} />
        </SidebarCollapsibleSection>

        <SidebarCollapsibleSection
          action={
            <button
              className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
              type="button"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              <span className="sr-only">Add Team</span>
            </button>
          }
          title="Your Teams"
        >
          <SidebarMenu className="gap-0">
            {TEAMS.map((team) => (
              <SidebarMenuItem key={team.name}>
                <SidebarMenuButton
                  asChild
                  className="text-sm"
                  isActive={isNavItemActive(activePath, team.href)}
                  tooltip={team.name}
                >
                  <Link href={team.href}>
                    <UsersIcon />
                    <span className="truncate">{team.name}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarCollapsibleSection>
      </SidebarContent>
    </Sidebar>
  );
}

/**
 * The app frame every Surfaces page renders in: the Global Nav and the
 * page in the inset beside it.
 */
export function V2AppFrame({
  activePath,
  children,
}: {
  activePath: string;
  children: ReactNode;
}) {
  return (
    <SidebarProvider>
      <V2GlobalNav activePath={activePath} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}
