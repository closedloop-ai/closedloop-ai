import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ARCHIVED_PROJECTS_EMPTY_COPY } from "../../lib/project-archived-copy";
import { ProjectIndexPage } from "../project-index-page";
import { ProjectsEmptyState } from "../projects-table";

const mocks = vi.hoisted(() => ({
  statusHandler: vi.fn(),
  surface: vi.fn(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => path,
}));
vi.mock("../../../shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (key: string) => key,
}));
vi.mock("../../../teams/hooks/use-teams", () => ({
  useTeam: () => ({
    data: { id: "team", name: "Team" },
    error: null,
    isLoading: false,
  }),
}));
vi.mock("../../hooks/use-projects", () => ({
  useCreateProject: () => ({ mutateAsync: vi.fn() }),
  useDeleteProject: () => ({ mutateAsync: vi.fn() }),
  useProjectStatusHandler: (options: unknown) => {
    mocks.statusHandler(options);
    return { handleUpdateStatus: vi.fn() };
  },
  useProjectsByTeam: () => ({ data: [], error: null, isLoading: false }),
  useUpdateProjectAssignee: () => ({ mutate: vi.fn() }),
  useUpdateProjectPriority: () => ({ mutate: vi.fn() }),
  useUpdateProjectTargetDate: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../project-index-bulk-actions", () => ({
  useProjectIndexBulkActions: () => ({ actions: [], enabled: false }),
}));
vi.mock("../create-project-modal", () => ({ CreateProjectModal: () => null }));
vi.mock("../projects-portable-surface", () => ({
  ProjectsPortableSurface: (props: unknown) => {
    mocks.surface(props);
    return null;
  },
}));

beforeEach(() => {
  mocks.statusHandler.mockClear();
  mocks.surface.mockClear();
});

describe("ProjectIndexPage archived mode (ISS-13035)", () => {
  it("ARCHIVED-1 offers Undo on unarchive, as the archived page always did", () => {
    render(<ProjectIndexPage archived teamId="team" />);

    expect(mocks.statusHandler).toHaveBeenCalledWith({
      showUndoOnUnarchive: true,
    });
  });

  it("ARCHIVED-2 offers no Undo on the active list", () => {
    render(<ProjectIndexPage teamId="team" />);

    expect(mocks.statusHandler).toHaveBeenCalledWith({
      showUndoOnUnarchive: false,
    });
  });

  it("ARCHIVED-3 hands the surface the archived empty-state words, and the active list none", () => {
    const archived = render(<ProjectIndexPage archived teamId="team" />);
    expect(mocks.surface.mock.lastCall?.[0]).toMatchObject({
      emptyStateCopy: ARCHIVED_PROJECTS_EMPTY_COPY,
    });
    archived.unmount();
    render(<ProjectIndexPage teamId="team" />);
    expect(mocks.surface.mock.lastCall?.[0]).toHaveProperty(
      "emptyStateCopy",
      undefined
    );
  });
});

describe("ProjectsEmptyState words", () => {
  it("ARCHIVED-4 draws the archived words when given them", () => {
    render(
      <ProjectsEmptyState emptyStateCopy={ARCHIVED_PROJECTS_EMPTY_COPY} />
    );

    expect(
      screen.getByText(ARCHIVED_PROJECTS_EMPTY_COPY.title)
    ).toBeInTheDocument();
    expect(
      screen.getByText(ARCHIVED_PROJECTS_EMPTY_COPY.description)
    ).toBeInTheDocument();
  });

  it("ARCHIVED-5 keeps the shared default words otherwise", () => {
    render(<ProjectsEmptyState />);

    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(screen.queryByText(ARCHIVED_PROJECTS_EMPTY_COPY.title)).toBeNull();
  });
});
