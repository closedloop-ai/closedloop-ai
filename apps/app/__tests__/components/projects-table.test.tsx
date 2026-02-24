/**
 * Unit tests for ProjectsTable component.
 * Focuses on the HexagonProgress tooltip: correct text and element presence.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock @dnd-kit/sortable — used by SortableContext and SortableProjectRow
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  verticalListSortingStrategy: {},
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
}));

// Mock @dnd-kit/utilities — used by SortableProjectRow
vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: vi.fn(() => ""),
    },
  },
}));

// Mock next/navigation — useSortParams calls useRouter, usePathname, useSearchParams
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/teams/team-1/projects"),
  useSearchParams: vi.fn(
    () =>
      new URLSearchParams() as unknown as ReturnType<
        typeof import("next/navigation").useSearchParams
      >
  ),
}));

// Mock useOrganizationUsers — avoids needing a QueryClient provider
vi.mock("@/hooks/queries/use-users", () => ({
  useOrganizationUsers: vi.fn(() => ({ data: [] })),
}));

// Mock Tooltip components so TooltipContent renders inline (not in a Portal)
// This lets us assert on the tooltip text without hover simulation.
vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

// Import after mocks
import type { ProjectWithDetails } from "@repo/api/src/types/organization";
import { ProjectsTable } from "@/app/(authenticated)/teams/[teamId]/projects/components/projects-table";

const makeProject = (
  overrides?: Partial<ProjectWithDetails>
): ProjectWithDetails => ({
  id: "01PROJECT000000000000000",
  organizationId: "org-1",
  name: "Test Project",
  description: null,
  priority: "MEDIUM",
  ownerId: null,
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  status: 42,
  teams: [],
  ...overrides,
});

describe("ProjectsTable — status tooltip", () => {
  it("renders the HexagonProgress element for each project row", () => {
    render(<ProjectsTable projects={[makeProject()]} teamId="team-1" />);

    // HexagonProgress renders a data-slot attribute
    const hexagon = document.querySelector("[data-slot='hexagon-progress']");
    expect(hexagon).toBeInTheDocument();
  });

  it("renders tooltip content with the correct explanatory text", () => {
    render(<ProjectsTable projects={[makeProject()]} teamId="team-1" />);

    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('% of artifacts in "Complete" status');
  });

  it("renders one tooltip per project row", () => {
    const projects = [
      makeProject({ id: "01PROJECT000000000000001", name: "Alpha" }),
      makeProject({ id: "01PROJECT000000000000002", name: "Beta" }),
    ];

    render(<ProjectsTable projects={projects} teamId="team-1" />);

    expect(screen.getAllByTestId("tooltip-content")).toHaveLength(2);
  });

  it("renders the empty state when projects list is empty", () => {
    render(<ProjectsTable projects={[]} teamId="team-1" />);

    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });
});
