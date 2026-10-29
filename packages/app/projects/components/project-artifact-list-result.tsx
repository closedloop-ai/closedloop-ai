"use client";

import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { parseProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { Button } from "@repo/design-system/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { cloneElement, isValidElement, type ReactNode } from "react";
import type { RowEditHandlers } from "../../documents/components/table/row-edit-context";
import { useApiClientOptional } from "../../shared/api/use-api-client-optional";
import type { ArtifactListColumnExtension } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { GenericArtifactListView } from "../../shared/components/generic-artifact-surface/preview/components/artifact-shells";
import { useManualArtifactOrderingEnabled } from "../../shared/feature-flags/use-manual-artifact-ordering";
import { projectTreeKeys } from "../hooks/project-tree-keys";
import { PROJECT_ARTIFACT_LIST_RETRY_LABEL } from "../lib/project-artifact-list-copy";
import { ProjectArtifactListBoard } from "./project-artifact-list-board";
import { ProjectListLayout } from "./project-artifact-list-layout";
import { ProjectSelectionActions } from "./project-artifact-selection-actions";
import {
  ProjectArtifactTreeGrid,
  type ProjectArtifactTreeHost,
} from "./project-artifact-tree-grid";
import { ProjectListSelectionActions } from "./project-registered-selection-actions";

/** Render the shared list and bounded root continuation after read settlement. */
export function ProjectArtifactListResult({
  board,
  controller,
  expansionLoader,
  failed,
  hasMoreRootPages,
  host,
  isLoadingMoreRootPages,
  loadMoreRootPages,
  loading,
  onRetry,
}: {
  board: Readonly<{
    /** The list's custom-field columns, whose filters the board applies. */
    customFieldColumns: readonly ArtifactListColumnExtension[];
    editHandlers: RowEditHandlers;
    project: ProjectWithDetails;
    /** The list's text search, which the board applies too. */
    search: string;
    teamId: string;
  }>;
  controller: ArtifactListShellController;
  expansionLoader: ReactNode;
  failed: boolean;
  hasMoreRootPages?: boolean;
  host: ArtifactListHostRendering & ProjectArtifactTreeHost;
  isLoadingMoreRootPages?: boolean;
  loadMoreRootPages?: () => void;
  loading: boolean;
  onRetry: () => void;
}) {
  const manualOrderingEnabled = useManualArtifactOrderingEnabled();
  if (loading || failed) {
    return (
      <div className="p-4" role="status">
        {failed ? (
          <Button onClick={onRetry} variant="outline">
            {PROJECT_ARTIFACT_LIST_RETRY_LABEL}
          </Button>
        ) : (
          "Loading project"
        )}
      </div>
    );
  }
  const showHierarchyTree =
    manualOrderingEnabled &&
    controller.hierarchyView.enabled &&
    controller.layout === "list" &&
    // Grouping is the shell grid's, as on Documents: with Group set the list
    // renders its group headers instead of the flat tree.
    controller.groupBy === "none" &&
    !("resultsState" in host);
  const artifactList = (
    <GenericArtifactListView
      controller={controller}
      host={
        showHierarchyTree
          ? {
              ...host,
              bulkActions: controller.manualOrderingActive ? (
                <HierarchySelectionReadiness actions={host.bulkActions} />
              ) : (
                host.bulkActions
              ),
              resultsState: (
                <ProjectArtifactTreeGrid controller={controller} host={host} />
              ),
            }
          : host
      }
    />
  );
  const list = (
    <>
      {expansionLoader}
      {showHierarchyTree ? (
        <div
          className="flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col overflow-hidden"
          data-testid="project-hierarchy-host"
        >
          {artifactList}
        </div>
      ) : (
        artifactList
      )}
      {hasMoreRootPages && loadMoreRootPages && (
        <div className="flex justify-center px-4 pb-4">
          <Button
            disabled={isLoadingMoreRootPages}
            onClick={loadMoreRootPages}
            variant="outline"
          >
            {isLoadingMoreRootPages ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
  return (
    <ProjectListLayout
      board={
        <ProjectArtifactListBoard
          {...board}
          toolbar={{
            customFieldRangeColumnIds: rangeColumnIds(board.customFieldColumns),
            dateDimension: controller.dateDimension,
            extensionFilters: controller.extensionFilters,
            filters: controller.filters,
            search: board.search,
          }}
          visibleColumnIds={controller.visibleColumnIds}
        />
      }
      controller={controller}
      host={host}
      list={list}
    />
  );
}

function HierarchySelectionReadiness({ actions }: { actions: ReactNode }) {
  const apiClient = useApiClientOptional();
  const queryClient = useQueryClient();
  if (
    !isValidElement<{ onMove: (projectId: string) => Promise<unknown> }>(
      actions
    )
  ) {
    return actions;
  }
  if (
    actions.type !== ProjectSelectionActions &&
    actions.type !== ProjectListSelectionActions
  ) {
    return actions;
  }
  return cloneElement(actions, {
    onMove: async (destinationProjectId) => {
      if (apiClient) {
        await queryClient
          .fetchQuery({
            queryKey: projectTreeKeys.detail(destinationProjectId),
            queryFn: async () =>
              parseProjectTreeResponse(
                await apiClient.get<unknown>(
                  `/projects/${destinationProjectId}/tree`
                )
              ),
          })
          .catch(() => undefined);
      }
      return actions.props.onMove(destinationProjectId);
    },
  });
}

/** Custom-field columns the list filters by range rather than by label. */
function rangeColumnIds(
  columns: readonly ArtifactListColumnExtension[]
): ReadonlySet<string> {
  return new Set(
    columns
      .filter((column) => column.filterRange !== undefined)
      .map((column) => column.id)
  );
}
