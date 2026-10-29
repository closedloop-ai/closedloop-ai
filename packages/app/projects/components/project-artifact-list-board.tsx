"use client";

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
  type ProjectArtifactBoardView,
} from "@repo/api/src/types/project-artifact-board-view";
import { useMemo } from "react";
import type { RowEditHandlers } from "../../documents/components/table/row-edit-context";
import { GroupByMode } from "../../documents/lib/group-by";
import {
  type ProjectBoardListToolbar,
  useProjectBoardListFilters,
} from "../lib/project-artifact-board-list-filters";
import { projectBoardFieldsFromListColumns } from "./project-artifact-board-model";
import { ProjectArtifactBoardSurface } from "./project-artifact-board-surface";

/**
 * Board layout of the portable project page. Its caller mounts it only when
 * manual artifact ordering is enabled, preserving the flag-off F2 list.
 */
export function ProjectArtifactListBoard({
  editHandlers,
  project,
  teamId,
  toolbar,
  visibleColumnIds,
}: Readonly<{
  editHandlers: RowEditHandlers;
  project: ProjectWithDetails;
  teamId: string;
  /** The project list's filters and search; the board route applies them. */
  toolbar: ProjectBoardListToolbar;
  /** The project list's Options columns; card fields follow them (724-F4). */
  visibleColumnIds: ReadonlySet<string>;
}>) {
  const listFilters = useProjectBoardListFilters(toolbar);
  const boardView = useMemo(
    () => projectArtifactListBoardView(visibleColumnIds),
    [visibleColumnIds]
  );
  return (
    <ProjectArtifactBoardSurface
      boardView={boardView}
      editHandlers={editHandlers}
      filterText=""
      groupBy={GroupByMode.Status}
      listFilters={listFilters}
      project={project}
      projectId={project.id}
      teamId={teamId}
    />
  );
}

function projectArtifactListBoardView(
  visibleColumnIds: ReadonlySet<string>
): ProjectArtifactBoardView {
  return {
    arrangement: {
      cardFieldIds: projectBoardFieldsFromListColumns(visibleColumnIds),
      collapsedLaneIds: [],
      laneField: ProjectArtifactBoardGroup.Status,
      laneOrder: [],
      layout: ProjectArtifactBoardLayout.Board,
      manualOrder: true,
    },
    version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  };
}
