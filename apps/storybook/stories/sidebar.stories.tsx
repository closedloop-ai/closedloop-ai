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
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { Link } from "@repo/navigation/link";
import { usePath } from "@repo/navigation/use-path";
import type { Meta, StoryObj } from "@storybook/react";
import {
  BarChart3,
  BotIcon,
  CoinsIcon,
  CopyCheckIcon,
  FileTextIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LaptopIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  TimerOffIcon,
  UsersIcon,
} from "lucide-react";
import { expect, userEvent, within } from "storybook/test";

// Mirrors the live web sidebar (app.closedloop.ai, 2026-09-29): the
// GlobalSidebar in apps/app/app/(authenticated)/components/sidebar.tsx with
// the labs-nav-section rollout on. Workspace menu in the header, Dashboard,
// then the Artifacts, Labs and Your Teams sections. Issues and Judges are
// left out because the live app does not show them (their flags
// are off).

// The sr-only text inside SidebarTrigger, which is its accessible name.
const TOGGLE_SIDEBAR_LABEL = "Toggle Sidebar";

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

function GlobalNavDemo() {
  const pathname = usePath();
  // The preview's memory adapter starts at "/"; show Sessions as the active
  // view until an item is clicked so the default canvas matches the app.
  const activePath = pathname === "/" ? "/sessions" : pathname;

  return (
    <SidebarProvider>
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
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <span className="text-muted-foreground text-sm">Sessions</span>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">
          <div className="grid auto-rows-min gap-4 md:grid-cols-3">
            <div className="aspect-video rounded-xl bg-muted/50" />
            <div className="aspect-video rounded-xl bg-muted/50" />
            <div className="aspect-video rounded-xl bg-muted/50" />
          </div>
          <div className="min-h-0 flex-1 rounded-xl bg-muted/50" />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const meta: Meta<typeof Sidebar> = {
  title: "Composites v1.0/Navigation/Sidebar",
  component: Sidebar,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};
export default meta;

type Story = StoryObj<typeof Sidebar>;

/**
 * `SidebarMenuButton`'s full `variant` (default/outline) × `size`
 * (sm/default/lg) axis — before this story, "outline" and "sm" never
 * rendered anywhere in this file's realistic `GlobalNav` demo, which only
 * ever shows the implicit defaults plus one explicit `size="lg"` row.
 */
export const MenuButtonSizesAndVariants: Story = {
  tags: ["!manifest"],
  render: () => (
    <SidebarProvider>
      <Sidebar className="static! h-auto min-h-0" collapsible="none">
        <SidebarContent className="gap-4 p-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" tooltip="Small, default variant">
                <LaptopIcon />
                <span>Small, default variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Default size, default variant">
                <LaptopIcon />
                <span>Default size, default variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="Large, default variant">
                <LaptopIcon />
                <span>Large, default variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                tooltip="Small, outline variant"
                variant="outline"
              >
                <LaptopIcon />
                <span>Small, outline variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Default size, outline variant"
                variant="outline"
              >
                <LaptopIcon />
                <span>Default size, outline variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip="Large, outline variant"
                variant="outline"
              >
                <LaptopIcon />
                <span>Large, outline variant</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  ),
  parameters: { controls: { disable: true } },
};

export const GlobalNav: Story = {
  render: () => <GlobalNavDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "expanded"
    );

    // Collapse and expand through the real control rather than the provider,
    // so the trigger's own wiring is what is under test.
    await userEvent.click(
      canvas.getByRole("button", { name: TOGGLE_SIDEBAR_LABEL })
    );
    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "collapsed"
    );

    await userEvent.click(
      canvas.getByRole("button", { name: TOGGLE_SIDEBAR_LABEL })
    );
    await expect(sidebarRoot(canvasElement)).toHaveAttribute(
      "data-state",
      "expanded"
    );

    // Nav items are real links, so they are keyboard-reachable by construction
    // rather than by an onClick on a div — tabbing out of the search field at
    // the top of Labs lands on the first Labs item.
    //
    // Deliberately never clicked: the preview mounts ONE module-level memory
    // navigation adapter shared by every story in the sweep, so navigating
    // here would change the path the other stories render against.
    const dashboard = canvas.getByRole("link", { name: "Dashboard" });
    await expect(dashboard).toHaveAttribute("href", "/dashboard");

    const inbox = canvas.getByRole("link", { name: "Inbox" });
    canvas.getByPlaceholderText("Search").focus();
    await userEvent.tab();
    await expect(inbox).toHaveFocus();
  },
};

// The Sidebar root is the element carrying collapse state; it has no role or
// accessible name, so `data-slot` is the only handle for it.
function sidebarRoot(canvasElement: HTMLElement): Element {
  const root = canvasElement.querySelector('[data-slot="sidebar"]');
  if (root === null) {
    throw new Error("sidebar root did not render");
  }
  return root;
}
