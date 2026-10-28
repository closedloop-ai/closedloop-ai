import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
  type ProjectArtifactBoardView,
} from "@repo/api/src/types/project-artifact-board-view";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  Surface,
  type SurfaceAnalyticsCapture,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { PROJECT_SAVED_VIEWS_KEY_PREFIX } from "@repo/app/projects/lib/project-saved-views";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { TABLE_COLLAPSED_GROUP_PARAM } from "@repo/app/shared/lib/table-collapsed-groups";
import { TABLE_GROUP_PARAM } from "@repo/app/shared/lib/table-group-view-params";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectArtifactLayout } from "../use-project-artifact-layout";

const mocks = vi.hoisted(() => ({
  capture: vi.fn<SurfaceAnalyticsCapture>(),
  flagGate: { enabled: true, isReady: true, isResolved: true },
  publish: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagGateOptional: (key: string) =>
    key === MANUAL_ARTIFACT_ORDERING_FLAG_KEY
      ? mocks.flagGate
      : { enabled: false, isReady: true, isResolved: true },
}));

vi.mock("@repo/app/shared/hooks/use-grid-preference-remote", () => ({
  useGridPreferenceRemote: () => ({
    inbound: null,
    publish: mocks.publish,
  }),
}));

const STORAGE_KEY = "project-board:project-one";
const PERSISTED_VIEW: ProjectArtifactBoardView = {
  arrangement: {
    cardFieldIds: ["priority", "owner"],
    collapsedLaneIds: ["high"],
    laneField: ProjectArtifactBoardGroup.Priority,
    laneOrder: ["high", "medium", "low"],
    layout: ProjectArtifactBoardLayout.Board,
    manualOrder: true,
  },
  version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
};

type HookProps = {
  requestedLayout: string | null;
  search: string;
};

function renderLayout(initialProps: HookProps) {
  const onBaseCollapsedGroupsChange = vi.fn();
  const onBaseGroupByChange = vi.fn();
  const onToggleColumn = vi.fn();
  const rendered = renderHook(
    (props: HookProps) =>
      useProjectArtifactLayout({
        activeTab: "all",
        baseCollapsedGroups: {},
        baseGroupBy: GroupByMode.Status,
        onBaseCollapsedGroupsChange,
        onBaseGroupByChange,
        onToggleColumn,
        projectId: "project-one",
        requestedLayout: props.requestedLayout,
        search: props.search,
        storageKey: STORAGE_KEY,
        visibleColumns: [DocumentColumn.Priority, DocumentColumn.Assignee],
      }),
    {
      initialProps,
      wrapper: ({ children }: { children: ReactNode }) => (
        <SurfaceAnalyticsProvider capture={mocks.capture} surface={Surface.Web}>
          {children}
        </SurfaceAnalyticsProvider>
      ),
    }
  );
  return {
    ...rendered,
    onBaseCollapsedGroupsChange,
    onBaseGroupByChange,
    onToggleColumn,
  };
}

describe("CT-09/CT-17 AC-004/AC-009 Project detail board host", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(PERSISTED_VIEW));
    mocks.flagGate = { enabled: true, isReady: true, isResolved: true };
    mocks.capture.mockReset();
    mocks.publish.mockReset();
  });

  it("restores a same-route share link and Back returns to the persisted view", () => {
    const linkedSearch = new URLSearchParams({
      layout: ProjectArtifactBoardLayout.List,
      [TABLE_COLLAPSED_GROUP_PARAM]: "done",
      [TABLE_GROUP_PARAM]: `${GroupByMode.Status}:custom`,
    }).toString();
    const { rerender, result } = renderLayout({
      requestedLayout: ProjectArtifactBoardLayout.List,
      search: linkedSearch,
    });

    expect(result.current.layout).toBe(ProjectArtifactBoardLayout.List);
    expect(result.current.groupBy).toBe(GroupByMode.Status);
    expect(result.current.view.arrangement.collapsedLaneIds).toEqual(["done"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual(
      PERSISTED_VIEW
    );

    rerender({ requestedLayout: null, search: "" });
    expect(result.current.layout).toBe(ProjectArtifactBoardLayout.Board);
    expect(result.current.groupBy).toBe(GroupByMode.Priority);
    expect(result.current.view.arrangement.collapsedLaneIds).toEqual(["high"]);
  });

  it("writes group, collapse, and card-field gestures through both owners", () => {
    const {
      onBaseCollapsedGroupsChange,
      onBaseGroupByChange,
      onToggleColumn,
      result,
    } = renderLayout({ requestedLayout: null, search: "" });

    act(() => {
      result.current.persistGroupBy(GroupByMode.Assignee);
    });
    expect(onBaseGroupByChange).toHaveBeenCalledWith(GroupByMode.Assignee);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject(
      {
        arrangement: { laneField: ProjectArtifactBoardGroup.Assignee },
      }
    );

    act(() => {
      result.current.persistCollapsedGroups({ "assignee|": ["user-one"] });
      result.current.toggleColumn(DocumentColumn.Assignee);
    });
    expect(onBaseCollapsedGroupsChange).toHaveBeenCalledWith({
      "assignee|": ["user-one"],
    });
    expect(onToggleColumn).toHaveBeenCalledWith(DocumentColumn.Assignee);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject(
      {
        arrangement: {
          cardFieldIds: ["status", "priority"],
          collapsedLaneIds: ["user-one"],
        },
      }
    );
    expect(mocks.publish).toHaveBeenCalled();
  });

  it("rolls back to list when manual-artifact-ordering is closed", () => {
    mocks.flagGate = { enabled: false, isReady: true, isResolved: true };

    const { result } = renderLayout({ requestedLayout: null, search: "" });

    expect(result.current.layout).toBe(ProjectArtifactBoardLayout.List);
    expect(result.current.view.arrangement.layout).toBe(
      ProjectArtifactBoardLayout.Board
    );
    expect(mocks.capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.GridviewRolloutDecision,
      expect.objectContaining({
        component: SharedAnalyticsComponent.ProjectArtifactBoard,
        outcome: GridviewRolloutDecisionOutcome.Disabled,
      })
    );
    expect(
      mocks.capture.mock.calls.some(
        ([event]) =>
          event === SurfaceAnalyticsEvent.ProjectArtifactBoardObserved
      )
    ).toBe(false);
  });

  it("emits no rollout decision while the assignment remains unresolved", () => {
    mocks.flagGate = { enabled: false, isReady: false, isResolved: false };

    const { result } = renderLayout({ requestedLayout: null, search: "" });

    expect(result.current.layout).toBe(ProjectArtifactBoardLayout.List);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps Project-list named views out of Project Detail, which has no named-view producer", () => {
    localStorage.setItem(
      `${PROJECT_SAVED_VIEWS_KEY_PREFIX}${STORAGE_KEY}`,
      JSON.stringify({
        activeViewId: "list-view",
        views: [
          {
            arrangement: {
              layout: ProjectArtifactBoardLayout.List,
            },
            id: "list-view",
            name: "List view",
          },
        ],
      })
    );

    const { result } = renderLayout({ requestedLayout: null, search: "" });

    expect(result.current.layout).toBe(ProjectArtifactBoardLayout.Board);
    expect(result.current.groupBy).toBe(GroupByMode.Priority);
  });
});
