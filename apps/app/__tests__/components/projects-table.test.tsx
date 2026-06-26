/**
 * Unit tests for ProjectsTable component.
 * Focuses on the StatusPercentageIcon tooltip: correct text and element presence.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
  useParams: vi.fn(() => ({ orgSlug: "test-org", teamId: "team-1" })),
}));

// Mock useOrganizationUsers — avoids needing a QueryClient provider
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: vi.fn(() => ({ data: [] })),
}));

// Mock favorites hooks — avoids needing ClerkProvider for useAuth
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useIsFavorite: vi.fn(() => false),
  useToggleFavorite: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
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
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectsTable } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/components/projects-table";

const makeProject = (
  overrides?: Partial<ProjectWithDetails>
): ProjectWithDetails => ({
  id: "01PROJECT000000000000000",
  organizationId: "org-1",
  name: "Test Project",
  description: null,
  priority: "MEDIUM",
  assigneeId: null,
  createdById: "user-1",
  slug: null,
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  status: "IN_PROGRESS",
  completionPercentage: 42,
  teams: [],
  ...overrides,
});

describe("ProjectsTable — status tooltip", () => {
  it("renders the StatusPercentageIcon element for each project row", () => {
    render(<ProjectsTable projects={[makeProject()]} teamId="team-1" />);

    // StatusPercentageIcon renders a data-slot attribute
    const icon = document.querySelector("[data-slot='status-percentage-icon']");
    expect(icon).toBeInTheDocument();
  });

  it("renders tooltip content with the correct explanatory text", () => {
    render(<ProjectsTable projects={[makeProject()]} teamId="team-1" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const statusTooltip = tooltips.find((el) =>
      el.textContent?.includes("% of artifacts complete")
    );
    expect(statusTooltip).toBeInTheDocument();
  });

  it("renders one status tooltip per project row", () => {
    const projects = [
      makeProject({ id: "01PROJECT000000000000001", name: "Alpha" }),
      makeProject({ id: "01PROJECT000000000000002", name: "Beta" }),
    ];

    render(<ProjectsTable projects={projects} teamId="team-1" />);

    const tooltips = screen.getAllByTestId("tooltip-content");
    const statusTooltips = tooltips.filter((el) =>
      el.textContent?.includes("% of artifacts complete")
    );
    expect(statusTooltips).toHaveLength(2);
  });

  it("renders the empty state when projects list is empty", () => {
    render(<ProjectsTable projects={[]} teamId="team-1" />);

    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });
});
