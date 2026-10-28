import { PROJECTS_FILTER_SORT_MODEL_FLAG_KEY } from "@repo/api/src/types/projects-filter-sort-model-flag";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamProjectsPage from "../page";

/**
 * ISS-9346 — the rollout swap on the team Projects page.
 *
 * The flag is read at ONE site here and picks between two whole surfaces, so
 * these assert the SURFACE that mounted, not a prop carrying a boolean. Both
 * branches are covered: a test that only asserted the flag-off shape would pass
 * unchanged if the flag-on branch were never wired at all.
 */

const flagEnabledMock = vi.fn();
const useProjectsByTeamMock = vi.fn();

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => ({ teamId: "team-1" }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeam: () => ({
    data: { id: "team-1", name: "Platform" },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@repo/app/users/hooks/use-users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/app/users/hooks/use-users")>()),
  useOrganizationUsers: () => ({ data: undefined }),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjectsByTeam: () => useProjectsByTeamMock(),
  // #9107's project bulk actions read favorites through these hooks.
  useFavoriteProject: () => ({ mutateAsync: vi.fn() }),
  useFavoriteProjects: () => ({ data: undefined }),
  useUnfavoriteProject: () => ({ mutateAsync: vi.fn() }),
  useUpdateProjectAssignee: () => ({ mutate: vi.fn() }),
  useUpdateProjectTargetDate: () => ({ mutate: vi.fn() }),
  useUpdateProjectPriority: () => ({ mutate: vi.fn() }),
  useCreateProject: () => ({ mutateAsync: vi.fn() }),
  useDeleteProject: () => ({ mutateAsync: vi.fn() }),
  useUpdateProjectStatus: () => ({ mutate: vi.fn() }),
}));

vi.mock("@repo/app/shared/hooks/use-column-visibility", () => ({
  PROJECT_DEFAULT_COLUMNS: ["priority", "assignee", "dueDate", "updated"],
  useColumnVisibility: () => ({
    visibility: {},
    userVisibility: {},
    toggleColumn: vi.fn(),
  }),
}));

vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => baseKey,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="page-header">{children}</div>
  ),
}));

vi.mock("@repo/app/documents/components/table/table-view-menu", () => ({
  TableViewMenu: () => <div data-testid="table-view-menu" />,
}));

vi.mock("../components/create-project-modal", () => ({
  CreateProjectModal: () => <div data-testid="create-project-modal" />,
}));

vi.mock("../components/projects-table", () => ({
  ProjectsTable: () => <div data-testid="projects-table" />,
}));

vi.mock("../components/projects-filtered-surface", () => ({
  ProjectsFilteredSurface: () => (
    <div data-testid="projects-filtered-surface" />
  ),
}));

vi.mock("../components/projects-portable-surface", () => ({
  ProjectsPortableSurface: () => (
    <div data-testid="projects-portable-surface" />
  ),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => flagEnabledMock(key),
}));

describe("PRD-721 AC-5 / DT-FS-06 Projects filter/sort rollout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectsByTeamMock.mockReturnValue({
      data: [{ id: "project-1", name: "Apollo" }],
      isLoading: false,
      error: null,
    });
  });

  it("reads the rollout key by its canonical constant", () => {
    flagEnabledMock.mockReturnValue(false);

    render(<TeamProjectsPage />);

    expect(flagEnabledMock).toHaveBeenCalledWith(
      PROJECTS_FILTER_SORT_MODEL_FLAG_KEY
    );
  });

  /** Closed by default: the legacy surface is the rollback and still mounts. */
  it("mounts the plain table and no filter surface when the key is closed", () => {
    flagEnabledMock.mockReturnValue(false);

    render(<TeamProjectsPage />);

    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
    expect(
      screen.queryByTestId("projects-filtered-surface")
    ).not.toBeInTheDocument();
  });

  /**
   * An UNRESOLVED assignment — PostHog has not answered yet, or the flag does
   * not exist — must land on the closed branch, not on an undefined that reads
   * as "open enough".
   */
  it("keeps the legacy surface while the assignment is unresolved", () => {
    flagEnabledMock.mockReturnValue(undefined);

    render(<TeamProjectsPage />);

    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
    expect(
      screen.queryByTestId("projects-filtered-surface")
    ).not.toBeInTheDocument();
  });

  it("swaps to the filtered surface when the key is open", () => {
    // Keyed rather than blanket-true: ISS-10476 added a SECOND key to this
    // page whose branch supersedes this one, so a mock that opens every key
    // would assert the portable surface while claiming to cover this one.
    flagEnabledMock.mockImplementation(
      (key: string) => key === PROJECTS_FILTER_SORT_MODEL_FLAG_KEY
    );

    render(<TeamProjectsPage />);

    expect(screen.getByTestId("projects-filtered-surface")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-table")).not.toBeInTheDocument();
  });

  /** ISS-10476's documented precedence: the promoted surface supersedes both. */
  it("gives the portable surface precedence when both keys are open", () => {
    flagEnabledMock.mockImplementation(
      (key: string) =>
        key === PROJECTS_FILTER_SORT_MODEL_FLAG_KEY ||
        key === PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
    );

    render(<TeamProjectsPage />);

    expect(screen.getByTestId("projects-portable-surface")).toBeInTheDocument();
    expect(
      screen.queryByTestId("projects-filtered-surface")
    ).not.toBeInTheDocument();
  });
});
