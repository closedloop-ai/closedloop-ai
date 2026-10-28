"use client";

import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
  type ProjectArtifactBoardView,
} from "@repo/api/src/types/project-artifact-board-view";
import {
  GridviewRolloutDecisionOutcome,
  GridviewRolloutDecisionReason,
  SharedAnalyticsComponent,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import {
  documentsGroupingState,
  readDocumentsGroupLink,
} from "@repo/app/documents/lib/documents-group-link";
import {
  GroupByMode,
  type GroupByMode as GroupByModeValue,
} from "@repo/app/documents/lib/group-by";
import { projectBoardVisibleFields } from "@repo/app/projects/components/project-artifact-board-model";
import { useProjectArtifactBoardViewState } from "@repo/app/projects/hooks/use-project-artifact-board-view-state";
import { useFeatureFlagGateOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import type { DocumentColumn as DocumentColumnValue } from "@repo/app/shared/hooks/use-column-visibility";
import {
  type TableCollapsedGroups,
  tableGroupingAxisKey,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { useCallback, useEffect, useMemo, useRef } from "react";

type ProjectArtifactLayoutInput = {
  activeTab: string;
  baseCollapsedGroups: TableCollapsedGroups;
  baseGroupBy: GroupByModeValue;
  onBaseCollapsedGroupsChange: (next: TableCollapsedGroups) => void;
  onBaseGroupByChange: (next: GroupByModeValue) => void;
  onToggleColumn: (column: DocumentColumnValue) => void;
  projectId: string;
  requestedLayout: string | null;
  search: string;
  storageKey: string | null;
  visibleColumns: readonly DocumentColumnValue[];
};

/** Resolve durable board state while keeping same-route URL axes authoritative. */
export function useProjectArtifactLayout(input: ProjectArtifactLayoutInput) {
  const rollout = useFeatureFlagGateOptional(MANUAL_ARTIFACT_ORDERING_FLAG_KEY);
  const { capture } = useSurfaceAnalytics();
  const emittedRolloutOutcome = useRef<GridviewRolloutDecisionOutcome | null>(
    null
  );
  useEffect(() => {
    if (!rollout.isReady) {
      return;
    }
    let outcome: GridviewRolloutDecisionOutcome;
    let reason: GridviewRolloutDecisionReason;
    if (!rollout.isResolved) {
      outcome = GridviewRolloutDecisionOutcome.Unresolved;
      reason = GridviewRolloutDecisionReason.AssignmentUnresolved;
    } else if (rollout.enabled) {
      outcome = GridviewRolloutDecisionOutcome.Enabled;
      reason = GridviewRolloutDecisionReason.FlagEnabled;
    } else {
      outcome = GridviewRolloutDecisionOutcome.Disabled;
      reason = GridviewRolloutDecisionReason.FlagDisabled;
    }
    if (emittedRolloutOutcome.current === outcome) {
      return;
    }
    emittedRolloutOutcome.current = outcome;
    capture(SurfaceAnalyticsEvent.GridviewRolloutDecision, {
      component: SharedAnalyticsComponent.ProjectArtifactBoard,
      outcome,
      reason,
    });
  }, [capture, rollout.enabled, rollout.isReady, rollout.isResolved]);
  const linked = useMemo(
    () => readDocumentsGroupLink(new URLSearchParams(input.search)),
    [input.search]
  );
  const defaultCollapsedLaneIds = collapsedLaneIdsForGroup(
    input.baseCollapsedGroups,
    input.baseGroupBy
  );
  const defaults = useMemo<ProjectArtifactBoardView>(
    () => ({
      arrangement: {
        cardFieldIds: projectBoardVisibleFields(input.visibleColumns),
        collapsedLaneIds: defaultCollapsedLaneIds,
        laneField: boardGroupFromDocumentsGroup(input.baseGroupBy),
        laneOrder: [],
        layout: ProjectArtifactBoardLayout.List,
        manualOrder: true,
      },
      version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
    }),
    [defaultCollapsedLaneIds, input.baseGroupBy, input.visibleColumns]
  );
  const url = useMemo(() => {
    const layout = projectArtifactLayoutFromUrl(input.requestedLayout);
    if (!linked) {
      return layout ? { layout } : undefined;
    }
    const axisKey = tableGroupingAxisKey(linked.grouping);
    return {
      collapsedLaneIds:
        axisKey === null ? [] : (linked.collapsedGroups[axisKey] ?? []),
      laneField: boardGroupFromDocumentsGroup(linked.groupBy),
      ...(layout ? { layout } : {}),
    };
  }, [input.requestedLayout, linked]);
  const controller = useProjectArtifactBoardViewState({
    defaults,
    projectId: input.projectId,
    storageKey: input.storageKey,
    url,
  });
  const groupBy = documentsGroupFromBoardGroup(
    controller.view.arrangement.laneField
  );
  const collapsedGroups = useMemo(
    () =>
      collapsedGroupsForArrangement(
        input.baseCollapsedGroups,
        groupBy,
        controller.view.arrangement.collapsedLaneIds
      ),
    [
      controller.view.arrangement.collapsedLaneIds,
      groupBy,
      input.baseCollapsedGroups,
    ]
  );
  const layout =
    rollout.enabled && rollout.isReady && input.activeTab === "all"
      ? controller.view.arrangement.layout
      : ProjectArtifactBoardLayout.List;

  const persistLayout = useCallback(
    (next: ProjectArtifactBoardLayout) => {
      controller.setArrangement((current) => ({
        ...current,
        layout: next,
      }));
    },
    [controller.setArrangement]
  );
  const persistGroupBy = useCallback(
    (next: GroupByModeValue) => {
      controller.setArrangement((current) => ({
        ...current,
        laneField: boardGroupFromDocumentsGroup(next),
      }));
      input.onBaseGroupByChange(next);
    },
    [controller.setArrangement, input.onBaseGroupByChange]
  );
  const persistCollapsedGroups = useCallback(
    (next: TableCollapsedGroups) => {
      controller.setArrangement((current) => ({
        ...current,
        collapsedLaneIds: collapsedLaneIdsForGroup(next, groupBy),
      }));
      input.onBaseCollapsedGroupsChange(next);
    },
    [controller.setArrangement, groupBy, input.onBaseCollapsedGroupsChange]
  );
  const toggleColumn = useCallback(
    (column: DocumentColumnValue) => {
      const nextColumns = input.visibleColumns.includes(column)
        ? input.visibleColumns.filter((candidate) => candidate !== column)
        : [...input.visibleColumns, column];
      controller.setArrangement((current) => ({
        ...current,
        cardFieldIds: projectBoardVisibleFields(nextColumns),
      }));
      input.onToggleColumn(column);
    },
    [controller.setArrangement, input.onToggleColumn, input.visibleColumns]
  );

  return {
    collapsedGroups,
    groupBy,
    layout,
    persistCollapsedGroups,
    persistGroupBy,
    persistLayout,
    toggleColumn,
    view: controller.view,
  };
}

function projectArtifactLayoutFromUrl(
  value: string | null
): ProjectArtifactBoardLayout | null {
  if (value === ProjectArtifactBoardLayout.Board) {
    return ProjectArtifactBoardLayout.Board;
  }
  if (value === ProjectArtifactBoardLayout.List) {
    return ProjectArtifactBoardLayout.List;
  }
  return null;
}

function boardGroupFromDocumentsGroup(
  groupBy: GroupByModeValue
): ProjectArtifactBoardGroup {
  switch (groupBy) {
    case GroupByMode.Assignee:
      return ProjectArtifactBoardGroup.Assignee;
    case GroupByMode.None:
      return ProjectArtifactBoardGroup.None;
    case GroupByMode.Priority:
      return ProjectArtifactBoardGroup.Priority;
    case GroupByMode.Status:
      return ProjectArtifactBoardGroup.Status;
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

function documentsGroupFromBoardGroup(
  groupBy: ProjectArtifactBoardGroup
): GroupByModeValue {
  switch (groupBy) {
    case ProjectArtifactBoardGroup.Assignee:
      return GroupByMode.Assignee;
    case ProjectArtifactBoardGroup.None:
      return GroupByMode.None;
    case ProjectArtifactBoardGroup.Priority:
      return GroupByMode.Priority;
    case ProjectArtifactBoardGroup.Status:
      return GroupByMode.Status;
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

function collapsedLaneIdsForGroup(
  collapsedGroups: TableCollapsedGroups,
  groupBy: GroupByModeValue
): string[] {
  const axisKey = tableGroupingAxisKey(documentsGroupingState(groupBy));
  return axisKey === null ? [] : [...(collapsedGroups[axisKey] ?? [])];
}

function collapsedGroupsForArrangement(
  base: TableCollapsedGroups,
  groupBy: GroupByModeValue,
  collapsedLaneIds: readonly string[]
): TableCollapsedGroups {
  const axisKey = tableGroupingAxisKey(documentsGroupingState(groupBy));
  if (axisKey === null) {
    return base;
  }
  const entries = Object.entries(base).filter(([axis]) => axis !== axisKey);
  return Object.fromEntries(
    collapsedLaneIds.length === 0
      ? entries
      : [...entries, [axisKey, [...collapsedLaneIds]]]
  );
}
