"use client";

import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { GridTableV2TreeLead } from "@repo/design-system/components/ui/grid-table-v2-tree-lead";
import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import { useGridRenderedItemsChange } from "@repo/design-system/hooks/use-grid-rendered-items-change";
import {
  type GridTableV2TouchSelection,
  useGridTableV2TouchSelection,
} from "@repo/design-system/hooks/use-grid-table-v2-touch-selection";
import { resolveAfterRows } from "@repo/design-system/lib/grid-table-v2-after-row";
import { resolveGridTableV2ColumnControls } from "@repo/design-system/lib/grid-table-v2-column-controls";
import { createGridRowExpansionCommands } from "@repo/design-system/lib/grid-table-v2-expansion-commands";
import {
  createGroupDropHandlers,
  GRID_ROW_DRAG_TYPE,
  type GridGroupDropHandlers,
} from "@repo/design-system/lib/grid-table-v2-group-drop";
import {
  buildSubgroupKey,
  collectCollapsedGroupKeys,
  collectRenderedGroupItems,
  resolveGroupCount,
} from "@repo/design-system/lib/grid-table-v2-rows";
import {
  createSiblingFlattener,
  type ExpandedRowLookup,
  type GridRenderRow,
} from "@repo/design-system/lib/grid-table-v2-tree";
import type {
  GridTableV2Column,
  GridTableV2Group,
  GridTableV2Props,
} from "@repo/design-system/lib/grid-table-v2-types";
import { cn } from "@repo/design-system/lib/utils";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useState,
} from "react";

/** Product card renderer for captured-main parity and explicit detail opt-ins. */
export type ProductGridTableV2CardCompatibility<T> = {
  /** Keep cards available when the narrow-grid rollout is open. */
  alwaysActive?: true;
  getSelectionLabel?: (item: T, selected: boolean) => string;
  render: (
    item: T,
    columns: readonly GridTableV2Column[],
    favoriteAction?: ReactNode
  ) => ReactNode;
};

/**
 * Product-only compatibility body for captured-main parity and detail cards.
 * The shared design-system grid stays card-free.
 */
export function ProductGridTableV2CardCompatibilityBody<T>({
  compatibility,
  props,
  renderFavorite,
}: {
  compatibility: ProductGridTableV2CardCompatibility<T>;
  props: GridTableV2Props<T>;
  renderFavorite?: (item: T) => ReactNode;
}) {
  const {
    canDropOnGroup,
    collapseRowLabel,
    columnOrder,
    columns,
    columnWidths,
    defaultExpandedRowIds,
    expandRowLabel,
    getChildren,
    getRowId,
    groupCollapse,
    groupIcon = null,
    groups,
    isRowSelected,
    items,
    movableColumnIds,
    onColumnOrderChange,
    onColumnWidthChange,
    onGroupDrop,
    onRowClick,
    onRowExpandedChange,
    onRowKeyboardNavigate,
    onRenderedItemsChange,
    onRowSelectionToggle,
    renderAfterGroup,
    renderAfterItem,
    renderAfterRows,
    resizableColumnIds,
    rowExpansion,
    showGroupCounts = true,
  } = props;
  const [internalCollapsedGroups, setInternalCollapsedGroups] = useState<
    Set<string>
  >(() => new Set());
  const [internalExpandedRowIds, setInternalExpandedRowIds] = useState<
    Set<string>
  >(() => new Set(defaultExpandedRowIds ?? []));
  const collapsedGroups = groupCollapse
    ? collectCollapsedGroupKeys(groups, groupCollapse.isCollapsed)
    : internalCollapsedGroups;
  const expandedRowIds: ExpandedRowLookup =
    rowExpansion && getChildren
      ? { has: (rowId: string) => rowExpansion.isExpanded(rowId) }
      : internalExpandedRowIds;
  const { orderedColumns } = resolveGridTableV2ColumnControls({
    columnOrder,
    columns,
    columnWidths,
    movableColumnIds,
    onColumnOrderChange,
    onColumnWidthChange,
    resizableColumnIds,
  });
  const beginSiblingWalk = () =>
    createSiblingFlattener({ expandedRowIds, getChildren, getRowId });
  const walkBookkeepingSiblings = beginSiblingWalk();
  const expandSiblings = getChildren
    ? (siblings: readonly T[]) =>
        walkBookkeepingSiblings(siblings).map(toRenderedItem)
    : undefined;
  const ungroupedRows = groups ? [] : beginSiblingWalk()(items);
  const renderedItems = groups
    ? collectRenderedGroupItems(groups, collapsedGroups, expandSiblings)
    : ungroupedRows.map(toRenderedItem);
  useGridRenderedItemsChange({
    getRowId,
    onChange: onRenderedItemsChange,
    renderedItems,
  });
  const findRenderedItem = (rowId: string): T | undefined =>
    renderedItems.find((candidate) => getRowId(candidate) === rowId);
  const { setRowExpanded } = createGridRowExpansionCommands({
    expandedRowIds,
    findRenderedItem,
    getChildren,
    getRowId,
    groups,
    items,
    onRowExpandedChange,
    rowExpansion,
    setInternalExpandedRowIds,
  });
  const afterRows = resolveAfterRows({
    collapsedGroups,
    getRowId,
    groups,
    renderAfterGroup,
    renderAfterItem,
    renderAfterRows,
    renderedItems,
  });
  const selectable = Boolean(
    compatibility.getSelectionLabel &&
      isRowSelected &&
      onRowClick &&
      onRowKeyboardNavigate
  );
  const touchSelection = useGridTableV2TouchSelection({
    enabled: selectable,
    getCurrentItem: findRenderedItem,
    getRowId,
    hasSelection: renderedItems.some((item) => isRowSelected?.(item) === true),
    onToggle: onRowSelectionToggle,
  });
  const toggleGroup = (key: string) => {
    const collapsed = !collapsedGroups.has(key);
    if (groupCollapse) {
      groupCollapse.setCollapsed(key, collapsed);
      return;
    }
    setInternalCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (collapsed) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };
  const findItemByDragEvent = (
    event: DragEvent<HTMLElement>
  ): T | undefined => {
    const rowId = event.dataTransfer.getData(GRID_ROW_DRAG_TYPE);
    return rowId ? findRenderedItem(rowId) : undefined;
  };
  const groupDropHandlers = createGroupDropHandlers({
    canDropOnGroup,
    findItemByDragEvent,
    onGroupDrop,
  });
  const renderCardItem = (row: GridRenderRow<T>): ReactNode => (
    <CompatibilityCardItem
      afterNode={afterRows.itemNodes.get(row.rowId)}
      collapseLabel={collapseRowLabel}
      columns={orderedColumns}
      compatibility={compatibility}
      expandLabel={expandRowLabel}
      favoriteAction={renderFavorite?.(row.item)}
      isSelected={isRowSelected?.(row.item) === true}
      key={row.rowId}
      onKeyboardSelect={(event) =>
        onRowKeyboardNavigate?.(row.item, event, renderedItems)
      }
      onPointerActivate={(event) =>
        onRowClick?.(row.item, event, renderedItems)
      }
      onToggleExpanded={setRowExpanded}
      row={row}
      selectable={selectable}
      touchSelection={touchSelection}
    />
  );
  const expandCardSiblings = beginSiblingWalk();

  if (!groups) {
    return (
      <div className="flex flex-col gap-3 p-3">
        {ungroupedRows.map(renderCardItem)}
        {afterRows.rowsNode}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {groups.map((group) => {
        const isOpen = !collapsedGroups.has(group.key);
        return (
          <div className="flex flex-col gap-3" key={group.key}>
            <GroupSectionHeader
              count={resolveGroupCount(group, showGroupCounts)}
              icon={group.icon ?? groupIcon}
              isContinued={group.isContinued}
              isOpen={isOpen}
              label={group.label}
              onToggle={() => toggleGroup(group.key)}
            />
            {isOpen && group.subgroups
              ? group.subgroups.map((subgroup) => {
                  const subgroupKey = buildSubgroupKey(group.key, subgroup.key);
                  const subgroupOpen = !collapsedGroups.has(subgroupKey);
                  return (
                    <CompatibilityCardSubgroup
                      group={group}
                      groupDropHandlers={groupDropHandlers}
                      groupIcon={groupIcon}
                      isOpen={subgroupOpen}
                      key={subgroupKey}
                      showGroupCounts={showGroupCounts}
                      subgroup={subgroup}
                      subgroupKey={subgroupKey}
                      toggleGroup={toggleGroup}
                    >
                      {subgroupOpen
                        ? expandCardSiblings(subgroup.items).map(renderCardItem)
                        : null}
                    </CompatibilityCardSubgroup>
                  );
                })
              : null}
            {isOpen && !group.subgroups
              ? expandCardSiblings(group.items).map(renderCardItem)
              : null}
            {isOpen ? afterRows.groupNodes.get(group.key) : null}
          </div>
        );
      })}
    </div>
  );
}

function CompatibilityCardItem<T>({
  afterNode,
  collapseLabel,
  columns,
  compatibility,
  favoriteAction,
  expandLabel,
  isSelected,
  onKeyboardSelect,
  onPointerActivate,
  onToggleExpanded,
  row,
  selectable,
  touchSelection,
}: {
  afterNode: ReactNode;
  collapseLabel?: string;
  columns: readonly GridTableV2Column[];
  compatibility: ProductGridTableV2CardCompatibility<T>;
  favoriteAction?: ReactNode;
  expandLabel?: string;
  isSelected: boolean;
  onKeyboardSelect: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPointerActivate: (event: MouseEvent<HTMLDivElement>) => void;
  onToggleExpanded: (rowId: string, expanded: boolean) => void;
  row: GridRenderRow<T>;
  selectable: boolean;
  touchSelection: GridTableV2TouchSelection<T>;
}) {
  const card = selectable ? (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Captured-main cards contain nested controls, so a button wrapper would be invalid; the group owns only padding gestures.
    // biome-ignore lint/a11y/useSemanticElements: A fieldset cannot wrap arbitrary interactive captured-main card content.
    <div
      aria-label={compatibility.getSelectionLabel?.(row.item, isSelected)}
      className={cn(
        "pointer-coarse:select-none rounded-xl",
        CHIP_FOCUS_RING_CLASS,
        isSelected &&
          "[&>[data-slot=card]]:border-primary/30 [&>[data-slot=card]]:bg-primary/10"
      )}
      data-analytics-action="true"
      data-analytics-keyboard="true"
      data-analytics-label="Select row"
      data-grid-card-id={row.rowId}
      data-state={isSelected ? "selected" : undefined}
      onClick={(event) =>
        touchSelection.onClick(row.item, event, onPointerActivate)
      }
      onContextMenu={touchSelection.onContextMenu}
      onKeyDown={(event) => {
        if (
          (event.key === "Enter" || event.key === " ") &&
          event.target === event.currentTarget
        ) {
          event.preventDefault();
          onKeyboardSelect(event);
        }
      }}
      onPointerCancel={touchSelection.onPointerCancel}
      onPointerDown={(event) => touchSelection.onPointerDown(row.item, event)}
      onPointerMove={touchSelection.onPointerMove}
      onPointerUp={touchSelection.onPointerUp}
      role="group"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Captured-main cards were keyboard-selectable groups and must remain so while the rollout is closed.
      tabIndex={0}
    >
      {compatibility.render(row.item, columns, favoriteAction)}
    </div>
  ) : (
    <div data-grid-card-id={row.rowId}>
      {compatibility.render(row.item, columns, favoriteAction)}
    </div>
  );
  return (
    <>
      {row.tree === null ? (
        card
      ) : (
        <GridTableV2TreeLead
          className="items-start"
          collapseLabel={collapseLabel}
          declaresExpandedState
          expandLabel={expandLabel}
          onToggle={(expanded) => onToggleExpanded(row.rowId, expanded)}
          tree={row.tree}
        >
          {card}
        </GridTableV2TreeLead>
      )}
      {afterNode}
    </>
  );
}

function CompatibilityCardSubgroup<T>({
  children,
  group,
  groupDropHandlers,
  groupIcon,
  isOpen,
  showGroupCounts,
  subgroup,
  subgroupKey,
  toggleGroup,
}: {
  children: ReactNode;
  group: GridTableV2Group<T>;
  groupDropHandlers: (
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ) => GridGroupDropHandlers;
  groupIcon: ReactNode;
  isOpen: boolean;
  showGroupCounts: boolean;
  subgroup: GridTableV2Group<T>;
  subgroupKey: string;
  toggleGroup: (key: string) => void;
}) {
  return (
    <div
      className="ml-3 flex flex-col gap-3 border-l pl-3"
      {...groupDropHandlers(group, subgroup)}
    >
      <GroupSectionHeader
        className="rounded-md"
        count={resolveGroupCount(subgroup, showGroupCounts)}
        icon={subgroup.icon ?? groupIcon}
        isContinued={subgroup.isContinued}
        isOpen={isOpen}
        label={subgroup.label}
        onToggle={() => toggleGroup(subgroupKey)}
      />
      {children}
    </div>
  );
}

function toRenderedItem<T>(row: GridRenderRow<T>): T {
  return row.item;
}
