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
const mockUseParams = vi.fn();
const mockUseOrganization = vi.fn();

// useNavOrgSlug reads Clerk's ACTIVE org (ISS-6567); the global clerk shim
// always reports none, which cannot express the gated cross-org state.
vi.mock("@repo/auth/client", () => ({
  useOrganization: () => mockUseOrganization(),
  useAuth: () => ({ isSignedIn: true }),
}));

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
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => mockUsePathname(),
  useParams: () => mockUseParams(),
}));

vi.mock("@repo/app/teams/components/team-modal", () => ({
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
    mockUseParams.mockReturnValue({ orgSlug: "test-org" });
    // A RESOLVED active org is the default these cases render under. ISS-7344
    // made `organization: null` mean "no slug yet" rather than "fall back to the
    // URL", so leaving it null here would exercise the held state below instead
    // of the rendering the cases are about.
    mockUseOrganization.mockReturnValue({
      organization: { slug: "test-org" },
      isLoaded: true,
    });
  });

  test("renders no team links until the active org resolves", () => {
    // ISS-7344: the window with no concrete org. The URL still names one and the
    // cache may still hold the previous org's teams, so splicing the two mints a
    // cross-org href for a team that belongs to neither. Hold the rows instead.
    mockUseParams.mockReturnValue({ orgSlug: "craft-five" });
    mockUseOrganization.mockReturnValue({
      organization: null,
      isLoaded: false,
    });

    const { container } = render(<SidebarTeams />);

    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(screen.queryByText("Engineering")).toBeNull();
    // The section itself still renders — this holds the links, not the shell.
    expect(screen.getByText("Your Teams")).toBeInTheDocument();
  });

  test("builds team links from the active org, never the URL's foreign slug", () => {
    // ISS-6567 reproduction: prod minted
    // `/craft-five/teams/<closedloop-ai team uuid>/projects` because the slug
    // came from the URL while the team ids came from active-org-scoped hooks.
    mockUseParams.mockReturnValue({ orgSlug: "craft-five" });
    mockUseOrganization.mockReturnValue({
      organization: { slug: "closedloop-ai" },
      isLoaded: true,
    });

    const { container } = render(<SidebarTeams />);
    const hrefs = [...container.querySelectorAll("a")].map((anchorEl) =>
      anchorEl.getAttribute("href")
    );

    // Positive sibling: a SidebarTeams that rendered no links would satisfy the
    // "nothing names craft-five" assertion on its own.
    expect(hrefs).toContain("/closedloop-ai/teams/team-1/projects");
    expect(hrefs.filter((href) => href?.includes("craft-five"))).toEqual([]);
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
