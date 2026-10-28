"use client";

import { PROJECT_TREE_MAX_VISIBLE_LEVELS } from "@repo/api/src/types/project-tree";
import { ProductGridTableV2 } from "@repo/app/shared/components/product-grid-table-v2";
import { Button } from "@repo/design-system/components/ui/button";
import {
  GRID_TABLE_V2_FAVORITE_TRACK,
  type GridTableV2Column,
} from "@repo/design-system/components/ui/grid-table-v2";
import { getTableCellPrimitiveStateValue } from "@repo/design-system/components/ui/table-cell-primitives";
import { TableCellValueState } from "@repo/design-system/components/ui/table-cell-value-state";
import { TableInlineCreateRow } from "@repo/design-system/components/ui/table-inline-create-row";
import { useMemo, useRef } from "react";
import {
  artifactParentIds,
  buildArtifactHierarchyForest,
  flattenVisibleArtifactHierarchy,
} from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy";
import { ArtifactHierarchyControls } from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy-controls";
import {
  type ArtifactHierarchyView,
  artifactManualMoveTarget,
} from "../../shared/components/generic-artifact-surface/preview/components/artifact-hierarchy-view";
import { artifactListFavorite } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-favorite";
import { TagEditorContext } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { ArtifactListShellController } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import type { GenericArtifact } from "../../shared/components/generic-artifact-surface/preview/fixtures";
import { hierarchyAvailabilityState } from "../../shared/lib/hierarchy-availability-state";
import { PROJECT_ARTIFACT_LIST_RETRY_LABEL } from "../lib/project-artifact-list-copy";
import type { ProjectArtifactReadModel } from "../lib/project-artifact-read-model";
import {
  type ProjectTreeChildLoad,
  ProjectTreeChildLoadState,
} from "./project-tree-expansion-pages";

export type ProjectArtifactTreeHost = {
  hierarchyReadState?: {
    childLoadByParentId: ReadonlyMap<string, ProjectTreeChildLoad>;
    hierarchyByArtifactId: ProjectArtifactReadModel["hierarchyByArtifactId"];
  };
  renderBoardTitle?: (
    artifact: GenericArtifact,
    href: string
  ) => React.ReactNode;
  /** A tree row's title, which also shows the artifact ID the board card omits. */
  renderTreeTitle?: (
    artifact: GenericArtifact,
    href: string
  ) => React.ReactNode;
  renderCell?: (columnId: string, artifact: GenericArtifact) => React.ReactNode;
  renderLeadingUtility?: (artifact: GenericArtifact) => React.ReactNode;
  onHierarchyDrop?: (
    artifact: GenericArtifact,
    target: GenericArtifact,
    placement: "before" | "inside" | "after"
  ) => void;
  canHierarchyDrop?: (
    artifact: GenericArtifact,
    target: GenericArtifact,
    placement: "before" | "inside" | "after"
  ) => boolean;
};

export type ProjectArtifactTreeController = Pick<
  ArtifactListShellController,
  | "artifactColumnWidth"
  | "handleArtifactRowClick"
  | "handleArtifactRowKeyboardNavigate"
  | "handleArtifactRowRangeDrag"
  | "hierarchyView"
  | "inlineCreate"
  | "inlineDraftContext"
  | "manualOrderingActive"
  | "moveArtifactManually"
  | "onOpenArtifactHref"
  | "reconcileSelection"
  | "selectedArtifactIds"
  | "selectAllVisibleArtifacts"
  | "setInlineDraftContext"
  | "setSelectedArtifactIds"
  | "toggleArtifactSelection"
  | "createInlineArtifact"
  | "favoriteArtifactIds"
  | "favoritesUnavailable"
  | "pendingFavoriteArtifactIds"
  | "setArtifactFavorite"
> & {
  columnLayout: Pick<
    ArtifactListShellController["columnLayout"],
    "gridTemplateColumns"
  >;
  gridColumns: GridTableV2Column[];
  tagEditorContext: React.ContextType<typeof TagEditorContext>;
};

/** The all-kind Project Detail treegrid; the existing placement host remains its only writer. */
export function ProjectArtifactTreeGrid({
  controller,
  host,
}: {
  controller: ProjectArtifactTreeController;
  host: ProjectArtifactTreeHost;
}) {
  const { hierarchyView } = controller;
  const treeRef = useRef<HTMLDivElement>(null);
  const childrenByParentId = useMemo(
    () =>
      visibleChildrenOf(
        flattenVisibleArtifactHierarchy(
          buildArtifactHierarchyForest(hierarchyView.collectionArtifacts),
          artifactParentIds(hierarchyView.collectionArtifacts),
          hierarchyView.maxLevels
        )
      ),
    [hierarchyView.collectionArtifacts, hierarchyView.maxLevels]
  );
  const identityTracks = `${GRID_TABLE_V2_FAVORITE_TRACK} ${controller.artifactColumnWidth}px`;
  const hierarchyIdentityTracks = `${GRID_TABLE_V2_FAVORITE_TRACK} calc(${controller.artifactColumnWidth}px + (var(--icon-lg) + var(--density-cozy)) * ${PROJECT_TREE_MAX_VISIBLE_LEVELS - 1})`;
  // Reserve the deepest lineage indent outside the resizable flat identity width.
  const gridTemplateColumns =
    controller.columnLayout.gridTemplateColumns.replace(
      identityTracks,
      hierarchyIdentityTracks
    );
  const moveInsideFromKeyboard = (artifactId: string) => {
    const target = artifactManualMoveTarget(
      hierarchyView.rows,
      artifactId,
      "in"
    );
    if (!target) {
      return;
    }
    const targetRow = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>("[data-grid-row]") ?? []
    ).find((row) => row.dataset.gridRowId === target.targetId);
    targetRow
      ?.querySelector<HTMLButtonElement>("[data-grid-row-drag-handle]")
      ?.focus();
    controller.moveArtifactManually(artifactId, "in");
  };
  return (
    <TagEditorContext.Provider value={controller.tagEditorContext}>
      <div className="w-full min-w-0 max-w-full overflow-x-auto" ref={treeRef}>
        <ProductGridTableV2
          canDropOnRow={
            controller.manualOrderingActive ? host.canHierarchyDrop : undefined
          }
          collapseRowLabel="Collapse row"
          columns={controller.gridColumns}
          expandRowLabel="Expand row"
          favorite={artifactListFavorite(controller)}
          getChildren={(row) => childrenByParentId.get(row.id)}
          getRowId={(row) => row.id}
          gridTemplateColumns={gridTemplateColumns}
          isRowSelected={(row) => controller.selectedArtifactIds.has(row.id)}
          items={hierarchyView.rootArtifacts}
          leadingLabel="Artifact"
          leadingUtilityLabel="Favorite"
          mode="expanded"
          onRenderedItemsChange={controller.reconcileSelection}
          onRowClick={controller.handleArtifactRowClick}
          onRowDrop={
            controller.manualOrderingActive ? host.onHierarchyDrop : undefined
          }
          onRowKeyboardNavigate={controller.handleArtifactRowKeyboardNavigate}
          onRowRangeDrag={controller.handleArtifactRowRangeDrag}
          onRowSelectionToggle={controller.toggleArtifactSelection}
          // ISS-13007: header select-all is intentionally absent; this preserves Cmd/Ctrl+A.
          onSelectAllRows={controller.selectAllVisibleArtifacts}
          renderAfterItem={
            controller.inlineCreate?.enabled
              ? (row) =>
                  controller.inlineDraftContext?.afterArtifactId === row.id ? (
                    <TableInlineCreateRow
                      active
                      gridTemplateColumns={gridTemplateColumns}
                      label={controller.inlineCreate?.label ?? "Add artifact"}
                      onActivate={() => undefined}
                      onCancel={() => controller.setInlineDraftContext(null)}
                      onCommit={(title) =>
                        controller.createInlineArtifact(
                          title,
                          controller.inlineDraftContext?.groupKey,
                          row.id
                        )
                      }
                    />
                  ) : null
              : undefined
          }
          renderCell={(columnId, row) =>
            host.renderCell?.(columnId, row) ?? null
          }
          renderLead={(row) => {
            const href = controller.onOpenArtifactHref?.(row);
            return (
              <div className="flex min-w-0 items-center gap-1">
                {controller.manualOrderingActive && (
                  <ArtifactHierarchyControls
                    artifact={row}
                    onMoveDown={() =>
                      controller.moveArtifactManually(row.id, "down")
                    }
                    onMoveIn={() => moveInsideFromKeyboard(row.id)}
                    onMoveOut={() =>
                      controller.moveArtifactManually(row.id, "out")
                    }
                    onMoveUp={() =>
                      controller.moveArtifactManually(row.id, "up")
                    }
                  />
                )}
                {href && (host.renderTreeTitle ?? host.renderBoardTitle) ? (
                  (host.renderTreeTitle ?? host.renderBoardTitle)?.(row, href)
                ) : (
                  <span className="min-w-0 truncate">{row.title}</span>
                )}
                {getTableCellPrimitiveStateValue({
                  state:
                    projectHierarchyParentReadState(
                      row.id,
                      host.hierarchyReadState
                    ) ?? undefined,
                })}
                {host.hierarchyReadState?.childLoadByParentId.get(row.id)
                  ?.state === ProjectTreeChildLoadState.Error && (
                  <Button
                    onClick={(event) => {
                      event.stopPropagation();
                      host.hierarchyReadState?.childLoadByParentId
                        .get(row.id)
                        ?.retry();
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {PROJECT_ARTIFACT_LIST_RETRY_LABEL}
                  </Button>
                )}
              </div>
            );
          }}
          renderLeadingUtility={host.renderLeadingUtility}
          rowDragPreviewLabel={
            controller.manualOrderingActive ? (row) => row.title : undefined
          }
          rowExpansion={{
            isExpanded: hierarchyView.isExpanded,
            setExpanded: (rowId, expanded) => {
              if (hierarchyView.isExpanded(rowId) !== expanded) {
                hierarchyView.toggleExpanded(rowId);
              }
            },
          }}
        />
      </div>
    </TagEditorContext.Provider>
  );
}

/** Use the same approved state vocabulary as Documents for each affected parent. */
export function projectHierarchyParentReadState(
  parentId: string,
  readState: ProjectArtifactTreeHost["hierarchyReadState"]
): TableCellValueState | null {
  const childLoad = readState?.childLoadByParentId.get(parentId);
  if (childLoad?.state === ProjectTreeChildLoadState.Error) {
    return TableCellValueState.Error;
  }
  if (childLoad?.state === ProjectTreeChildLoadState.Loading) {
    return TableCellValueState.Loading;
  }
  const wireState = hierarchyAvailabilityState(
    readState?.hierarchyByArtifactId.get(parentId)?.availability
  );
  if (wireState) {
    return wireState;
  }
  return null;
}

function visibleChildrenOf(rows: ArtifactHierarchyView["rows"]) {
  const childrenByParentId = new Map<string, GenericArtifact[]>();
  for (const row of rows) {
    const parentId = row.artifact.parentArtifactId;
    if (row.depth === 0 || !parentId) {
      continue;
    }
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(row.artifact);
    childrenByParentId.set(parentId, children);
  }
  return childrenByParentId;
}
