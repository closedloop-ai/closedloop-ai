import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SidebarFavorites } from "../sidebar-favorites";

// Mock useFavoriteProjects
const mockUseFavoriteProjects = vi.fn();

vi.mock("@/hooks/queries/use-projects", () => ({
  useFavoriteProjects: () => mockUseFavoriteProjects(),
}));

// Mock next/navigation — must include all three hooks per CLAUDE.md convention
vi.mock("next/navigation", () => ({
  usePathname: () => "/teams/team-1/projects/project-1",
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Mock sidebar components
vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-group">{children}</div>
  ),
  SidebarGroupLabel: ({
    children,
    ...props
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <div data-testid="sidebar-group-label" {...props}>
      {children}
    </div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu">{children}</div>
  ),
  SidebarMenuButton: ({
    children,
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <div data-testid="sidebar-menu-button">{children}</div>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-menu-item">{children}</div>
  ),
}));

// Mock collapsible
vi.mock("@repo/design-system/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="collapsible">{children}</div>
  ),
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
  CollapsibleTrigger: ({
    children,
    ...props
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button data-testid="collapsible-trigger" type="button" {...props}>
      {children}
    </button>
  ),
}));

describe("SidebarFavorites", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns null when there are no favorites", () => {
    mockUseFavoriteProjects.mockReturnValue({ data: [] });

    const { container } = render(<SidebarFavorites />);

    expect(container.innerHTML).toBe("");
  });

  test("returns null when favorites data is undefined", () => {
    mockUseFavoriteProjects.mockReturnValue({ data: undefined });

    const { container } = render(<SidebarFavorites />);

    expect(container.innerHTML).toBe("");
  });

  test("renders favorites section with project names", () => {
    mockUseFavoriteProjects.mockReturnValue({
      data: [
        {
          id: "project-1",
          name: "My Favorite Project",
          teams: [{ id: "team-1", name: "Team Alpha" }],
        },
        {
          id: "project-2",
          name: "Another Favorite",
          teams: [{ id: "team-2", name: "Team Beta" }],
        },
      ],
    });

    render(<SidebarFavorites />);

    expect(screen.getByText("Favorites")).toBeDefined();
    expect(screen.getByText("My Favorite Project")).toBeDefined();
    expect(screen.getByText("Another Favorite")).toBeDefined();
  });

  test("renders project links with correct href using first team", () => {
    mockUseFavoriteProjects.mockReturnValue({
      data: [
        {
          id: "project-1",
          name: "Test Project",
          teams: [
            { id: "team-abc", name: "Team A" },
            { id: "team-def", name: "Team B" },
          ],
        },
      ],
    });

    render(<SidebarFavorites />);

    const link = screen.getByText("Test Project").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/teams/team-abc/projects/project-1"
    );
  });

  test("renders fallback link when project has no teams", () => {
    mockUseFavoriteProjects.mockReturnValue({
      data: [
        {
          id: "project-orphan",
          name: "Orphan Project",
          teams: [],
        },
      ],
    });

    render(<SidebarFavorites />);

    const link = screen.getByText("Orphan Project").closest("a");
    expect(link?.getAttribute("href")).toBe("/projects");
  });
});
