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
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { PROJECT_COMPLETION_EMPTY_STATE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { ReactNode } from "react";
import { ProjectsTable } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/components/projects-table";

// ISS-4792 (ISS-4779 closed-by-default): the completion-ring empty-population
// state is gated behind `project-completion-empty-state` (default OFF). Mount the
// table under a flag adapter so tests can drive both branches: ON renders the new
// dashed empty ring, OFF renders the prior solid 0% ring. `enabledFlags: []`
// (default) reproduces the shipped default-off behavior.
function withEmptyStateFlag(
  ui: ReactNode,
  { enabled }: { enabled: boolean }
): ReactNode {
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: enabled
      ? [PROJECT_COMPLETION_EMPTY_STATE_FEATURE_FLAG_KEY]
      : [],
  });
  return (
    <FeatureFlagAdapterProvider adapter={adapter}>
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

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

describe("ProjectsTable — empty population vs 0% (ISS-4679, flag ON)", () => {
  it("an empty population renders a dashed track named 'No documents or issues yet'", () => {
    render(
      withEmptyStateFlag(
        <ProjectsTable
          projects={[
            makeProject({
              completionPercentage: 0,
              completionPopulationEmpty: true,
            }),
          ]}
          teamId="team-1"
        />,
        { enabled: true }
      )
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
      withEmptyStateFlag(
        <ProjectsTable
          projects={[makeProject({ completionPercentage: 0 })]}
          teamId="team-1"
        />,
        { enabled: true }
      )
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
      withEmptyStateFlag(
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
        />,
        { enabled: true }
      )
    );

    const emptyName = "No documents or issues yet";
    const zeroName = "0% of documents and issues complete";
    expect(emptyName).not.toBe(zeroName);
    expect(screen.getByRole("img", { name: emptyName })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: zeroName })).toBeInTheDocument();
  });
});

describe("ProjectsTable — completion-ring empty state gated OFF (ISS-4792, default)", () => {
  it("empty population renders the PRIOR solid 0% ring, not the dashed empty state", () => {
    render(
      withEmptyStateFlag(
        <ProjectsTable
          projects={[
            makeProject({
              completionPercentage: 0,
              completionPopulationEmpty: true,
            }),
          ]}
          teamId="team-1"
        />,
        { enabled: false }
      )
    );

    // Flag OFF: the empty population falls through to the prior behavior — a
    // solid 0% ring named "0% of documents and issues complete". The new dashed
    // "No documents or issues yet" empty state must be absent.
    expect(
      screen.queryByRole("img", { name: "No documents or issues yet" })
    ).toBeNull();
    const icon = screen.getByRole("img", {
      name: "0% of documents and issues complete",
    });
    expect(icon).toBeInTheDocument();
    expect(icon.querySelector("circle[stroke-dasharray='3 3']")).toBeNull();
  });

  it("degrades to the prior behavior with no flag provider mounted (Storybook/mini-table)", () => {
    // No FeatureFlagAdapterProvider — the ProjectNameCell reads the flag via the
    // optional hook, so it resolves OFF and renders the prior solid 0% ring
    // rather than crashing.
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
      screen.queryByRole("img", { name: "No documents or issues yet" })
    ).toBeNull();
    expect(
      screen.getByRole("img", { name: "0% of documents and issues complete" })
    ).toBeInTheDocument();
  });
});
