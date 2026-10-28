import {
  NavigationActorStanding,
  NavigationCountStatus,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
  toNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import type { Meta, StoryObj } from "@storybook/react";
import {
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
} from "lucide-react";
import { WEB_SHELL_ROUTE_HREFS } from "../../../shared/lib/primary-nav-destinations";
import {
  SHELL_NAVIGATION_ITEMS,
  ShellNavigationSurface,
} from "../../../shared/lib/shell-navigation-contract";
import {
  buildNavigationSectionModel,
  type NavigationSectionInput,
} from "../lib/navigation-section-model";
import {
  buildShellNavigationSectionInputs,
  type ShellNavigationHostResolution,
  shellNavigationDestinationIds,
} from "../lib/shell-navigation-sections";
import { ShellSidebar } from "./shell-sidebar";

const HIERARCHY: readonly NavigationSectionInput[] = [
  {
    id: "primary",
    label: "Primary",
    collapsible: false,
    defaultOpen: true,
    destinations: [
      {
        id: "dashboard",
        label: "Dashboard",
        href: "/dashboard",
        offeredOnHost: true,
      },
    ],
  },
  {
    id: "artifacts",
    label: "Artifacts",
    collapsible: true,
    defaultOpen: true,
    destinations: [
      {
        id: "sessions",
        label: "Sessions",
        href: "/sessions",
        offeredOnHost: true,
      },
      {
        id: "branches",
        label: "Branches",
        href: "/branches",
        offeredOnHost: true,
      },
    ],
  },
  {
    id: "labs",
    label: "Labs",
    collapsible: true,
    defaultOpen: false,
    destinations: [
      { id: "inbox", label: "Inbox", href: "/inbox", offeredOnHost: true },
    ],
  },
];

const ICONS: Record<string, React.ReactNode> = {
  branches: <GitBranchIcon />,
  dashboard: <LayoutDashboardIcon />,
  inbox: <InboxIcon />,
  sessions: <HistoryIcon />,
};

function viewModel(
  overrides: Partial<NavigationViewModel> = {}
): NavigationViewModel {
  return {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
    organizationId: "org_1",
    destinations: {
      dashboard: { status: NavigationDestinationStatus.Ready },
      sessions: {
        status: NavigationDestinationStatus.Ready,
        count: toNavigationCount(3),
      },
      branches: { status: NavigationDestinationStatus.Ready },
      inbox: { status: NavigationDestinationStatus.Ready },
    },
    ...overrides,
  };
}

const meta = {
  title: "Composites v1.0/App Shell/Shell Sidebar",
  component: ShellSidebar,
  tags: ["deprecated", "autodocs"],
  args: {
    activePath: "/dashboard",
    renderIcon: (id: string) => ICONS[id] ?? null,
    sections: buildNavigationSectionModel(HIERARCHY, viewModel()),
  },
  decorators: [
    (Story) => (
      <NavigationProvider
        adapter={
          createMemoryNavigation({ initialPath: "/dashboard", orgSlug: "acme" })
            .adapter
        }
      >
        <SidebarProvider>
          <Story />
        </SidebarProvider>
      </NavigationProvider>
    ),
  ],
} satisfies Meta<typeof ShellSidebar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Dashboard primary, Sessions/Branches as launch artifacts, Labs collapsed. */
export const Default: Story = {};

/**
 * The projection has not landed. Every destination keeps its row and its name so
 * nothing disappears mid-load, and no row carries a count it cannot vouch for.
 */
export const Loading: Story = {
  args: {
    sections: buildNavigationSectionModel(
      HIERARCHY,
      viewModel({ projectionStatus: NavigationProjectionStatus.Pending })
    ),
  },
};

/**
 * The projection failed. Rows say "Unavailable" in words rather than by shade
 * alone, and none of them becomes a link the actor cannot follow.
 */
export const ProjectionFailed: Story = {
  args: {
    sections: buildNavigationSectionModel(
      HIERARCHY,
      viewModel({ projectionStatus: NavigationProjectionStatus.Error })
    ),
  },
};

/**
 * A count that could not be read renders no badge at all — never a `0`, which
 * would read as a measured "nothing new".
 */
export const UnreadableCount: Story = {
  args: {
    sections: buildNavigationSectionModel(
      HIERARCHY,
      viewModel({
        destinations: {
          dashboard: { status: NavigationDestinationStatus.Ready },
          sessions: {
            status: NavigationDestinationStatus.Ready,
            count: { status: NavigationCountStatus.Unavailable },
          },
          branches: { status: NavigationDestinationStatus.Ready },
          inbox: { status: NavigationDestinationStatus.Ready },
        },
      })
    ),
  },
};

const CONTRACT_HOST: ShellNavigationHostResolution = {
  surface: ShellNavigationSurface.Web,
  resolveRoute: (routeId) => {
    const href = WEB_SHELL_ROUTE_HREFS[routeId];
    return { href, offered: href !== null };
  },
  isGateOpen: () => true,
  offersControl: () => true,
};

const CONTRACT_INPUTS = buildShellNavigationSectionInputs(CONTRACT_HOST);

const CONTROL_LABELS = new Map<string, string>(
  SHELL_NAVIGATION_ITEMS.map((item) => [item.id, item.label])
);

/**
 * The real contract hierarchy on Web, built by the builder both hosts use, with
 * every gate open and a placeholder wherever a host renders its own control
 * (search, teams, dev mode). Expand Labs to see the nested groups.
 */
export const ContractHierarchy: Story = {
  args: {
    renderControl: (controlId: string) => (
      <PlaceholderControl controlId={controlId} />
    ),
    renderIcon: () => null,
    sections: buildNavigationSectionModel(
      CONTRACT_INPUTS,
      readyViewModelFor(shellNavigationDestinationIds(CONTRACT_INPUTS))
    ),
  },
};

/** Stands in for a host control; the real nodes belong to each host. */
function PlaceholderControl({ controlId }: { controlId: string }) {
  return (
    <SidebarMenu className="gap-0">
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-disabled="true"
          className="text-muted-foreground text-sm aria-disabled:opacity-100"
        >
          {CONTROL_LABELS.get(controlId) ?? controlId}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function readyViewModelFor(ids: readonly string[]): NavigationViewModel {
  const destinations: NavigationViewModel["destinations"] = {};
  for (const id of ids) {
    Object.assign(destinations, {
      [id]: { status: NavigationDestinationStatus.Ready },
    });
  }
  return viewModel({ destinations });
}
