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
      el.textContent?.includes("% of documents and issues complete")
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
      el.textContent?.includes("% of documents and issues complete")
    );
    expect(statusTooltips).toHaveLength(2);
  });

  it("renders the empty state when projects list is empty", () => {
    render(<ProjectsTable projects={[]} teamId="team-1" />);

    expect(screen.getByText("No projects yet")).toBeInTheDocument();
  });
});

describe("ProjectsTable — empty population vs 0% (ISS-4679)", () => {
  it("an empty population renders a dashed track named 'No documents or issues yet'", () => {
    render(
      <ProjectsTable
        projects={[
          makeProject({
            completionPercentage: 0,
            completionPopulationEmpty: true,
          }),
        ]}
        teamId="team-1"
      />
    );

    // Accessible name = the empty summary (the ring's aria-label), shared with
    // the tooltip content.
    const icon = screen.getByRole("img", {
      name: "No documents or issues yet",
    });
    expect(icon).toBeInTheDocument();
    // ISS-4835/ISS-4812: the empty population is a DASH, not a ring of any
    // texture. It used to reuse the shipped dashed backlog track, which put the
    // exact Backlog-issue glyph on a project row of the same table and, at 16px,
    // sat one texture step away from a solid 0%. Asserting on the shape (a line,
    // and no circle at all) is what pins the distinction; a dasharray assertion
    // would go green again the moment someone swapped the track color back.
    expect(icon.querySelector("line")).not.toBeNull();
    expect(icon.querySelector("circle")).toBeNull();

    const tooltip = screen
      .getAllByTestId("tooltip-content")
      .find((el) => el.textContent === "No documents or issues yet");
    expect(tooltip).toBeInTheDocument();
  });

  it("0% completion renders a solid track named '0% of documents and issues complete'", () => {
    render(
      <ProjectsTable
        projects={[makeProject({ completionPercentage: 0 })]}
        teamId="team-1"
      />
    );

    const icon = screen.getByRole("img", {
      name: "0% of documents and issues complete",
    });
    expect(icon).toBeInTheDocument();
    // A real 0% is still a ring: a solid (non-dashed) track, and no dash.
    expect(icon.querySelector("circle")).not.toBeNull();
    expect(icon.querySelector("circle[stroke-dasharray='3 3']")).toBeNull();
    expect(icon.querySelector("line")).toBeNull();
  });

  it("the empty and 0% accessible names differ (they are different states)", () => {
    render(
      <ProjectsTable
        projects={[
          makeProject({
            id: "01PROJECT000000000000001",
            completionPercentage: 0,
            completionPopulationEmpty: true,
          }),
          makeProject({
            id: "01PROJECT000000000000002",
            completionPercentage: 0,
          }),
        ]}
        teamId="team-1"
      />
    );

    const emptyName = "No documents or issues yet";
    const zeroName = "0% of documents and issues complete";
    expect(emptyName).not.toBe(zeroName);
    expect(screen.getByRole("img", { name: emptyName })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: zeroName })).toBeInTheDocument();
  });
});

describe("ProjectsTable — completion ring without a flag provider", () => {
  it("renders the empty state with no flag provider mounted (Storybook/mini-table)", () => {
    // No FeatureFlagAdapterProvider. The empty-population ring is no longer
    // flag-gated, so the cell must still render it here rather than crashing on
    // a missing provider — the mount shape Storybook and the mini-table use.
    render(
      <ProjectsTable
        projects={[
          makeProject({
            completionPercentage: 0,
            completionPopulationEmpty: true,
          }),
        ]}
        teamId="team-1"
      />
    );

    expect(
      screen.getByRole("img", { name: "No documents or issues yet" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", {
        name: "0% of documents and issues complete",
      })
    ).toBeNull();
  });
});
