import { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamProjectsPage from "../page";

const columnVisibilityOptionsSpy = vi.hoisted(() => vi.fn());
const portableSurfaceFlagMock = vi.hoisted(() => vi.fn());
const updateTargetDateHookMock = vi.hoisted(() => vi.fn());

const useTeamMock = vi.fn();
const useProjectsByTeamMock = vi.fn();
const updateAssigneeMutateMock = vi.fn();
const updateTargetDateMutateAsyncMock = vi.fn();
const updatePriorityMutateMock = vi.fn();
const createProjectMutateAsyncMock = vi.fn();
const deleteProjectMutateAsyncMock = vi.fn();
const statusMutateMock = vi.fn();
const navigateMock = vi.fn();
const toastSuccessMock = vi.fn();

type ProjectsTableTestProps = {
  projects: unknown[];
  teamId: string;
  visibleColumns: string[];
  onCreateProject: () => void;
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

type ProjectsPortableSurfaceTestProps = {
  orgSlug: string;
  projects: unknown[];
  teamId: string;
  onUpdateAssignee: (projectId: string, assigneeId: string | null) => void;
  onUpdatePriority: (projectId: string, priority: string | null) => void;
};

type CreateProjectModalTestProps = {
  open: boolean;
  onCreateProject: (input: { name: string; teamId: string }) => Promise<void>;
};

function defaultProjectsTableProps(): ProjectsTableTestProps {
  return {
    projects: [],
    teamId: "",
    visibleColumns: [],
    onCreateProject: () => undefined,
    onDelete: () => Promise.resolve(false),
    onUpdateAssignee: () => undefined,
    onUpdateTargetDate: () => undefined,
    onUpdatePriority: () => undefined,
    onUpdateStatus: () => undefined,
  };
}

function defaultCreateProjectModalProps(): CreateProjectModalTestProps {
  return { open: false, onCreateProject: () => Promise.resolve() };
}

let latestProjectsTableProps: ProjectsTableTestProps =
  defaultProjectsTableProps();
let latestPortableSurfaceProps: ProjectsPortableSurfaceTestProps | null = null;
let latestCreateProjectModalProps: CreateProjectModalTestProps =
  defaultCreateProjectModalProps();

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => ({ teamId: "team-1" }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({
    navigate: navigateMock,
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeam: () => useTeamMock(),
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
  useUpdateProjectAssignee: () => ({ mutate: updateAssigneeMutateMock }),
  useUpdateProjectTargetDate: (...args: unknown[]) => {
    updateTargetDateHookMock(...args);
    return { mutateAsync: updateTargetDateMutateAsyncMock };
  },
  useUpdateProjectPriority: () => ({ mutate: updatePriorityMutateMock }),
  useCreateProject: () => ({ mutateAsync: createProjectMutateAsyncMock }),
  useDeleteProject: () => ({ mutateAsync: deleteProjectMutateAsyncMock }),
  useUpdateProjectStatus: () => ({
    mutate: (vars: unknown, opts?: { onSuccess?: () => void }) => {
      statusMutateMock(vars);
      opts?.onSuccess?.();
    },
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

// ISS-9726 wiring: a sentinel namespace, so an assertion below fails if this
// page ever addresses its raw base literal again instead of the namespaced key.
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => `ns::${baseKey}`,
}));

vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toastSuccessMock(...args) },
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({
    breadcrumbs,
    children,
  }: {
    breadcrumbs: { label: string }[];
    children?: React.ReactNode;
  }) => (
    <div data-testid="page-header">
      {breadcrumbs.map((crumb) => (
        <span key={crumb.label}>{crumb.label}</span>
      ))}
      {children}
    </div>
  ),
}));

vi.mock("@repo/app/documents/components/table/table-view-menu", () => ({
  TableViewMenu: () => <div data-testid="table-view-menu" />,
}));

vi.mock("../components/create-project-modal", () => ({
  CreateProjectModal: (props: CreateProjectModalTestProps) => {
    latestCreateProjectModalProps = props;
    return <div data-testid="create-project-modal" />;
  },
}));

vi.mock("../components/projects-table", () => ({
  ProjectsTable: (props: ProjectsTableTestProps) => {
    latestProjectsTableProps = props;
    return <div data-testid="projects-table" />;
  },
}));

vi.mock("../components/projects-portable-surface", () => ({
  ProjectsPortableSurface: (props: ProjectsPortableSurfaceTestProps) => {
    latestPortableSurfaceProps = props;
    return <div data-testid="projects-portable-surface" />;
  },
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) =>
    portableSurfaceFlagMock(key) ?? false,
}));

const TEAM = { id: "team-1", name: "Platform" };
const PROJECTS = [{ id: "project-1", name: "Apollo" }];

/**
 * Every `describe` in this file primes its own mocks. A sibling block that
 * inherited them from an earlier block's `beforeEach` passes in file order and
 * crashes run alone — which is also how it would hide a regression.
 */
function primePageMocks() {
  vi.clearAllMocks();
  latestProjectsTableProps = defaultProjectsTableProps();
  latestCreateProjectModalProps = defaultCreateProjectModalProps();
  latestPortableSurfaceProps = null;
  portableSurfaceFlagMock.mockReturnValue(false);

  useTeamMock.mockReturnValue({ data: TEAM, isLoading: false, error: null });
  useProjectsByTeamMock.mockReturnValue({
    data: PROJECTS,
    isLoading: false,
    error: null,
  });
  createProjectMutateAsyncMock.mockResolvedValue({ id: "project-9" });
  deleteProjectMutateAsyncMock.mockResolvedValue({ deleted: true });
  updateTargetDateMutateAsyncMock.mockResolvedValue(undefined);
}

describe("TeamProjectsPage", () => {
  beforeEach(primePageMocks);

  it("shows the loading spinner while the team query is in flight", () => {
    useTeamMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<TeamProjectsPage />);

    expect(screen.queryByTestId("page-header")).toBeNull();
    expect(screen.queryByTestId("projects-table")).toBeNull();
    expect(screen.queryByText("Team not found")).toBeNull();
  });

  it("shows the loading spinner while the projects query is in flight", () => {
    useProjectsByTeamMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<TeamProjectsPage />);

    expect(screen.queryByTestId("page-header")).toBeNull();
    expect(screen.queryByTestId("projects-table")).toBeNull();
  });

  it("shows the team query's own error message", () => {
    useTeamMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Forbidden: not a member of this team"),
    });

    render(<TeamProjectsPage />);

    expect(
      screen.getByText("Forbidden: not a member of this team")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("page-header")).toBeNull();
  });

  it("shows the projects query's error message when the team read succeeds", () => {
    useProjectsByTeamMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Projects unavailable"),
    });

    render(<TeamProjectsPage />);

    expect(screen.getByText("Projects unavailable")).toBeInTheDocument();
  });

  it("falls back to 'Team not found' when both reads settle with no error and no team", () => {
    useTeamMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });

    render(<TeamProjectsPage />);

    expect(screen.getByText("Team not found")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-table")).toBeNull();
  });

  it("composes the header and table once both reads succeed", () => {
    render(<TeamProjectsPage />);

    const header = screen.getByTestId("page-header");
    expect(header).toHaveTextContent("Platform");
    expect(header).toHaveTextContent("Projects");
    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
    expect(latestProjectsTableProps.projects).toEqual(PROJECTS);
    expect(latestProjectsTableProps.teamId).toBe("team-1");
  });

  it("excludes a column the user explicitly hid from visibleColumns", () => {
    render(<TeamProjectsPage />);

    expect(latestProjectsTableProps.visibleColumns).toEqual([
      "assignee",
      "dueDate",
      "updated",
    ]);
  });

  it("wires assignee updates to the assignee mutation", () => {
    render(<TeamProjectsPage />);

    latestProjectsTableProps.onUpdateAssignee("project-1", "user-2");

    expect(updateAssigneeMutateMock).toHaveBeenCalledWith({
      projectId: "project-1",
      assigneeId: "user-2",
    });
  });

  it("returns the target-date mutation settlement to the table", async () => {
    render(<TeamProjectsPage />);
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
    portableSurfaceFlagMock.mockImplementation(() => true);

    render(<TeamProjectsPage />);

    expect(updateTargetDateHookMock).toHaveBeenCalledWith();
  });

  it("wires priority updates to the priority mutation", () => {
    render(<TeamProjectsPage />);

    latestProjectsTableProps.onUpdatePriority("project-1", Priority.High);

    expect(updatePriorityMutateMock).toHaveBeenCalledWith({
      projectId: "project-1",
      priority: Priority.High,
    });
  });

  it("creates a project and navigates to its detail route", async () => {
    render(<TeamProjectsPage />);

    await latestCreateProjectModalProps.onCreateProject({
      name: "New project",
      teamId: "team-1",
    });

    expect(createProjectMutateAsyncMock).toHaveBeenCalledWith({
      name: "New project",
      teamId: "team-1",
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/acme/teams/team-1/projects/project-9"
    );
  });

  it("resolves a delete to the mutation's own `deleted` flag", async () => {
    render(<TeamProjectsPage />);

    const result = await latestProjectsTableProps.onDelete("project-1");

    expect(deleteProjectMutateAsyncMock).toHaveBeenCalledWith("project-1");
    expect(result).toBe(true);
  });

  it("defaults a delete result to false when the mutation omits `deleted`", async () => {
    deleteProjectMutateAsyncMock.mockResolvedValue({});
    render(<TeamProjectsPage />);

    const result = await latestProjectsTableProps.onDelete("project-1");

    expect(result).toBe(false);
  });

  it("archives a project and offers an undo that restores the previous status", () => {
    render(<TeamProjectsPage />);

    latestProjectsTableProps.onUpdateStatus(
      "project-1",
      ProjectStatus.Archived,
      ProjectStatus.InProgress
    );

    expect(statusMutateMock).toHaveBeenCalledWith({
      projectId: "project-1",
      status: ProjectStatus.Archived,
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Project archived",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      })
    );

    const [, options] = toastSuccessMock.mock.calls[0];
    options.action.onClick();

    expect(statusMutateMock).toHaveBeenLastCalledWith({
      projectId: "project-1",
      status: ProjectStatus.InProgress,
    });
  });

  it("unarchives a project with a plain success toast and no undo action", () => {
    render(<TeamProjectsPage />);

    latestProjectsTableProps.onUpdateStatus(
      "project-1",
      ProjectStatus.InProgress,
      ProjectStatus.Archived
    );

    expect(toastSuccessMock).toHaveBeenCalledWith("Project unarchived");
  });

  it("opens the create-project modal when the table's create action fires", () => {
    render(<TeamProjectsPage />);

    expect(latestCreateProjectModalProps.open).toBe(false);

    act(() => {
      latestProjectsTableProps.onCreateProject();
    });

    expect(latestCreateProjectModalProps.open).toBe(true);
  });
});

describe("ISS-9726 persisted view-state wiring", () => {
  beforeEach(primePageMocks);

  it("addresses the identity-namespaced column key, not the raw base literal", () => {
    render(<TeamProjectsPage />);

    expect(columnVisibilityOptionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: "ns::table:columns:team-projects" })
    );
  });
});

/**
 * ISS-10476 (ISS-4779 closed-by-default policy). This route is the flag's ONE
 * read, and it picks between two whole surfaces — so the thing worth pinning is
 * that each branch actually mounts, and that neither leaks the other's chrome.
 * The off-case asserts what is ABSENT alongside what is present, because a route
 * that rendered nothing at all would satisfy the absence on its own.
 */
describe("the portable Projects surface gate", () => {
  beforeEach(primePageMocks);

  it("reads the closed-by-default key and mounts today's table while it is off", () => {
    render(<TeamProjectsPage />);

    expect(portableSurfaceFlagMock).toHaveBeenCalledWith(
      PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY
    );
    expect(screen.getByTestId("projects-table")).toBeInTheDocument();
    expect(screen.getByTestId("table-view-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-portable-surface")).toBeNull();
  });

  it("mounts the portable surface instead once the key resolves on", () => {
    portableSurfaceFlagMock.mockReturnValue(true);

    render(<TeamProjectsPage />);

    expect(screen.getByTestId("projects-portable-surface")).toBeInTheDocument();
    expect(screen.queryByTestId("projects-table")).toBeNull();
    // The portable surface owns its own column control, so the legacy
    // `TableViewMenu` must not sit above it offering a second one.
    expect(screen.queryByTestId("table-view-menu")).toBeNull();
  });

  it("hands the portable surface the same projects and the org-scoped route it links rows to", () => {
    portableSurfaceFlagMock.mockReturnValue(true);

    render(<TeamProjectsPage />);

    expect(latestPortableSurfaceProps?.projects).toEqual(PROJECTS);
    expect(latestPortableSurfaceProps?.teamId).toBe("team-1");
    expect(latestPortableSurfaceProps?.orgSlug).toBe("acme");
  });

  it("routes a board regroup through the page's own project mutations", () => {
    portableSurfaceFlagMock.mockReturnValue(true);

    render(<TeamProjectsPage />);

    act(() => {
      latestPortableSurfaceProps?.onUpdatePriority("project-1", Priority.High);
      latestPortableSurfaceProps?.onUpdateAssignee("project-1", "user-9");
    });

    expect(updatePriorityMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ priority: Priority.High })
    );
    expect(updateAssigneeMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: "user-9" })
    );
  });
});
