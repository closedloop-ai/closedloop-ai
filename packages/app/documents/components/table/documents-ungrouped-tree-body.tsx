"use client";

import { ProjectArtifactPlacementPosition } from "@repo/api/src/types/project-artifact-placement";
import { RANK_DRAG_HANDLE_CLASS } from "@repo/app/documents/components/table/cells/rank-slot";
import {
  DocumentRow,
  type DocumentRowItem,
} from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import {
  RankInteractionMode,
  shouldShowRankSlot,
} from "@repo/app/documents/components/table/sort-keys";
import type { DocumentRowSelectionChange } from "@repo/app/documents/hooks/use-documents-legacy-row-selection";
import {
  getDocumentRowChildren,
  getDocumentRowId,
} from "@repo/app/documents/lib/documents-grid-groups";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import type { HierarchyPlacementDirection } from "@repo/app/shared/lib/hierarchy-placement";
import { manualReorderHandleLabel } from "@repo/app/shared/lib/manual-reorder-handle-label";
import {
  SortableSubtree,
  type SortableSubtreeRoot,
} from "@repo/design-system/components/ui/sortable-subtree";
import { ariaPresentationProps } from "@repo/design-system/lib/grid-table-aria";
import {
  createSiblingFlattener,
  FIRST_TREE_LEVEL,
  type GridRenderRow,
} from "@repo/design-system/lib/grid-table-v2-tree";
import { GripVerticalIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

export type DocumentsUngroupedTreeBodyProps = {
  items: readonly DocumentRowItem[];
  editHandlers?: RowEditHandlers;
  isExpanded: (rowId: string) => boolean;
  toggleRow: (rowId: string) => void;
  selectedIds?: ReadonlySet<string>;
  selectMode?: boolean;
  onSelectionChange?: DocumentRowSelectionChange;
  renderRowActions?: (item: DocumentRowItem) => ReactNode;
  parentMap: ReadonlyMap<string, { title: string; href: string | null }>;
  visibleColumns: DocumentColumn[];
  showCheckbox?: boolean;
  rankInteractionMode?: RankInteractionMode;
  manualPlacementEnabled?: boolean;
  placementPreview?: {
    targetArtifactId: string;
    position: ProjectArtifactPlacementPosition;
  } | null;
  onKeyboardPlacement?: (
    rowId: string,
    direction: HierarchyPlacementDirection
  ) => void;
  insideAriaTable?: boolean;
};

/** Ungrouped document cells adapt the grid's lineage walk and whole-subtree sortable primitive. */
export function DocumentsUngroupedTreeBody(
  props: DocumentsUngroupedTreeBodyProps
) {
  const {
    insideAriaTable = false,
    isExpanded,
    items,
    manualPlacementEnabled = false,
    rankInteractionMode,
  } = props;
  if (
    manualPlacementEnabled &&
    rankInteractionMode === RankInteractionMode.Enabled
  ) {
    return renderManualPlacementNodes(items, FIRST_TREE_LEVEL, props);
  }
  const rows = createSiblingFlattener({
    expandedRowIds: { has: isExpanded },
    getChildren: getDocumentRowChildren,
    getRowId: getDocumentRowId,
  })(items);
  const subtrees = partitionRootSubtrees(rows);

  return subtrees.map((subtree) => {
    const root = subtree[0];
    const children = subtree
      .slice(1)
      .map((row, index) =>
        renderDocumentTreeRow(row, index === subtree.length - 2, props)
      );
    if (rankInteractionMode === RankInteractionMode.Enabled) {
      return (
        <SortableSubtree
          handleLabel={REORDER_ROW_LABEL}
          id={root.rowId}
          insideAriaTable={insideAriaTable}
          key={root.rowId}
          renderRoot={({ buttonProps }) =>
            renderDocumentTreeRow(
              root,
              subtree.length === 1,
              props,
              <button {...buttonProps} className={RANK_DRAG_HANDLE_CLASS}>
                <GripVerticalIcon className="h-4 w-4" />
              </button>
            )
          }
        >
          {children}
        </SortableSubtree>
      );
    }
    return (
      <div {...ariaPresentationProps(insideAriaTable)} key={root.rowId}>
        {renderDocumentTreeRow(root, subtree.length === 1, props)}
        {children}
      </div>
    );
  });
}

export const REORDER_ROW_LABEL = "Reorder row";

function renderManualPlacementNodes(
  items: readonly DocumentRowItem[],
  level: number,
  props: DocumentsUngroupedTreeBodyProps
): ReactNode[] {
  return items.map((item, index) => {
    const rowId = getDocumentRowId(item);
    const children = getDocumentRowChildren(item) ?? [];
    const hasChildren = children.length > 0;
    const row: GridRenderRow<DocumentRowItem> = {
      item,
      rowId,
      tree: {
        level,
        posInSet: index + 1,
        setSize: items.length,
        hasChildren,
        isExpanded: hasChildren && props.isExpanded(rowId),
      },
    };
    const renderedChildren =
      hasChildren && props.isExpanded(rowId)
        ? renderManualPlacementNodes(children, level + 1, props)
        : null;
    if (item.kind !== "document") {
      return (
        <div
          {...ariaPresentationProps(props.insideAriaTable ?? false)}
          key={rowId}
        >
          {renderDocumentTreeRow(row, false, {
            ...props,
            showCheckbox: false,
          })}
          {renderedChildren}
        </div>
      );
    }
    return (
      <SortableSubtree
        announcementLabel={documentRowLabel(item)}
        dropPosition={
          props.placementPreview?.targetArtifactId === rowId &&
          props.placementPreview.position !==
            ProjectArtifactPlacementPosition.Root
            ? props.placementPreview.position
            : undefined
        }
        handleLabel={manualHandleLabel(item)}
        id={rowId}
        insideAriaTable={props.insideAriaTable}
        key={rowId}
        preserveSourcePosition
        renderRoot={({ buttonProps, pointerTargetProps }) =>
          renderDocumentTreeRow(
            row,
            index === items.length - 1 && !hasChildren,
            props,
            <button
              {...buttonProps}
              className={RANK_DRAG_HANDLE_CLASS}
              onKeyDown={(event) =>
                handlePlacementKeyDown(
                  event,
                  rowId,
                  props,
                  buttonProps.onKeyDown
                )
              }
            >
              <GripVerticalIcon className="h-4 w-4" />
            </button>,
            rowPointerTargetProps(pointerTargetProps)
          )
        }
        restrictToVerticalAxis
      >
        {renderedChildren}
      </SortableSubtree>
    );
  });
}

function handlePlacementKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  rowId: string,
  props: DocumentsUngroupedTreeBodyProps,
  fallback: ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined
): void {
  const direction = placementDirection(event);
  if (!direction) {
    fallback?.(event);
    return;
  }
  event.preventDefault();
  props.onKeyboardPlacement?.(rowId, direction);
}

/** Resolve the existing keyboard placement chords for either document tree host. */
export function placementDirection(
  event: KeyboardEvent<HTMLButtonElement>
): HierarchyPlacementDirection | null {
  if (!(event.metaKey || event.ctrlKey)) {
    return null;
  }
  if (event.key === "ArrowUp") {
    return "up";
  }
  if (event.key === "ArrowDown") {
    return "down";
  }
  if (event.key === "ArrowLeft") {
    return "out";
  }
  return event.key === "ArrowRight" ? "in" : null;
}

/** Partition the shared walk at its root boundaries without traversing descendants again. */
function partitionRootSubtrees(
  rows: GridRenderRow<DocumentRowItem>[]
): GridRenderRow<DocumentRowItem>[][] {
  const subtrees: GridRenderRow<DocumentRowItem>[][] = [];
  for (const row of rows) {
    if (row.tree?.level === FIRST_TREE_LEVEL) {
      subtrees.push([row]);
    } else {
      subtrees.at(-1)?.push(row);
    }
  }
  return subtrees;
}

function renderDocumentTreeRow(
  { item, rowId, tree }: GridRenderRow<DocumentRowItem>,
  isLastRow: boolean,
  {
    editHandlers,
    insideAriaTable = false,
    manualPlacementEnabled = false,
    onSelectionChange,
    parentMap,
    rankInteractionMode,
    renderRowActions,
    selectedIds,
    selectMode,
    showCheckbox = false,
    toggleRow,
    visibleColumns,
  }: DocumentsUngroupedTreeBodyProps,
  dragHandle?: ReactNode,
  rowDragTargetProps?: SortableSubtreeRoot["pointerTargetProps"]
): ReactNode {
  const isChild = (tree?.level ?? FIRST_TREE_LEVEL) > FIRST_TREE_LEVEL;
  const hasChildren = tree?.hasChildren ?? false;
  return (
    <DocumentRow
      cardFallback={false}
      dragHandle={isChild && !manualPlacementEnabled ? undefined : dragHandle}
      editHandlers={isDocumentRowItem(item) ? editHandlers : undefined}
      indentDepth={(tree?.level ?? FIRST_TREE_LEVEL) - FIRST_TREE_LEVEL}
      insideAriaTable={insideAriaTable}
      isExpanded={hasChildren ? tree?.isExpanded : undefined}
      isSelected={selectedIds?.has(rowId) ?? false}
      item={item}
      key={rowId}
      moreMenuContent={renderRowActions?.(item)}
      onSelectionChange={onSelectionChange}
      onToggleExpand={hasChildren ? () => toggleRow(rowId) : undefined}
      parentHref={parentMap.get(rowId)?.href}
      parentTitle={parentMap.get(rowId)?.title}
      placementLayout={manualPlacementEnabled ? "manual" : undefined}
      rankInteractionMode={
        isChild && !manualPlacementEnabled ? undefined : rankInteractionMode
      }
      reserveChevronSlot={!isChild}
      reserveRankSlot={
        isChild &&
        !manualPlacementEnabled &&
        shouldShowRankSlot(rankInteractionMode)
      }
      rowDragTargetProps={rowDragTargetProps}
      selectMode={selectMode}
      showBottomBorder={isLastRow}
      showCheckbox={showCheckbox}
      visibleColumns={visibleColumns}
    />
  );
}

const ROW_DRAG_BLOCKING_CONTROL_SELECTOR =
  "button, input, textarea, select, [contenteditable='true'], [role='button'], [role='checkbox']";

function rowPointerTargetProps(
  pointerTargetProps: SortableSubtreeRoot["pointerTargetProps"]
): SortableSubtreeRoot["pointerTargetProps"] {
  return {
    onPointerDown: (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(ROW_DRAG_BLOCKING_CONTROL_SELECTOR)
      ) {
        return;
      }
      pointerTargetProps.onPointerDown?.(event);
    },
  };
}

function documentRowLabel(item: DocumentRowItem): string {
  return item.kind === "document" ? item.data.title : item.data.name;
}

export function manualHandleLabel(item: DocumentRowItem): string {
  return manualReorderHandleLabel(item.data.slug || documentRowLabel(item));
}
