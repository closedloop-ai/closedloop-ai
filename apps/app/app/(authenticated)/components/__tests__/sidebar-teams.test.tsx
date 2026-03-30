import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SidebarTeams } from "../sidebar-teams";

// Mock team data for tests
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

// Mock hooks
const mockUseTeams = vi.fn();
const mockUseIsMounted = vi.fn();
const mockUsePathname = vi.fn();

// Mock @/hooks/queries/use-teams
vi.mock("@/hooks/queries/use-teams", () => ({
  useTeams: () => mockUseTeams(),
  useDeleteTeam: vi.fn(() => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  })),
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
  BoxIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="box-icon" />
  ),
  ChevronRightIcon: () => <svg data-testid="chevron-right-icon" />,
  EllipsisIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="ellipsis-icon" />
  ),
  FileCodeIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="file-code-icon" />
  ),
  FileIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="file-icon" />
  ),
  FolderIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="folder-icon" />
  ),
  Layers2Icon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="layers2-icon" />
  ),
  PlusIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="plus-icon" />
  ),
  SettingsIcon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="settings-icon" />
  ),
  Trash2Icon: ({ className }: { className?: string }) => (
    <svg className={className} data-testid="trash2-icon" />
  ),
  UsersIcon: () => <svg data-testid="users-icon" />,
}));

// Mock DropdownMenu components
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button data-testid="dropdown-menu-item" onClick={onClick} type="button">
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
}));

// Mock DeleteConfirmationDialog
vi.mock("@/components/delete-confirmation-dialog", () => ({
  DeleteConfirmationDialog: ({
    open,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
    isPending?: boolean;
    itemName?: string;
    title?: string;
  }) =>
    open ? (
      <div data-testid="delete-confirmation-dialog">
        <button
          data-testid="delete-confirm-button"
          onClick={onConfirm}
          type="button"
        >
          Confirm
        </button>
        <button
          data-testid="delete-cancel-button"
          onClick={() => onOpenChange(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    ) : null,
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
    showOnHover?: boolean;
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
    onClick,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    tooltip?: string;
    className?: string;
    onClick?: React.MouseEventHandler;
  }) =>
    asChild ? (
      children
    ) : (
      // biome-ignore lint/a11y/useKeyWithClickEvents: test mock, no keyboard needed
      // biome-ignore lint/a11y/noStaticElementInteractions: test mock
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: test mock
      <div data-testid="sidebar-menu-button" onClick={onClick}>
        {children}
      </div>
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
    mockUseTeams.mockReturnValue({ data: mockTeams });
    mockUseIsMounted.mockReturnValue(true);
    mockUsePathname.mockReturnValue("/");
  });

  test("clicking team name button opens the team collapsible", () => {
    render(<SidebarTeams />);

    // Initially all teams are collapsed
    const collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("false");

    // Click the first team's name button to open it
    const teamButtons = screen.getAllByTestId("sidebar-menu-button");
    fireEvent.click(teamButtons[0]);

    // After clicking, team-1 should be open
    const updatedCollapsibles = screen.getAllByTestId("collapsible");
    expect(updatedCollapsibles[0].getAttribute("data-open")).toBe("true");
    expect(updatedCollapsibles[1].getAttribute("data-open")).toBe("false");
  });

  test("expanded team shows nav items for Projects, PRDs, Features, Plans", () => {
    const { container } = render(<SidebarTeams />);

    // Click to expand team-1
    const teamButtons = screen.getAllByTestId("sidebar-menu-button");
    fireEvent.click(teamButtons[0]);

    // Nav items should be visible via links
    expect(
      container.querySelector('a[href="/teams/team-1/projects"]')
    ).toBeTruthy();
    expect(
      container.querySelector('a[href="/teams/team-1/prds"]')
    ).toBeTruthy();
    expect(
      container.querySelector('a[href="/teams/team-1/features"]')
    ).toBeTruthy();
    expect(
      container.querySelector('a[href="/teams/team-1/plans"]')
    ).toBeTruthy();
  });

  test("toggling trigger open then closed collapses the team", () => {
    render(<SidebarTeams />);

    const teamButtons = screen.getAllByTestId("sidebar-menu-button");

    // Open team-1
    fireEvent.click(teamButtons[0]);
    let collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("true");

    // Close team-1
    fireEvent.click(teamButtons[0]);
    collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("false");
  });

  test("renders team names", () => {
    render(<SidebarTeams />);

    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.getByText("Design")).toBeTruthy();
  });

  test("renders correct nav links for each team", () => {
    const { container } = render(<SidebarTeams />);

    // Team nav links should be rendered (even if visually hidden by collapsed state)
    expect(
      container.querySelector('a[href="/teams/team-1/projects"]')
    ).toBeTruthy();
    expect(
      container.querySelector('a[href="/teams/team-2/projects"]')
    ).toBeTruthy();
  });

  test("auto-expands team matching the current route", () => {
    mockUsePathname.mockReturnValue("/teams/team-1/projects");

    render(<SidebarTeams />);

    // Team-1 should be auto-expanded due to matching pathname
    const collapsibles = screen.getAllByTestId("collapsible");
    expect(collapsibles[0].getAttribute("data-open")).toBe("true");
    expect(collapsibles[1].getAttribute("data-open")).toBe("false");
  });

  test("renders empty state when no teams exist", () => {
    mockUseTeams.mockReturnValue({ data: [] });

    render(<SidebarTeams />);

    // "Your Teams" label should still be visible
    expect(screen.getByText("Your Teams")).toBeTruthy();
    // No team items
    expect(screen.queryAllByTestId("collapsible")).toHaveLength(0);
  });
});
