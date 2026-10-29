import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID } from "@repo/api/src/types/project-artifact-board-move";
import {
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardGroup,
  type ProjectArtifactBoardPageResponse,
  ProjectArtifactBoardSort,
  ProjectArtifactBoardSortDirection,
} from "@repo/api/src/types/project-artifact-board-page";
import type { ProjectArtifactBoardView } from "@repo/api/src/types/project-artifact-board-view";
import {
  LEGACY_WAITING_WIRE_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import type { TableFilters } from "@repo/app/documents/hooks/use-table-filters";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import type { ProjectArtifactBoardPageSort } from "@repo/app/projects/hooks/use-project-artifact-board-page";
import { ARTIFACT_PLACEMENT_UNDO_LABEL } from "@repo/app/projects/lib/artifact-placement-copy";
import { GenericArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_ID,
  boardData,
  boardView,
  PROJECT_ID,
} from "./__tests__/support/project-artifact-board-surface-fixtures";
import { ProjectArtifactBoardField } from "./project-artifact-board";
import { ProjectArtifactBoardSurface } from "./project-artifact-board-surface";

const OTHER_KIND_ID = "00000000-0000-4000-8000-000000000005";
const MOVE_TO_LOW_PATTERN = /^Move to Low/;
const UNASSIGNED_PATTERN = /Unassigned/;
const ARTIFACT_SLUG_PATTERN = /^ISS-/;
const MOVE_TO_IN_PROGRESS_PATTERN = /^Move to In Progress/;

const mocks = vi.hoisted(() => ({
  boardPageArgs: [] as unknown[][],
  sharedStatusEnabled: false,
  boardQuery: {
    data: undefined as ReturnType<typeof boardData> | undefined,
    error: null as Error | null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    isSuccess: false,
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
  metadata: {
    calls: [] as Array<{
      artifacts: readonly { id: string }[];
      includePeople: boolean;
      includeRelatedSessions: boolean;
    }>,
    commentCount: undefined as number | undefined,
    relatedTotal: undefined as number | undefined,
  },
  navigate: vi.fn(),
  projects: [] as Array<{ id: string; name: string }>,
  apiGet: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) =>
    key === UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY && mocks.sharedStatusEnabled,
}));

vi.mock("@repo/app/projects/hooks/use-project-artifact-board-page", () => ({
  useProjectArtifactBoardPage: (...args: unknown[]) => {
    mocks.boardPageArgs.push(args);
    return mocks.boardQuery;
  },
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
  () => ({
    useProjectArtifactBoardAnalytics: () => undefined,
  })
);

vi.mock("@repo/app/projects/hooks/use-project-artifact-list-metadata", () => ({
  useProjectArtifactMetadata: (input: {
    artifacts: readonly { id: string }[];
    includePeople: boolean;
    includeRelatedSessions: boolean;
  }) => {
    mocks.metadata.calls.push(input);
    const read = { isLoading: false };
    return {
      peopleByArtifactId: new Map(
        mocks.metadata.commentCount === undefined
          ? []
          : input.artifacts.map((artifact) => [
              artifact.id,
              { commentCount: mocks.metadata.commentCount },
            ])
      ),
      peopleReads: {
        branches: read,
        deployments: read,
        documents: read,
        sessions: read,
      },
      relatedSessions: {
        data:
          mocks.metadata.relatedTotal === undefined
            ? undefined
            : {
                results: Object.fromEntries(
                  input.artifacts.map((artifact) => [
                    artifact.id,
                    { items: [], total: mocks.metadata.relatedTotal },
                  ])
                ),
              },
        isLoading: false,
      },
    };
  },
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({ data: mocks.projects }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

function renderSurface(
  options: {
    filterText?: string;
    filters?: TableFilters;
    listFilters?: ProjectArtifactBoardFilters;
    sort?: ProjectArtifactBoardPageSort;
    boardView?: ProjectArtifactBoardView;
    editHandlers?: RowEditHandlers;
    groupBy?: GroupByMode;
    onAddIssue?: (status: IssueStatus) => void;
  } = {}
) {
  return render(
    <ProjectArtifactBoardSurface
      boardView={options.boardView ?? boardView}
      editHandlers={options.editHandlers ?? {}}
      filters={options.filters}
      filterText={options.filterText ?? ""}
      groupBy={options.groupBy ?? GroupByMode.Status}
      listFilters={options.listFilters}
      onAddIssue={options.onAddIssue}
      project={{ id: PROJECT_ID, name: "Apollo" }}
      projectId={PROJECT_ID}
      sort={options.sort}
      teamId="team-1"
    />
  );
}

describe("CT-06 Project Artifact Board real-state adapter", () => {
  beforeEach(() => {
    mocks.sharedStatusEnabled = false;
    mocks.boardQuery.data = undefined;
    mocks.boardQuery.error = null;
    mocks.boardQuery.isLoading = false;
    mocks.boardQuery.isSuccess = false;
    mocks.boardQuery.fetchNextPage.mockReset();
    mocks.boardQuery.hasNextPage = false;
    mocks.boardQuery.isFetchingNextPage = false;
    mocks.move.error = null;
    mocks.move.data = undefined;
    mocks.move.isPending = false;
    mocks.move.mutate.mockReset();
    mocks.navigate.mockReset();
    mocks.projects = [];
    mocks.metadata.calls = [];
    mocks.boardPageArgs = [];
    mocks.metadata.commentCount = undefined;
    mocks.metadata.relatedTotal = undefined;
  });

  it("renders cards from the paginated production board contract", () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;

    renderSurface();

    expect(
      screen.getByRole("group", { name: "ISS-724 Ship Artifact Board" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps raw lanes with the universal flag off and shows five root lanes with it on", () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    const off = renderSurface();
    expect(
      document.querySelectorAll("[data-artifact-board-lane]")
    ).toHaveLength(13);
    expect(
      document.querySelector(
        `[data-artifact-board-lane="${IssueStatus.InProgress}"]`
      )
    ).not.toBeNull();
    off.unmount();

    mocks.sharedStatusEnabled = true;
    renderSurface({
      boardView: {
        ...boardView,
        arrangement: { ...boardView.arrangement, cardFieldIds: ["status"] },
      },
    });
    expect(
      [...document.querySelectorAll("[data-artifact-board-lane]")].map((lane) =>
        lane.getAttribute("data-artifact-board-lane")
      )
    ).toEqual(Object.values(ARTIFACT_STATUS_ROOT));
    expect(
      screen.getByRole("group", { name: "ISS-724 Ship Artifact Board" })
    ).toHaveTextContent("In Progress");
    expect(
      screen.getByRole("group", {
        name: ARTIFACT_STATUS_DISPLAY_LABELS[ARTIFACT_STATUS_ROOT.InProgress],
      })
    ).toHaveTextContent("Ship Artifact Board");
  });

  it("preserves the response order when one shared lane merges mixed raw-status buckets", () => {
    mocks.sharedStatusEnabled = true;
    const data = boardData(IssueStatus.Todo);
    const first = data.lanes[0]!.cards[0]!;
    const second = {
      ...first,
      artifact: {
        ...first.artifact,
        id: "00000000-0000-4000-8000-000000000004",
        name: "Second raw status",
        slug: "ISS-725",
        status: IssueStatus.Triage,
      },
    };
    const third = {
      ...first,
      artifact: {
        ...first.artifact,
        id: "00000000-0000-4000-8000-000000000005",
        name: "Third raw status",
        slug: "ISS-726",
      },
    };
    data.lanes[0]!.cards = [first, third];
    data.lanes[0]!.count = 2;
    data.lanes.push({
      cards: [second],
      complete: true,
      count: 1,
      id: IssueStatus.Triage,
      label: "Triage",
    });
    data.rootIds = [first.artifact.id, second.artifact.id, third.artifact.id];
    mocks.boardQuery.data = data;
    mocks.boardQuery.isSuccess = true;

    const firstRender = renderSurface();

    const todoLane = document.querySelector(
      `[data-artifact-board-lane="${ARTIFACT_STATUS_ROOT.Todo}"]`
    );
    expect(
      [...(todoLane?.querySelectorAll("[data-artifact-board-card]") ?? [])].map(
        (card) => card.getAttribute("data-artifact-board-card")
      )
    ).toEqual(data.rootIds);
    firstRender.unmount();
    data.rootIds = [second.artifact.id, first.artifact.id, third.artifact.id];
    mocks.boardQuery.data = { ...data };
    renderSurface();
    const reorderedLane = document.querySelector(
      `[data-artifact-board-lane="${ARTIFACT_STATUS_ROOT.Todo}"]`
    );
    expect(
      [
        ...(reorderedLane?.querySelectorAll("[data-artifact-board-card]") ??
          []),
      ].map((card) => card.getAttribute("data-artifact-board-card"))
    ).toEqual(data.rootIds);
  });

  it("shows legacy waiting sessions in the In progress lane and includes both in its count", () => {
    mocks.sharedStatusEnabled = true;
    const data = boardData(SESSION_STATUS.ACTIVE);
    const active = data.lanes[0]!.cards[0]!;
    active.artifact.type = ArtifactType.Session;
    active.artifact.subtype = null;
    const waiting = {
      ...active,
      artifact: {
        ...active.artifact,
        id: "00000000-0000-4000-8000-000000000004",
        name: "Waiting session",
        slug: null,
        status: LEGACY_WAITING_WIRE_STATUS,
      },
    };
    data.lanes.push({
      cards: [waiting],
      complete: true,
      count: 1,
      id: LEGACY_WAITING_WIRE_STATUS,
      label: "Waiting",
    });
    data.rootIds = [active.artifact.id, waiting.artifact.id];
    mocks.boardQuery.data = data;
    mocks.boardQuery.isSuccess = true;

    renderSurface();

    const lane = document.querySelector(
      `[data-artifact-board-lane="${ARTIFACT_STATUS_ROOT.InProgress}"]`
    );
    expect(lane?.querySelectorAll("[data-artifact-board-card]")).toHaveLength(
      2
    );
    expect(within(lane as HTMLElement).getByText("2")).toBeInTheDocument();
  });

  it("moves selected same-root and cross-root Issues with distinct valid raw targets in one request", async () => {
    mocks.sharedStatusEnabled = true;
    const data = boardData(IssueStatus.Backlog);
    const backlog = data.lanes[0]!.cards[0]!;
    const progress = {
      ...backlog,
      artifact: {
        ...backlog.artifact,
        id: "00000000-0000-4000-8000-000000000004",
        name: "Progress issue",
        slug: "ISS-725",
        status: IssueStatus.InProgress,
      },
    };
    data.lanes.push({
      cards: [progress],
      complete: true,
      count: 1,
      id: IssueStatus.InProgress,
      label: "In progress",
    });
    data.rootIds = [backlog.artifact.id, progress.artifact.id];
    mocks.boardQuery.data = data;
    mocks.boardQuery.isSuccess = true;
    const user = userEvent.setup();
    renderSurface();
    fireEvent.click(
      document.querySelector(`[data-artifact-board-card="${ARTIFACT_ID}"]`)!
    );
    fireEvent.click(
      document.querySelector(
        `[data-artifact-board-card="${progress.artifact.id}"]`
      )!,
      { ctrlKey: true }
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Progress issue" })
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: `Move to ${ARTIFACT_STATUS_DISPLAY_LABELS[ARTIFACT_STATUS_ROOT.Todo]}`,
      })
    );

    await vi.waitFor(() =>
      expect(mocks.move.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceArtifactIds: data.rootIds,
          lanePatch: expect.objectContaining({
            valuesByRootId: {
              [backlog.artifact.id]: IssueStatus.Backlog,
              [progress.artifact.id]: IssueStatus.Todo,
            },
          }),
        })
      )
    );
  });

  it("writes a raw Issue status from a root lane and leaves only toast-owned Undo", async () => {
    mocks.sharedStatusEnabled = true;
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    mocks.move.data = { undoAvailable: true };
    const user = userEvent.setup();
    renderSurface();

    expect(
      screen.queryByRole("button", { name: ARTIFACT_PLACEMENT_UNDO_LABEL })
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Actions for Ship Artifact Board" })
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: `Move to ${ARTIFACT_STATUS_DISPLAY_LABELS[ARTIFACT_STATUS_ROOT.InReview]}`,
      })
    );
    await vi.waitFor(() =>
      expect(mocks.move.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          lanePatch: expect.objectContaining({ value: IssueStatus.InReview }),
        })
      )
    );
    expect(mocks.move.undo).not.toHaveBeenCalled();
  });

  it("writes the unambiguous raw Document In Review target", async () => {
    mocks.sharedStatusEnabled = true;
    mocks.boardQuery.data = boardData(
      DocumentStatus.Draft,
      ArtifactSubtype.Prd
    );
    mocks.boardQuery.isSuccess = true;
    const user = userEvent.setup();
    renderSurface();

    await user.click(
      screen.getByRole("button", { name: "Actions for Ship Artifact Board" })
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: `Move to ${ARTIFACT_STATUS_DISPLAY_LABELS[ARTIFACT_STATUS_ROOT.InReview]}`,
      })
    );
    await vi.waitFor(() =>
      expect(mocks.move.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          lanePatch: expect.objectContaining({
            value: DocumentStatus.InReview,
          }),
        })
      )
    );
  });

  it.each([
    [
      "a Deployment under priority lanes",
      ArtifactType.Deployment,
      GroupByMode.Priority,
      ProjectArtifactBoardGroup.Priority,
      Priority.High,
    ],
    [
      "a Branch under owner lanes",
      ArtifactType.Branch,
      GroupByMode.Assignee,
      ProjectArtifactBoardGroup.Assignee,
      PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
    ],
  ])(
    "ISS-12929 disables dragging %s, a kind that does not own the lane field",
    (_label, type, groupBy, laneField, laneId) => {
      mocks.boardQuery.data = mixedKindBoard(type, laneId);
      mocks.boardQuery.isSuccess = true;
      renderSurface({
        boardView: {
          ...boardView,
          arrangement: { ...boardView.arrangement, laneField },
        },
        groupBy,
      });

      expect(dragDisabled(ARTIFACT_ID)).toBeNull();
      expect(dragDisabled(OTHER_KIND_ID)).not.toBeNull();
    }
  );

  it("ISS-12929 refuses a priority lane move for a mixed selection holding a Deployment", async () => {
    const data = mixedKindBoard(ArtifactType.Deployment, Priority.High);
    data.lanes.push({
      cards: [],
      complete: true,
      count: 0,
      id: Priority.Low,
      label: "Low",
    });
    mocks.boardQuery.data = data;
    mocks.boardQuery.isSuccess = true;
    const user = userEvent.setup();
    renderSurface({
      boardView: {
        ...boardView,
        arrangement: {
          ...boardView.arrangement,
          laneField: ProjectArtifactBoardGroup.Priority,
        },
      },
      groupBy: GroupByMode.Priority,
    });
    fireEvent.click(
      document.querySelector(`[data-artifact-board-card="${ARTIFACT_ID}"]`)!
    );
    fireEvent.click(
      document.querySelector(`[data-artifact-board-card="${OTHER_KIND_ID}"]`)!,
      { ctrlKey: true }
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Ship Artifact Board" })
    );
    const moveToLow = await screen.findByRole("menuitem", {
      name: MOVE_TO_LOW_PATTERN,
    });
    expect(moveToLow).toHaveAttribute("aria-disabled", "true");
    await user.click(moveToLow);

    expect(mocks.move.mutate).not.toHaveBeenCalled();
  });

  it("keeps loading distinct from a settled empty board", () => {
    mocks.boardQuery.isLoading = true;

    renderSurface();

    expect(
      screen.getByText("Loading...").closest('[role="status"]')
    ).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces the board read failure instead of rendering plausible data", () => {
    mocks.boardQuery.error = new Error("Board read unavailable");

    renderSurface();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Board read unavailable"
    );
    expect(
      screen.queryByRole("group", { name: ARTIFACT_SLUG_PATTERN })
    ).toBeNull();
  });

  it("ISS-12929 724-F5 sends the table filters to the board route instead of loading every page", () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.hasNextPage = true;
    mocks.boardQuery.isSuccess = true;
    const assigneeId = "00000000-0000-4000-8000-000000000004";

    renderSurface({
      filterText: "  apollo ",
      filters: {
        assigneeIds: [assigneeId],
        assignToMe: false,
        date: null,
        favoritesOnly: false,
        hideCompletedItems: true,
        priorities: [Priority.High],
        statuses: [IssueStatus.Todo],
        tagIds: [],
      },
    });

    expect(mocks.boardPageArgs.at(-1)?.[2]).toEqual({
      sort: undefined,
      filters: {
        assigneeIds: [assigneeId],
        hideCompletedItems: true,
        priorities: [Priority.High],
        search: "apollo",
        statuses: [IssueStatus.Todo],
      },
    });
    expect(mocks.boardQuery.fetchNextPage).not.toHaveBeenCalled();
    // The server already filtered: the card it returned is the card shown.
    expect(
      screen.getByRole("button", { name: "Ship Artifact Board" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("ISS-12929 724-F5 sends the page sort and turns off in-lane reordering under it", async () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    const user = userEvent.setup();
    const sort = {
      by: ProjectArtifactBoardSort.Title,
      direction: ProjectArtifactBoardSortDirection.Desc,
    };

    const { unmount } = renderSurface({ sort });
    expect(mocks.boardPageArgs.at(-1)?.[2]).toEqual(
      expect.objectContaining({ sort })
    );
    await user.click(
      screen.getByRole("button", { name: "Actions for Ship Artifact Board" })
    );
    expect(
      await screen.findByRole("menuitem", { name: MOVE_TO_IN_PROGRESS_PATTERN })
    ).toHaveAttribute("aria-disabled", "true");
    unmount();

    renderSurface();
    await user.click(
      screen.getByRole("button", { name: "Actions for Ship Artifact Board" })
    );
    expect(
      await screen.findByRole("menuitem", { name: MOVE_TO_IN_PROGRESS_PATTERN })
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("ISS-12929 sends the portable list's resolved filters in place of the table's", () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    const listFilters = { mineOnly: true, slugOrTitle: "apollo" };

    renderSurface({ filterText: "ignored", listFilters });

    expect(mocks.boardPageArgs.at(-1)?.[2]).toEqual(
      expect.objectContaining({ filters: listFilters })
    );
  });

  it("ISS-12929 724-F5 sends no filters when nothing narrows the board", () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;

    renderSurface();

    expect(mocks.boardPageArgs.at(-1)?.[2]).toEqual({
      filters: undefined,
      sort: undefined,
    });
  });

  it("CT-19 routes the title and keeps unused card surface for selection", async () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    const user = userEvent.setup();

    renderSurface();

    await user.click(
      screen.getByRole("button", { name: "Ship Artifact Board" })
    );
    expect(mocks.navigate).toHaveBeenCalledWith("/acme/documents/ISS-724");
    await user.click(
      document.querySelector(
        `[data-artifact-board-card="${ARTIFACT_ID}"]`
      ) as HTMLElement
    );
    expect(screen.getByLabelText("1 artifact selected")).toBeInTheDocument();
  });

  it("ISS-12929 724-F9 labels a Deployment card as a Deployment and opens its external URL", async () => {
    const data = boardData();
    const card = data.lanes[0]?.cards[0];
    if (!card) {
      throw new Error("fixture has no card");
    }
    card.artifact = {
      ...card.artifact,
      externalUrl: "https://deploy.example.com/apollo",
      slug: null,
      subtype: null,
      type: ArtifactType.Deployment,
    };
    mocks.boardQuery.data = data;
    mocks.boardQuery.isSuccess = true;
    const open = vi.spyOn(globalThis.window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    try {
      renderSurface({
        boardView: {
          ...boardView,
          arrangement: {
            ...boardView.arrangement,
            cardFieldIds: ["type", ProjectArtifactBoardField.CurrentVersion],
          },
        },
      });

      // A deployment has no version, so the card omits the field.
      expect(
        document.querySelector(
          `[data-artifact-board-card="${ARTIFACT_ID}"] [data-artifact-board-field="${ProjectArtifactBoardField.CurrentVersion}"]`
        )
      ).toBeNull();

      expect(
        screen.getByRole("img", { name: GenericArtifactKind.Deployment })
      ).toBeInTheDocument();
      expect(screen.queryByRole("img", { name: "Pull Request" })).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "Ship Artifact Board" })
      );
      expect(open).toHaveBeenCalledWith(
        "https://deploy.example.com/apollo",
        "_blank",
        "noopener,noreferrer"
      );
      expect(mocks.navigate).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it("ISS-12929 724-F4 renders Comments, Related Sessions and Current version from the list's reads", () => {
    const data = boardData();
    const card = data.lanes[0]?.cards[0];
    if (!card) {
      throw new Error("fixture has no card");
    }
    card.artifact = { ...card.artifact, currentVersion: 7 };
    mocks.boardQuery.data = data;
    mocks.boardQuery.isSuccess = true;
    mocks.metadata.commentCount = 2;
    mocks.metadata.relatedTotal = 3;

    renderSurface({
      boardView: {
        ...boardView,
        arrangement: {
          ...boardView.arrangement,
          cardFieldIds: [
            ProjectArtifactBoardField.Comments,
            ProjectArtifactBoardField.RelatedSessions,
            ProjectArtifactBoardField.CurrentVersion,
          ],
        },
      },
    });

    const cardElement = document.querySelector(
      `[data-artifact-board-card="${ARTIFACT_ID}"]`
    ) as HTMLElement;
    expect(within(cardElement).getByText("2 comments")).toBeInTheDocument();
    expect(
      within(cardElement).getByText("3 related sessions")
    ).toBeInTheDocument();
    expect(within(cardElement).getByText("7")).toBeInTheDocument();
    expect(mocks.metadata.calls.at(-1)).toEqual(
      expect.objectContaining({
        artifacts: [expect.objectContaining({ id: ARTIFACT_ID })],
        includePeople: true,
        includeRelatedSessions: true,
      })
    );
  });

  it("ISS-12929 724-F4 skips the collaborator and related-session reads when no card shows them", () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;

    renderSurface();

    expect(mocks.metadata.calls.at(-1)).toEqual(
      expect.objectContaining({
        includePeople: false,
        includeRelatedSessions: false,
      })
    );
  });

  it("CT-19 carries the grouped status into Project-scoped issue creation", async () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    const onAddIssue = vi.fn();
    const user = userEvent.setup();

    renderSurface({ onAddIssue });
    await user.click(
      within(screen.getByRole("group", { name: "In Progress" })).getByRole(
        "button",
        { name: "Add issue" }
      )
    );

    expect(onAddIssue).toHaveBeenCalledWith(IssueStatus.InProgress);
  });

  it("CT-19 wires positive title, status, priority, and assignee mutations", async () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    const editHandlers = {
      onUpdateAssignee: vi.fn(),
      onUpdatePriority: vi.fn(),
      onUpdateStatus: vi.fn(),
      onUpdateTitle: vi.fn().mockResolvedValue(undefined),
      teamMembers: [
        {
          email: "ada@example.com",
          id: "00000000-0000-4000-8000-000000000004",
          name: "Ada Lovelace",
        },
      ],
    } satisfies RowEditHandlers;
    const user = userEvent.setup();
    renderSurface({
      boardView: {
        ...boardView,
        arrangement: {
          ...boardView.arrangement,
          cardFieldIds: ["status", "priority", "owner"],
          laneField: ProjectArtifactBoardGroup.None,
        },
      },
      editHandlers,
      groupBy: GroupByMode.None,
    });

    await user.click(screen.getByRole("button", { name: "Edit title" }));
    const title = screen.getByRole("textbox", { name: "Edit title" });
    fireEvent.change(title, {
      target: { value: "Ship mastered Artifact Board" },
    });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(editHandlers.onUpdateTitle).toHaveBeenCalledWith(
      ARTIFACT_ID,
      "Ship mastered Artifact Board",
      "Ship Artifact Board"
    );

    await user.click(screen.getByRole("button", { name: "In Progress" }));
    await user.click(await screen.findByRole("menuitem", { name: "Done" }));
    expect(editHandlers.onUpdateStatus).toHaveBeenCalledWith(
      ARTIFACT_ID,
      IssueStatus.Done,
      ArtifactStatusEditSurface.Board
    );

    await user.click(screen.getByRole("button", { name: "Priority: High" }));
    await user.click(await screen.findByRole("menuitem", { name: "Low" }));
    expect(editHandlers.onUpdatePriority).toHaveBeenCalledWith(
      ARTIFACT_ID,
      Priority.Low
    );

    await user.click(screen.getByRole("button", { name: UNASSIGNED_PATTERN }));
    await user.click(
      await screen.findByText("Ada Lovelace", { selector: "span" })
    );
    expect(editHandlers.onUpdateAssignee).toHaveBeenCalledWith(
      ARTIFACT_ID,
      "00000000-0000-4000-8000-000000000004"
    );
  });

  it("CT-19 moves selected roots through canonical placement and clears selection", async () => {
    mocks.boardQuery.data = boardData();
    mocks.boardQuery.isSuccess = true;
    mocks.projects = [
      { id: PROJECT_ID, name: "Apollo" },
      { id: "00000000-0000-4000-8000-000000000005", name: "Beta" },
    ];
    mocks.move.mutate.mockImplementation(
      (_request: unknown, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      }
    );
    mocks.apiGet.mockResolvedValue({ projectVersion: "destination-version" });
    const user = userEvent.setup();
    renderSurface();

    await user.click(
      document.querySelector(
        `[data-artifact-board-card="${ARTIFACT_ID}"]`
      ) as HTMLElement
    );
    await user.click(screen.getByRole("button", { name: "Move to project" }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));

    expect(mocks.move.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationProjectId: "00000000-0000-4000-8000-000000000005",
        expectedProjectVersions: {
          [PROJECT_ID]: "board-version",
          "00000000-0000-4000-8000-000000000005": "destination-version",
        },
        sourceArtifactIds: [ARTIFACT_ID],
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    expect(screen.queryByText("1 artifact selected")).toBeNull();
  });
});

/** A Document card beside a card of another kind in one lane. */
function mixedKindBoard(
  type: ArtifactType,
  laneId: string
): ProjectArtifactBoardPageResponse {
  const data = boardData();
  const lane = data.lanes[0]!;
  const documentCard = lane.cards[0]!;
  lane.id = laneId;
  lane.cards.push({
    ...documentCard,
    artifact: {
      ...documentCard.artifact,
      id: OTHER_KIND_ID,
      name: "Other kind",
      slug: "OTH-1",
      subtype: null,
      type,
    },
  });
  lane.count = 2;
  data.rootIds = [ARTIFACT_ID, OTHER_KIND_ID];
  return data;
}

function dragDisabled(id: string) {
  return (
    document
      .querySelector(`[data-artifact-board-card="${id}"]`)
      ?.closest('[data-artifact-board-drag-disabled="true"]') ?? null
  );
}
