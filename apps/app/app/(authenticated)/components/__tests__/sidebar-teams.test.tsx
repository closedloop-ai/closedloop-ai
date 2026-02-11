import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SidebarTeams } from "../sidebar-teams";

// Mock team and project data for tests
const mockTeams = [
  {
    id: "team-1",
    organizationId: "org-1",
    name: "Engineering",
    slug: "engineering",
    memberCount: 5,
    projectCount: 3,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  },
  {
    id: "team-2",
    organizationId: "org-1",
    name: "Design",
    slug: "design",
    memberCount: 3,
    projectCount: 2,
    createdAt: new Date("2024-01-02"),
    updatedAt: new Date("2024-01-02"),
  },
];

const mockProjects = [
  {
    id: "project-1",
    organizationId: "org-1",
    name: "Project Alpha",
    description: "First project",
    priority: "HIGH" as const,
    ownerId: null,
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    status: 50,
    teams: [{ id: "team-1", name: "Engineering" }],
  },
  {
    id: "project-2",
    organizationId: "org-1",
    name: "Project Beta",
    description: "Second project",
    priority: "MEDIUM" as const,
    ownerId: null,
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    createdAt: new Date("2024-01-02"),
    updatedAt: new Date("2024-01-02"),
    status: 30,
    teams: [{ id: "team-1", name: "Engineering" }],
  },
  {
    id: "project-3",
    organizationId: "org-1",
    name: "Project Gamma",
    description: "Third project",
    priority: "LOW" as const,
    ownerId: null,
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    createdAt: new Date("2024-01-03"),
    updatedAt: new Date("2024-01-03"),
    status: 75,
    teams: [{ id: "team-1", name: "Engineering" }],
  },
];

// Mock hooks
const mockUseTeams = vi.fn();
const mockUseRecentProjectsByTeam = vi.fn();
const mockUseIsMounted = vi.fn();
const mockUsePathname = vi.fn();

// Mock @/hooks/queries/use-teams
vi.mock("@/hooks/queries/use-teams", () => ({
  useTeams: () => mockUseTeams(),
}));

// Mock @/hooks/queries/use-projects
vi.mock("@/hooks/queries/use-projects", () => ({
  useRecentProjectsByTeam: (teamId: string, options?: { enabled?: boolean }) =>
    mockUseRecentProjectsByTeam(teamId, options),
}));

// Mock @/hooks/use-is-mounted
vi.mock("@/hooks/use-is-mounted", () => ({
  useIsMounted: () => mockUseIsMounted(),
}));

// Mock next/link to render simple links in tests
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

// Mock team-modal to simplify testing
vi.mock("../team-modal", () => ({
  TeamModal: ({ trigger }: { trigger: React.ReactNode; team?: unknown }) => (
    <div data-testid="team-modal">{trigger}</div>
  ),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  ChevronRightIcon: () => <svg data-testid="chevron-right-icon" />,
  FolderIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="folder-icon" />
  ),
  PlusIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="plus-icon" />
  ),
  SettingsIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="settings-icon" />
  ),
  UsersIcon: () => <svg data-testid="users-icon" />,
}));

// Mock sidebar components
vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-group">{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-group-label">{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu">{children}</div>
  ),
  SidebarMenuAction: ({
    children,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <button
      className={className}
      data-testid="sidebar-menu-action"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  ),
  SidebarMenuButton: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    tooltip?: string;
    className?: string;
  }) =>
    asChild ? (
      children
    ) : (
      <div data-testid="sidebar-menu-button">{children}</div>
    ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-item">{children}</div>
  ),
  SidebarMenuSub: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-sub">{children}</div>
  ),
  SidebarMenuSubButton: ({
    children,
    asChild,
    isActive,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    isActive?: boolean;
  }) =>
    asChild ? (
      children
    ) : (
      <div data-active={isActive} data-testid="sidebar-menu-sub-button">
        {children}
      </div>
    ),
  SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-sub-item">{children}</div>
  ),
}));

// Mock collapsible components with proper state management
vi.mock("@repo/design-system/components/ui/collapsible", () => {
  const React = require("react");

  const CollapsibleContext = React.createContext({
    open: false,
    onOpenChange: undefined as ((open: boolean) => void) | undefined,
  });

  return {
    Collapsible: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      const contextValue = React.useMemo(
        () => ({ open: open ?? false, onOpenChange }),
        [open, onOpenChange]
      );

      const element = React.createElement(
        "div",
        {
          "data-testid": "collapsible",
          "data-open": open ?? false,
        },
        children
      );

      return React.createElement(
        CollapsibleContext.Provider,
        { value: contextValue },
        element
      );
    },
    CollapsibleTrigger: ({
      children,
      asChild,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
    }) => {
      const context = React.useContext(CollapsibleContext);
      const handleClick = () => {
        if (context.onOpenChange) {
          context.onOpenChange(!context.open);
        }
      };

      if (asChild && React.isValidElement(children)) {
        const element = children as React.ReactElement<any>;
        const originalOnClick = element.props?.onClick;
        return React.cloneElement(element, {
          onClick: (_e: any) => {
            handleClick();
            if (originalOnClick) {
              originalOnClick(_e);
            }
          },
          "data-collapsible-trigger": true,
        } as any);
      }

      return React.createElement(
        "button",
        {
          "data-testid": "collapsible-trigger",
          type: "button",
          onClick: handleClick,
        },
        children
      );
    },
    CollapsibleContent: ({ children }: { children: React.ReactNode }) => {
      const context = React.useContext(CollapsibleContext);
      return React.createElement(
        "div",
        {
          "data-testid": "collapsible-content",
          "data-open": context.open,
          style: context.open ? {} : { display: "none" },
        },
        children
      );
    },
  };
});

describe("SidebarTeams", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    mockUseTeams.mockReturnValue({ data: mockTeams });
    mockUseIsMounted.mockReturnValue(true);
    mockUsePathname.mockReturnValue("/");
    mockUseRecentProjectsByTeam.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
  });

  test("clicking trigger opens team and fetches projects with enabled: true", () => {
    // Return projects once team is expanded
    mockUseRecentProjectsByTeam.mockImplementation(
      (teamId: string, options?: { enabled?: boolean }) => {
        if (teamId === "team-1" && options?.enabled) {
          return { data: mockProjects, isLoading: false };
        }
        return { data: undefined, isLoading: false };
      }
    );

    render(<SidebarTeams />);

    // Initially all teams are collapsed
    const collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("false");

    // Click the first team's trigger to open it
    const triggers = screen.getAllByTestId("sidebar-menu-action");
    fireEvent.click(triggers[0]);

    // After clicking, team-1 should be open
    const updatedCollapsibles = screen.getAllByTestId("collapsible");
    expect(updatedCollapsibles[0].getAttribute("data-open")).toBe("true");
    expect(updatedCollapsibles[1].getAttribute("data-open")).toBe("false");

    // The hook should now be called with enabled: true for team-1
    expect(mockUseRecentProjectsByTeam).toHaveBeenCalledWith("team-1", {
      enabled: true,
    });
  });

  test("expanded team renders project names and links", () => {
    mockUseRecentProjectsByTeam.mockImplementation((teamId: string) => {
      if (teamId === "team-1") {
        return { data: mockProjects, isLoading: false };
      }
      return { data: undefined, isLoading: false };
    });

    const { container } = render(<SidebarTeams />);

    // Project names should be in the DOM (even if collapsible is visually hidden)
    expect(container.innerHTML).toContain("Project Alpha");
    expect(container.innerHTML).toContain("Project Beta");
    expect(container.innerHTML).toContain("Project Gamma");

    // Verify project links have correct href
    expect(
      container.querySelector('a[href="/teams/team-1/projects/project-1"]')
    ).toBeTruthy();
    expect(
      container.querySelector('a[href="/teams/team-1/projects/project-2"]')
    ).toBeTruthy();
    expect(
      container.querySelector('a[href="/teams/team-1/projects/project-3"]')
    ).toBeTruthy();
  });

  test("shows 3 skeleton loaders when team is expanded and loading", () => {
    mockUseRecentProjectsByTeam.mockImplementation(
      (teamId: string, options?: { enabled?: boolean }) => {
        if (teamId === "team-1" && options?.enabled) {
          return { data: undefined, isLoading: true };
        }
        return { data: undefined, isLoading: false };
      }
    );

    render(<SidebarTeams />);

    // Click trigger to expand team-1
    const triggers = screen.getAllByTestId("sidebar-menu-action");
    fireEvent.click(triggers[0]);

    // Verify team-1 is now open
    const collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("true");

    // Find skeleton loaders (animate-pulse divs) inside the first collapsible
    const firstCollapsible = collapsibles[0];
    const skeletonDivs = firstCollapsible.querySelectorAll(".animate-pulse");
    // 3 skeleton items * 2 divs each (icon + text) = 6
    expect(skeletonDivs.length).toBe(6);
  });

  test("toggling trigger open then closed collapses the team", () => {
    render(<SidebarTeams />);

    const triggers = screen.getAllByTestId("sidebar-menu-action");

    // Open team-1
    fireEvent.click(triggers[0]);
    let collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("true");

    // Close team-1
    fireEvent.click(triggers[0]);
    collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("false");

    // Hook should be called with enabled: false after closing
    const lastCallForTeam1 = mockUseRecentProjectsByTeam.mock.calls
      .filter((call: [string, { enabled?: boolean }?]) => call[0] === "team-1")
      .pop();
    expect(lastCallForTeam1?.[1]).toEqual({ enabled: false });
  });

  test("renders empty state when no teams exist", () => {
    mockUseTeams.mockReturnValue({ data: [] });

    render(<SidebarTeams />);

    expect(screen.getByText("Create a team")).toBeTruthy();
  });

  test("renders team names and correct links", () => {
    const { container } = render(<SidebarTeams />);

    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.getByText("Design")).toBeTruthy();

    expect(
      container.querySelector('a[href="/teams/team-1/projects"]')
    ).toBeTruthy();
    expect(
      container.querySelector('a[href="/teams/team-2/projects"]')
    ).toBeTruthy();
  });

  test("auto-expands team and highlights active project when on project detail page", () => {
    mockUsePathname.mockReturnValue("/teams/team-1/projects/project-1");
    mockUseRecentProjectsByTeam.mockImplementation((teamId: string) => {
      if (teamId === "team-1") {
        return { data: mockProjects, isLoading: false };
      }
      return { data: undefined, isLoading: false };
    });

    const { container } = render(<SidebarTeams />);

    // Team-1 should be auto-expanded
    const collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("true");
    expect(collapsibles[1].getAttribute("data-open")).toBe("false");

    // The hook for team-1 should be called with enabled: true
    expect(mockUseRecentProjectsByTeam).toHaveBeenCalledWith("team-1", {
      enabled: true,
    });

    // Verify the active project link exists
    expect(
      container.querySelector('a[href="/teams/team-1/projects/project-1"]')
    ).toBeTruthy();
  });
});
