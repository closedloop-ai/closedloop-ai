"use client";

import { ProductGridTableV2CardCompatibilityBody } from "@repo/app/shared/components/product-grid-table-v2-card-compatibility";
import {
  GridTableListSurface,
  type GridTableListSurfaceMode,
} from "@repo/design-system/components/ui/grid-table-list-surface";
import { GridTableV2 } from "@repo/design-system/components/ui/grid-table-v2";
import { GridTableV2TreeLead } from "@repo/design-system/components/ui/grid-table-v2-tree-lead";
import { GroupSectionHeader } from "@repo/design-system/components/ui/group-section-header";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import type { GridGroupDropHandlers } from "@repo/design-system/lib/grid-table-v2-group-drop";
import {
  buildSubgroupKey,
  resolveGroupCount,
} from "@repo/design-system/lib/grid-table-v2-rows";
import type { GridRenderRow } from "@repo/design-system/lib/grid-table-v2-tree";
import type {
  GridTableV2Column,
  GridTableV2Group,
  GridTableV2Props,
} from "@repo/design-system/lib/grid-table-v2-types";
import { type ComponentProps, Fragment, type ReactNode } from "react";

/** Container-measured v1 surface retained only for its three frozen stories. */
export function FrozenGridTableListSurface(
  props: ComponentProps<typeof GridTableListSurface>
) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const mode: GridTableListSurfaceMode =
    width < CARD_FALLBACK_BREAKPOINT ? "compact" : "expanded";
  return (
    <div className="w-full" ref={ref}>
      <GridTableListSurface {...props} mode={mode} />
    </div>
  );
}

/** Compile-only bridge for frozen v1 stories after the production card API retired. */
export function FrozenGridTableV2<T>({
  cardRender,
  ...props
}: GridTableV2Props<T> & {
  cardRender: (item: T, columns: readonly GridTableV2Column[]) => ReactNode;
}) {
  if (props.mode !== "compact") {
    return <GridTableV2<T> {...props} />;
  }
  return (
    <div className="w-full">
      <ProductGridTableV2CardCompatibilityBody
        compatibility={{ render: cardRender }}
        props={props}
      />
    </div>
  );
}

/**
 * Story-only compatibility renderer for the frozen v1 card-list examples.
 * PRD-727 removed the product card fallback; this keeps the frozen story's
 * markup and interactions without restoring a design-system API.
 */
export function GridTableV2CardList<T>({
  afterGroupNodes,
  afterRowsNode,
  beginSiblingWalk,
  collapsedGroups,
  groupDropHandlers,
  groupIcon,
  groups,
  renderCardItem,
  showGroupCounts,
  toggleGroup,
  ungroupedRows,
}: {
  afterGroupNodes: Map<string, ReactNode>;
  afterRowsNode: ReactNode;
  /**
   * Starts this pass's own cycle guard — never shared with the grid's, and
   * never handed in already started (ISS-10335). A walk's guard is spent once
   * every id it has seen is in the set, and React may invoke this body more
   * than once for a single commit (StrictMode, a re-render reusing the prop),
   * so an already-started walk in a prop paints empty bands under headers that
   * still count their items. Taking the factory makes the walk begin where it
   * is consumed, which is the only place that can be once per render.
   */
  beginSiblingWalk: () => (items: readonly T[]) => GridRenderRow<T>[];
  collapsedGroups: ReadonlySet<string>;
  groupDropHandlers: (
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ) => GridGroupDropHandlers;
  groupIcon: ReactNode;
  groups?: GridTableV2Group<T>[];
  renderCardItem: (row: GridRenderRow<T>) => ReactNode;
  showGroupCounts: boolean;
  toggleGroup: (key: string) => void;
  ungroupedRows: GridRenderRow<T>[];
}) {
  const expandSiblings = beginSiblingWalk();
  if (!groups) {
    return (
      <div className="flex flex-col gap-3 p-3">
        {ungroupedRows.map(renderCardItem)}
        {afterRowsNode}
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
                    <CardSubgroup
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
                        ? expandSiblings(subgroup.items).map(renderCardItem)
                        : null}
                    </CardSubgroup>
                  );
                })
              : null}
            {isOpen && !group.subgroups
              ? expandSiblings(group.items).map(renderCardItem)
              : null}
            {isOpen ? afterGroupNodes.get(group.key) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One frozen story card plus its optional tree disclosure and after-row node. */
export function GridTableV2CardItem<T>({
  afterNode,
  collapseLabel,
  columns,
  expandLabel,
  onToggleExpanded,
  render,
  row: { item, rowId, tree },
}: {
  afterNode: ReactNode;
  collapseLabel?: string;
  columns: readonly GridTableV2Column[];
  expandLabel?: string;
  onToggleExpanded: (rowId: string, expanded: boolean) => void;
  render?: (item: T, columns: readonly GridTableV2Column[]) => ReactNode;
  row: GridRenderRow<T>;
}) {
  const card = <div data-grid-card-id={rowId}>{render?.(item, columns)}</div>;
  return (
    <Fragment key={rowId}>
      {tree === null ? (
        card
      ) : (
        <GridTableV2TreeLead
          className="items-start"
          collapseLabel={collapseLabel}
          declaresExpandedState
          expandLabel={expandLabel}
          onToggle={(expanded) => onToggleExpanded(rowId, expanded)}
          tree={tree}
        >
          {card}
        </GridTableV2TreeLead>
      )}
      {afterNode}
    </Fragment>
  );
}

function CardSubgroup<T>({
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
