import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SidebarTeams } from "../sidebar-teams";

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

const mockUseTeams = vi.fn();
const mockUseFavoriteProjects = vi.fn();
const mockUseIsMounted = vi.fn();
const mockUsePathname = vi.fn();

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeams: () => mockUseTeams(),
  useDeleteTeam: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ deleted: true }),
    isPending: false,
  }),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useFavoriteProjects: () => mockUseFavoriteProjects(),
}));

vi.mock("@repo/app/shared/hooks/use-is-mounted", () => ({
  useIsMounted: () => mockUseIsMounted(),
}));

vi.mock("@repo/app/shared/components/delete-confirmation-dialog", () => ({
  DeleteConfirmationDialog: () => null,
}));

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu-item">{children}</div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
}));

vi.mock("@/app/(authenticated)/[orgSlug]/teams/components/team-modal", () => ({
  TeamModal: ({ trigger }: { trigger: React.ReactNode; team?: unknown }) => (
    <div data-testid="team-modal">{trigger}</div>
  ),
}));

vi.mock("lucide-react", () => ({
  ArchiveIcon: () => <svg data-testid="archive-icon" />,
  ChevronDownIcon: () => <svg data-testid="chevron-down-icon" />,
  EllipsisIcon: () => <svg data-testid="ellipsis-icon" />,
  Layers2Icon: () => <svg data-testid="layers2-icon" />,
  PlusIcon: () => <svg data-testid="plus-icon" />,
  SettingsIcon: () => <svg data-testid="settings-icon" />,
  Trash2Icon: () => <svg data-testid="trash2-icon" />,
  UsersIcon: () => <svg data-testid="users-icon" />,
}));

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
  SidebarMenuButton: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    tooltip?: string;
    className?: string;
    isActive?: boolean;
  }) =>
    asChild ? (
      children
    ) : (
      <div data-testid="sidebar-menu-button">{children}</div>
    ),
  SidebarMenuAction: ({ children }: { children: React.ReactNode }) => (
    <button data-testid="sidebar-menu-action" type="button">
      {children}
    </button>
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
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    isActive?: boolean;
  }) =>
    asChild ? (
      children
    ) : (
      <div data-testid="sidebar-menu-sub-button">{children}</div>
    ),
  SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-sub-item">{children}</div>
  ),
}));

describe("SidebarTeams", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTeams.mockReturnValue({ data: mockTeams });
    mockUseFavoriteProjects.mockReturnValue({ data: [] });
    mockUseIsMounted.mockReturnValue(true);
    mockUsePathname.mockReturnValue("/test-org");
  });

  test("renders each team as a direct link to its projects page", () => {
    render(<SidebarTeams />);
    const engLink = screen.getByText("Engineering").closest("a");
    const designLink = screen.getByText("Design").closest("a");
    expect(engLink?.getAttribute("href")).toBe(
      "/test-org/teams/team-1/projects"
    );
    expect(designLink?.getAttribute("href")).toBe(
      "/test-org/teams/team-2/projects"
    );
  });

  test("renders favorited projects nested under their team", () => {
    mockUseFavoriteProjects.mockReturnValue({
      data: [
        {
          id: "proj-1",
          name: "Web App",
          teams: [{ id: "team-1", name: "Engineering" }],
        },
        {
          id: "proj-2",
          name: "Brand Refresh",
          teams: [{ id: "team-2", name: "Design" }],
        },
      ],
    });
    render(<SidebarTeams />);
    const projLink = screen.getByText("Web App").closest("a");
    expect(projLink?.getAttribute("href")).toBe(
      "/test-org/teams/team-1/projects/proj-1"
    );
    const designProjLink = screen.getByText("Brand Refresh").closest("a");
    expect(designProjLink?.getAttribute("href")).toBe(
      "/test-org/teams/team-2/projects/proj-2"
    );
  });

  test("renders the 'Your Teams' header but no team items when teams list is empty", () => {
    mockUseTeams.mockReturnValue({ data: [] });
    const { container } = render(<SidebarTeams />);
    expect(screen.getByText("Your Teams")).toBeTruthy();
    expect(
      container.querySelectorAll('[data-testid="sidebar-menu-item"]').length
    ).toBe(0);
  });

  test("renders a fallback item when teams fail to load", () => {
    mockUseTeams.mockReturnValue({ data: undefined, isError: true });
    render(<SidebarTeams />);
    expect(screen.getByText("Teams unavailable")).toBeTruthy();
  });

  test("renders no sub-list when a team has no favorites", () => {
    mockUseFavoriteProjects.mockReturnValue({
      data: [
        {
          id: "proj-1",
          name: "Web App",
          teams: [{ id: "team-1", name: "Engineering" }],
        },
      ],
    });
    const { container } = render(<SidebarTeams />);
    const subLists = container.querySelectorAll(
      '[data-testid="sidebar-menu-sub"]'
    );
    expect(subLists.length).toBe(1);
  });
});
