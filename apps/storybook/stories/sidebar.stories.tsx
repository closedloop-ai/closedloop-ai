import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
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
  ChevronsUpDownIcon,
  CopyCheckIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LaptopIcon,
  Layers2Icon,
  LayoutDashboardIcon,
  type LucideIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SquareCheckIcon,
  UsersIcon,
} from "lucide-react";
import { expect, userEvent, within } from "storybook/test";

// Mirrors the finalized GlobalSidebar nav in apps/app
// (app/(authenticated)/components/sidebar.tsx): top-level items, then the
// Artifacts / Your Teams / Labs collapsible sections, then the compute and
// organization rows in the footer.

// The sr-only text inside SidebarTrigger, which is its accessible name.
const TOGGLE_SIDEBAR_LABEL = "Toggle Sidebar";

type NavItem = {
  title: string;
  href: string;
  icon: LucideIcon;
};

const TOP_LEVEL_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboardIcon },
  { title: "Inbox", href: "/inbox", icon: InboxIcon },
  { title: "My Tasks", href: "/my-tasks", icon: CopyCheckIcon },
];

const ARTIFACT_ITEMS: NavItem[] = [
  { title: "Documents", href: "/documents", icon: FileIcon },
  { title: "Issues", href: "/issues", icon: SquareCheckIcon },
  { title: "Sessions", href: "/sessions", icon: HistoryIcon },
  { title: "Branches", href: "/branches", icon: GitBranchIcon },
  { title: "Agents", href: "/agents", icon: BotIcon },
];

const LABS_ITEMS: NavItem[] = [
  { title: "Insights", href: "/insights", icon: BarChart3 },
  { title: "Loops", href: "/loops", icon: RotateCcwIcon },
];

type TeamEntry = {
  name: string;
  href: string;
  projects: { name: string; href: string }[];
};

const TEAMS: TeamEntry[] = [
  { name: "Closedloop Demo", href: "/teams/closedloop-demo", projects: [] },
  {
    name: "Closedloop",
    href: "/teams/closedloop",
    projects: [
      { name: "6/8-12", href: "/teams/closedloop/projects/week" },
      { name: "Ideas Triage", href: "/teams/closedloop/projects/ideas" },
      { name: "Design Cleanup", href: "/teams/closedloop/projects/design" },
    ],
  },
  {
    name: "Platform Engineering",
    href: "/teams/platform-engineering",
    projects: [],
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
            item.title === "Inbox" ? (
              <SidebarCountBadge count={10} />
            ) : undefined
          }
        />
      ))}
    </SidebarMenu>
  );
}

function ClosedloopMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      viewBox="0 0 100 100"
    >
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
}

function GlobalNavDemo(props: Parameters<typeof Sidebar>[0]) {
  const pathname = usePath();
  // The preview's memory adapter starts at "/"; show Sessions as the active
  // view until an item is clicked so the default canvas matches the app.
  const activePath = pathname === "/" ? "/sessions" : pathname;

  return (
    <SidebarProvider>
      <Sidebar variant="inset" {...props}>
        <form className="flex items-center px-2 pt-2.5">
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
        <SidebarContent className="gap-1 pt-2">
          <SidebarGroup className="p-1">
            <NavItemList activePath={activePath} items={TOP_LEVEL_ITEMS} />
          </SidebarGroup>

          <SidebarCollapsibleSection title="Artifacts">
            <NavItemList activePath={activePath} items={ARTIFACT_ITEMS} />
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
                  {team.projects.length > 0 && (
                    <SidebarMenuSub className="mr-0 gap-0 pr-0">
                      {team.projects.map((project) => (
                        <SidebarMenuSubItem key={project.name}>
                          <SidebarMenuSubButton
                            asChild
                            className="pr-0"
                            isActive={activePath === project.href}
                          >
                            <Link href={project.href}>
                              <Layers2Icon />
                              <span>{project.name}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarCollapsibleSection>

          <SidebarCollapsibleSection title="Labs">
            <NavItemList activePath={activePath} items={LABS_ITEMS} />
          </SidebarCollapsibleSection>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Compute target">
                <LaptopIcon />
                <span className="truncate">
                  Compute: parkerbyrd-MacBook-Pro
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="Organization">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
                  <ClosedloopMark />
                </div>
                <span className="truncate font-medium">Closedloop</span>
                <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
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
  title: "Design System/Navigation & Shell/Sidebar",
  component: Sidebar,
  tags: ["autodocs"],
  argTypes: {
    side: {
      options: ["left", "right"],
      control: { type: "radio" },
      description: "Edge the sidebar docks to.",
    },
    variant: {
      options: ["sidebar", "floating", "inset"],
      control: { type: "radio" },
    },
    collapsible: {
      options: ["offcanvas", "icon", "none"],
      control: { type: "radio" },
      description:
        "How the sidebar collapses: slide away, shrink to icons, or stay fixed.",
    },
    className: {
      control: "text",
    },
    children: {
      control: false,
    },
  },
  args: {
    side: "left",
    variant: "inset",
    collapsible: "offcanvas",
  },
  parameters: {
    layout: "fullscreen",
  },
};
export default meta;

type Story = StoryObj<typeof Sidebar>;

export const GlobalNav: Story = {
  render: (args) => <GlobalNavDemo {...args} />,
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
    // rather than by an onClick on a div — tabbing out of the search field
    // lands on the first one.
    //
    // Deliberately never clicked: the preview mounts ONE module-level memory
    // navigation adapter shared by every story in the sweep, so navigating
    // here would change the path the other stories render against.
    const dashboard = canvas.getByRole("link", { name: "Dashboard" });
    await expect(dashboard).toHaveAttribute("href", "/dashboard");

    canvas.getByPlaceholderText("Search").focus();
    await userEvent.tab();
    await expect(dashboard).toHaveFocus();
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
