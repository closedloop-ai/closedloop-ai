import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactBoardGroup,
  type ProjectArtifactBoardPageResponse,
} from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
} from "@repo/api/src/types/project-artifact-board-view";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { ArtifactBoardSelectionIntent } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectArtifactBoardProps } from "./project-artifact-board";
import { ProjectArtifactBoardSurface } from "./project-artifact-board-surface";

const ARTIFACT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const DESTINATION_ID = "00000000-0000-4000-8000-000000000005";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  boardQuery: {
    data: undefined as ProjectArtifactBoardPageResponse | undefined,
    error: null as Error | null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    isSuccess: true,
  },
  move: {
    data: undefined as unknown,
    error: null as Error | null,
    isPending: false,
    mutate: vi.fn(),
    undo: vi.fn(),
    undoMutation: { isPending: false },
    variables: undefined,
  },
  projects: [] as Array<{ id: string; name: string }>,
  selectionProps: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: () => false,
}));

vi.mock("@repo/app/projects/hooks/use-project-artifact-board-page", () => ({
  useProjectArtifactBoardPage: () => mocks.boardQuery,
}));

vi.mock("@repo/app/projects/hooks/use-artifact-placement", async () => ({
  resolveBoardPlacementVersions: (
    await vi.importActual<
      typeof import("@repo/app/projects/hooks/use-artifact-placement")
    >("@repo/app/projects/hooks/use-artifact-placement")
  ).resolveBoardPlacementVersions,
  useArtifactPlacement: () => mocks.move,
}));

vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => ({ get: mocks.apiGet }),
}));

vi.mock(
  "@repo/app/projects/hooks/use-project-artifact-board-analytics",
  () => ({ useProjectArtifactBoardAnalytics: () => undefined })
);

vi.mock("@repo/app/projects/hooks/use-project-artifact-list-metadata", () => ({
  useProjectArtifactMetadata: () => ({
    peopleByArtifactId: new Map(),
    peopleReads: {
      branches: { isLoading: false },
      deployments: { isLoading: false },
      documents: { isLoading: false },
      sessions: { isLoading: false },
    },
    relatedSessions: { isLoading: false },
  }),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({ data: mocks.projects }),
}));

vi.mock(
  "./project-artifact-board-selection-actions",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("./project-artifact-board-selection-actions")
      >();
    return {
      ProjectArtifactBoardSelectionActions: (
        props: Parameters<typeof actual.ProjectArtifactBoardSelectionActions>[0]
      ) => {
        mocks.selectionProps(props);
        return <actual.ProjectArtifactBoardSelectionActions {...props} />;
      },
    };
  }
);

vi.mock("./project-artifact-board", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./project-artifact-board")>();
  return {
    ...actual,
    ProjectArtifactBoard: ({
      onSelectionChange,
    }: ProjectArtifactBoardProps) => (
      <button
        onClick={() =>
          onSelectionChange(ARTIFACT_ID, ArtifactBoardSelectionIntent.Replace)
        }
        type="button"
      >
        Select root
      </button>
    ),
  };
});

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

const boardView = {
  arrangement: {
    cardFieldIds: [],
    collapsedLaneIds: [],
    laneField: ProjectArtifactBoardGroup.Status,
    laneOrder: [],
    layout: ProjectArtifactBoardLayout.Board,
    manualOrder: true,
  },
  version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
};

function boardData(): ProjectArtifactBoardPageResponse {
  const timestamp = new Date("2026-10-19T00:00:00.000Z");
  return {
    lanes: [
      {
        cards: [
          {
            artifact: {
              assignee: null,
              assigneeId: null,
              createdAt: timestamp,
              createdById: null,
              dueDate: null,
              externalUrl: null,
              id: ARTIFACT_ID,
              name: "Ship Artifact Board",
              organizationId: "00000000-0000-4000-8000-000000000003",
              priority: Priority.High,
              projectId: PROJECT_ID,
              slug: "ISS-724",
              sortOrder: 1024,
              status: IssueStatus.InProgress,
              subtype: ArtifactSubtype.Feature,
              type: ArtifactType.Document,
              updatedAt: timestamp,
            },
            descendantCount: 0,
          },
        ],
        complete: true,
        count: 1,
        id: IssueStatus.InProgress,
        label: "In Progress",
      },
    ],
    populationRevision: "a".repeat(64),
    projectVersion: "board-version",
    rootIds: [ARTIFACT_ID],
  };
}

function renderSurface() {
  return render(
    <ProjectArtifactBoardSurface
      boardView={boardView}
      editHandlers={{}}
      filterText=""
      groupBy={GroupByMode.Status}
      project={{ id: PROJECT_ID, name: "Apollo" }}
      projectId={PROJECT_ID}
      teamId="team-1"
    />
  );
}

describe("CT-19 Project board selected-root bulk actions", () => {
  beforeEach(() => {
    mocks.boardQuery.data = boardData();
    mocks.move.mutate.mockReset();
    mocks.apiGet.mockReset();
    mocks.selectionProps.mockReset();
    mocks.projects = [];
  });

  it("passes the selected root and project to the bulk-action host", async () => {
    const user = userEvent.setup();
    renderSurface();

    await user.click(screen.getByRole("button", { name: "Select root" }));

    expect(screen.getByLabelText("1 artifact selected")).toBeInTheDocument();
    expect(mocks.selectionProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project: { id: PROJECT_ID, name: "Apollo" },
        selectedArtifacts: [expect.objectContaining({ id: ARTIFACT_ID })],
        selectedCount: 1,
      })
    );
  });

  it("retains selection when placement refuses a destination", async () => {
    mocks.projects = [
      { id: PROJECT_ID, name: "Apollo" },
      { id: DESTINATION_ID, name: "Beta" },
    ];
    mocks.move.mutate.mockImplementation(
      (_request: unknown, options?: { onError?: (error: Error) => void }) => {
        options?.onError?.(new Error("Placement refused"));
      }
    );
    mocks.apiGet.mockResolvedValue({ projectVersion: "destination-version" });
    const user = userEvent.setup();
    renderSurface();

    await user.click(screen.getByRole("button", { name: "Select root" }));
    await user.click(screen.getByRole("button", { name: "Move to project" }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));

    expect(mocks.move.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceArtifactIds: [ARTIFACT_ID] }),
      expect.objectContaining({ onError: expect.any(Function) })
    );
    expect(screen.getByLabelText("1 artifact selected")).toBeInTheDocument();
  });
});
