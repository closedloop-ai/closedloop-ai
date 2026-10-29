"use client";

/**
 * A `GridTableV2` body's GROUPED shape: one `rowgroup` per band, its collapsible
 * section header, its subgroups' bands, and each band's trailing after-row slot.
 *
 * Lifted out of `grid-table-v2.tsx` beside the row and windowed-body renderers
 * (marisolashgrove review) — the compositor keeps the decision of WHICH body shape
 * to render, and each shape owns how it renders. Nothing about the markup
 * changed in the move.
 *
 * A plain function rather than a component for the same reason its siblings are:
 * a `grid` may own only rows and rowgroups, so what this emits has to be the
 * grid element's own children.
 */

import {
  buildSubgroupKey,
  resolveGroupCount,
} from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import type { GridRenderRow } from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import type { GridTableV2Group } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import type { ComponentProps, ReactNode } from "react";
import { GridTableV2SectionHeaderRow } from "./grid-table-v2-section-header-row";

export function renderGridTableV2GroupedRows<T>({
  collapsedGroups,
  flattenGridSiblings,
  groupDropHandlers,
  groupHeaderNavigation,
  groupIcon,
  groups,
  columnCount,
  isNarrowList,
  renderAfterGroupRow,
  renderGridItem,
  showGroupCounts,
  staticTableSemantics,
  toggleGroup,
}: {
  collapsedGroups: ReadonlySet<string>;
  columnCount: number;
  /** Expands each band's roots into the rows it actually paints. */
  flattenGridSiblings: (items: readonly T[]) => GridRenderRow<T>[];
  groupDropHandlers: (
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ) => Record<string, unknown>;
  groupHeaderNavigation: (
    bandKey: string
  ) => ComponentProps<typeof GridTableV2SectionHeaderRow>["navigation"];
  groupIcon?: ReactNode;
  groups: readonly GridTableV2Group<T>[];
  /** The phone list is scanned by axe as a grid, so it never nests rowgroups. */
  isNarrowList: boolean;
  renderAfterGroupRow: (groupKey: string) => ReactNode;
  renderGridItem: (row: GridRenderRow<T>) => ReactNode;
  showGroupCounts: boolean;
  staticTableSemantics: boolean;
  toggleGroup: (key: string) => void;
}): ReactNode {
  return groups.map((group) => {
    const isOpen = !collapsedGroups.has(group.key);
    // The static table keeps nested rowgroups as siblings for ARIA ownership.
    const header = (
      <GridTableV2SectionHeaderRow
        className="bg-background py-3 font-semibold"
        columnCount={columnCount}
        count={resolveGroupCount(group, showGroupCounts)}
        icon={group.icon ?? groupIcon}
        isContinued={group.isContinued}
        isOpen={isOpen}
        label={group.label}
        navigation={groupHeaderNavigation(group.key)}
        staticTableSemantics={staticTableSemantics}
        onToggle={() => toggleGroup(group.key)}
      />
    );
    const hasStaticSubgroups =
      (staticTableSemantics || isNarrowList) && group.subgroups !== undefined;
    return (
      <div
        className={GROUPED_ROW_LEAD_INSET_CLASS}
        key={group.key}
        role={hasStaticSubgroups ? "presentation" : "rowgroup"}
        {...groupDropHandlers(group)}
      >
        {hasStaticSubgroups ? <div role="rowgroup">{header}</div> : header}
        {isOpen && group.subgroups
          ? group.subgroups.map((subgroup) => {
              const subgroupKey = buildSubgroupKey(group.key, subgroup.key);
              const subgroupOpen = !collapsedGroups.has(subgroupKey);
              return (
                <div
                  key={subgroupKey}
                  role="rowgroup"
                  {...groupDropHandlers(group, subgroup)}
                >
                  <GridTableV2SectionHeaderRow
                    className="bg-background py-3 pl-10 font-semibold"
                    columnCount={columnCount}
                    count={resolveGroupCount(subgroup, showGroupCounts)}
                    icon={subgroup.icon ?? groupIcon}
                    isContinued={subgroup.isContinued}
                    isOpen={subgroupOpen}
                    label={subgroup.label}
                    navigation={groupHeaderNavigation(subgroupKey)}
                    staticTableSemantics={staticTableSemantics}
                    onToggle={() => toggleGroup(subgroupKey)}
                  />
                  {subgroupOpen
                    ? flattenGridSiblings(subgroup.items).map(renderGridItem)
                    : null}
                </div>
              );
            })
          : isOpen
            ? flattenGridSiblings(group.items).map(renderGridItem)
            : null}
        {renderAfterGroupRow(group.key)}
      </div>
    );
  });
}

/**
 * Grouped rows inset their identity under the band label. Only the lead cell
 * takes it: padding the whole row would push every body cell off its column
 * header, and the band header is not a lead cell (tamsinb review on #9116).
 */
export const GROUPED_ROW_LEAD_INSET_CLASS =
  "[&_[data-grid-row]_[data-grid-lead-cell]]:pl-14";
