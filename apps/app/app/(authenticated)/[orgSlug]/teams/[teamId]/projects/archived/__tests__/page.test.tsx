import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamArchivedProjectsPage from "../page";

const columnVisibilityOptionsSpy = vi.hoisted(() => vi.fn());
const featureFlagMock = vi.hoisted(() => vi.fn());
const updateTargetDateHookMock = vi.hoisted(() => vi.fn());

const useTeamMock = vi.fn();
const useProjectsByTeamMock = vi.fn();
const updateAssigneeMutateMock = vi.fn();
const updateTargetDateMutateAsyncMock = vi.fn();
const updatePriorityMutateMock = vi.fn();
const deleteProjectMutateAsyncMock = vi.fn();
const handleUpdateStatusMock = vi.fn();

type ProjectsTableTestProps = {
  projects: unknown[];
  teamId: string;
  visibleColumns: string[];
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  onDelete: (projectId: string) => Promise<boolean>;
  onUpdateAssignee: (projectId: string, assigneeId: string | null) => void;
  onUpdateTargetDate: (
    projectId: string,
    date: Date | null,
    recoverableErrorOwner?: () => boolean
  ) => Promise<unknown> | undefined;
  onUpdatePriority: (projectId: string, priority: string) => void;
  onUpdateStatus: (
    projectId: string,
    status: string,
    previousStatus: string
  ) => void;
};

function defaultProjectsTableProps(): ProjectsTableTestProps {
  return {
    projects: [],
    teamId: "",
    visibleColumns: [],
    onDelete: () => Promise.resolve(false),
    onUpdateAssignee: () => undefined,
    onUpdateTargetDate: () => undefined,
    onUpdatePriority: () => undefined,
    onUpdateStatus: () => undefined,
  };
}

let latestProjectsTableProps: ProjectsTableTestProps =
  defaultProjectsTableProps();

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => ({ teamId: "team-1" }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeam: () => useTeamMock(),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjectsByTeam: () => useProjectsByTeamMock(),
  useUpdateProjectAssignee: () => ({ mutate: updateAssigneeMutateMock }),
  useUpdateProjectTargetDate: (...args: unknown[]) => {
    updateTargetDateHookMock(...args);
    return { mutateAsync: updateTargetDateMutateAsyncMock };
  },
  useUpdateProjectPriority: () => ({ mutate: updatePriorityMutateMock }),
  useDeleteProject: () => ({ mutateAsync: deleteProjectMutateAsyncMock }),
  useProjectStatusHandler: () => ({
    handleUpdateStatus: handleUpdateStatusMock,
  }),
}));

vi.mock("@repo/app/shared/hooks/use-column-visibility", () => ({
  PROJECT_DEFAULT_COLUMNS: ["priority", "assignee", "dueDate", "updated"],
  useColumnVisibility: (options: { storageKey: string | null }) => {
    columnVisibilityOptionsSpy(options);
    return {
      visibility: {},
      userVisibility: { priority: false },
      toggleColumn: vi.fn(),
    };
  },
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => featureFlagMock(key) ?? false,
}));

// ISS-9726 wiring: a sentinel namespace, so an assertion below fails if this
// page ever addresses its raw base literal again instead of the namespaced key.
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => `ns::${baseKey}`,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <div data-testid="page-header">
      {breadcrumbs.map((crumb) => (
        <span key={crumb.label}>{crumb.label}</span>
      ))}
    </div>
  ),
}));

vi.mock("@repo/app/documents/components/table/table-view-menu", () => ({
  TableViewMenu: () => <div data-testid="table-view-menu" />,
}));

vi.mock("../../components/projects-table", () => ({
  ProjectsTable: (props: ProjectsTableTestProps) => {
    latestProjectsTableProps = props;
    return <div data-testid="projects-table" />;
  },
}));

vi.mock("@repo/app/projects/components/project-index-page", () => ({
  ProjectIndexPage: ({ archived }: { archived?: boolean }) => (
    <div data-archived={String(archived)} data-testid="project-index-page" />
  ),
}));

const TEAM = { id: "team-1", name: "Platform" };
const PROJECTS = [{ id: "project-1", name: "Apollo (archived)" }];

describe("TeamArchivedProjectsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestProjectsTableProps = defaultProjectsTableProps();

    useTeamMock.mockReturnValue({ data: TEAM, isLoading: false, error: null });
    useProjectsByTeamMock.mockReturnValue({
      data: PROJECTS,
      isLoading: false,
      error: null,
    });
    deleteProjectMutateAsyncMock.mockResolvedValue({ deleted: true });
    updateTargetDateMutateAsyncMock.mockResolvedValue(undefined);
    featureFlagMock.mockReturnValue(false);
  });

  it("shows the loading spinner while the team query is in flight", () => {
    useTeamMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<TeamArchivedProjectsPage />);

    expect(screen.queryByTestId("page-header")).toBeNull();
    expect(screen.queryByTestId("projects-table")).toBeNull();
  });

  it("shows the loading spinner while the projects query is in flight", () => {
    useProjectsByTeamMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<TeamArchivedProjectsPage />);

    expect(screen.queryByTestId("projects-table")).toBeNull();
  });

  it("shows the team query's own error message", () => {
    useTeamMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Forbidden: not a member of this team"),
    });

    render(<TeamArchivedProjectsPage />);

    expect(
      screen.getByText("Forbidden: not a member of this team")
    ).toBeInTheDocument();
  });

  it("shows the projects query's error message when the team read succeeds", () => {
    useProjectsByTeamMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Projects unavailable"),
    });

    render(<TeamArchivedProjectsPage />);

    expect(screen.getByText("Projects unavailable")).toBeInTheDocument();
  });

  it("falls back to 'Team not found' when both reads settle with no error and no team", () => {
    useTeamMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    render(<TeamArchivedProjectsPage />);

    expect(screen.getByText("Team not found")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-table")).toBeNull();
  });

  it("composes the header and table with the archived empty-state copy", () => {
    render(<TeamArchivedProjectsPage />);

    const header = screen.getByTestId("page-header");
    expect(header).toHaveTextContent("Platform");
    expect(header).toHaveTextContent("Archived Projects");
    expect(latestProjectsTableProps.projects).toEqual(PROJECTS);
    expect(latestProjectsTableProps.emptyStateTitle).toBe(
      "No archived projects"
    );
    expect(latestProjectsTableProps.emptyStateDescription).toBe(
      "Archived projects will appear here."
    );
    expect(latestProjectsTableProps.onUpdateStatus).toBe(
      handleUpdateStatusMock
    );
  });

  it("excludes a column the user explicitly hid from visibleColumns", () => {
    render(<TeamArchivedProjectsPage />);

    expect(latestProjectsTableProps.visibleColumns).toEqual([
      "assignee",
      "dueDate",
      "updated",
    ]);
  });

  it("wires assignee updates to the assignee mutation", () => {
    render(<TeamArchivedProjectsPage />);

    latestProjectsTableProps.onUpdateAssignee("project-1", "user-2");

    expect(updateAssigneeMutateMock).toHaveBeenCalledWith({
      projectId: "project-1",
      assigneeId: "user-2",
    });
  });

  it("returns the target-date mutation settlement to the table", async () => {
    render(<TeamArchivedProjectsPage />);
    const targetDate = new Date("2026-01-01");
    const refusal = new Error("save refused");
    const recoverableErrorOwner = () => true;
    updateTargetDateMutateAsyncMock.mockRejectedValueOnce(refusal);

    const settlement = latestProjectsTableProps.onUpdateTargetDate(
      "project-1",
      targetDate,
      recoverableErrorOwner
    );

    expect(updateTargetDateMutateAsyncMock).toHaveBeenCalledWith({
      projectId: "project-1",
      recoverableErrorOwner,
      targetDate,
    });
    await expect(settlement).rejects.toBe(refusal);
  });

  it("leaves toast ownership to each attempt's feedback owner, not a flag read here", () => {
    featureFlagMock.mockImplementation(
      (key: string) => key !== PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
    );

    render(<TeamArchivedProjectsPage />);

    expect(updateTargetDateHookMock).toHaveBeenCalledWith();
  });

  it("wires priority updates to the priority mutation", () => {
    render(<TeamArchivedProjectsPage />);

    latestProjectsTableProps.onUpdatePriority("project-1", "HIGH");

    expect(updatePriorityMutateMock).toHaveBeenCalledWith({
      projectId: "project-1",
      priority: "HIGH",
    });
  });

  it("resolves a delete to the mutation's own `deleted` flag", async () => {
    render(<TeamArchivedProjectsPage />);

    const result = await latestProjectsTableProps.onDelete("project-1");

    expect(deleteProjectMutateAsyncMock).toHaveBeenCalledWith("project-1");
    expect(result).toBe(true);
  });

  it("defaults a delete result to false when the mutation omits `deleted`", async () => {
    deleteProjectMutateAsyncMock.mockResolvedValue({});
    render(<TeamArchivedProjectsPage />);

    const result = await latestProjectsTableProps.onDelete("project-1");

    expect(result).toBe(false);
  });
});

describe("ISS-9726 persisted view-state wiring", () => {
  it("addresses the identity-namespaced column key, not the raw base literal", () => {
    render(<TeamArchivedProjectsPage />);

    expect(columnVisibilityOptionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "ns::table:columns:team-projects-archived",
      })
    );
  });

  it("keeps the legacy table when only gridview-adoption is on (ISS-13035)", () => {
    featureFlagMock.mockImplementation(
      (key: string) => key === GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
    );

    render(<TeamArchivedProjectsPage />);

    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
    expect(screen.queryByTestId("project-index-page")).toBeNull();
  });

  it("mounts the portable archived index when projects-portable-surface is on (ISS-13035)", () => {
    featureFlagMock.mockImplementation(
      (key: string) => key === PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
    );

    render(<TeamArchivedProjectsPage />);

    expect(screen.getByTestId("project-index-page")).toHaveAttribute(
      "data-archived",
      "true"
    );
    expect(screen.queryByTestId("projects-table")).toBeNull();
  });
});
