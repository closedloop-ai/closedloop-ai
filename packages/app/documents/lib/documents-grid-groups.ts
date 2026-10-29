import {
  collectCollapsedGroupKeys,
  collectRenderedGroupRows,
} from "@repo/design-system/lib/grid-table-v2-rows";
import {
  createSiblingFlattener,
  type GridRenderRow,
} from "@repo/design-system/lib/grid-table-v2-tree";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import type { DocumentRowItem } from "../components/table/document-row";
import type { DisplayGroup } from "../components/table/document-tree";
import {
  GroupByMode,
  type GroupByModeOptions,
  type GroupSectionDescriptor,
  groupByMode,
} from "./group-by";

/** Missing supplied totals mean unknown, while an absent map means the rows are complete. */
export function resolveSectionPopulation(
  sectionTotalsByKey: ReadonlyMap<string, number> | undefined,
  sectionKey: string
): number | null | undefined {
  if (sectionTotalsByKey === undefined) {
    return;
  }
  return sectionTotalsByKey.get(sectionKey) ?? null;
}

/** Build bands from roots only; descendants retain their root's membership through children. */
export function buildDocumentGridGroups({
  continuedSectionKeys,
  flatItems,
  groupBy,
  groupOptions,
  groups,
  isGroupedView,
  sectionTotalsByKey,
}: {
  continuedSectionKeys?: ReadonlySet<string>;
  flatItems: DocumentRowItem[];
  groupBy: GroupByMode;
  groupOptions: GroupByModeOptions;
  groups: DisplayGroup[];
  isGroupedView: boolean;
  sectionTotalsByKey?: ReadonlyMap<string, number>;
}): DocumentGridGroup[] {
  if (groupBy === GroupByMode.None) {
    return [];
  }
  const roots = isGroupedView ? documentTreeRoots(groups) : flatItems;
  return groupByMode(roots, (item) => item, groupBy, groupOptions).map(
    ({ descriptor, values }) => ({
      descriptor,
      key: descriptor.key,
      label: descriptor.label,
      items: values,
      count: resolveSectionPopulation(sectionTotalsByKey, descriptor.key),
      isContinued: continuedSectionKeys?.has(descriptor.key),
    })
  );
}

/** Join the tree projection's root/children fields at the canonical lineage boundary. */
export function documentTreeRoots(
  groups: readonly DisplayGroup[]
): DocumentRowItem[] {
  return groups.map((group) => ({ ...group.root, children: group.children }));
}

/** One guarded traversal of the whole ordered body, shared with the grid's lineage renderer. */
export function collectVisibleDocumentRows(
  roots: readonly DocumentRowItem[],
  isExpanded: (key: string) => boolean
): DocumentRowItem[] {
  return createSiblingFlattener({
    expandedRowIds: { has: isExpanded },
    getChildren: getDocumentRowChildren,
    getRowId: getDocumentRowId,
  })(roots).map((row) => row.item);
}

/** Domain presentation metadata stays beside the canonical, renderable grid band. */
export type DocumentGridGroup = GridTableV2Group<DocumentRowItem> & {
  descriptor: GroupSectionDescriptor;
};

/** Grouped projections must retain the same per-band walks as grid and card painting. */
export function collectPaintedDocumentGroupRows({
  gridGroups,
  isGroupExpanded,
  isNested,
  isSectionExpanded,
}: {
  gridGroups: readonly GridTableV2Group<DocumentRowItem>[];
  isGroupExpanded: (key: string) => boolean;
  isNested: boolean;
  isSectionExpanded?: (key: string) => boolean;
}): GridRenderRow<DocumentRowItem>[] {
  const collapsedGroups = collectCollapsedGroupKeys(
    gridGroups,
    (key) => isSectionExpanded !== undefined && !isSectionExpanded(key)
  );
  return collectRenderedGroupRows({
    collapsedGroups,
    expandedRowIds: { has: isGroupExpanded },
    getChildren: isNested ? getDocumentRowChildren : undefined,
    getRowId: getDocumentRowId,
    groups: gridGroups,
  });
}

/** Stable document identity used by every canonical lineage projection. */
export function getDocumentRowId(item: DocumentRowItem): string {
  return item.data.id;
}

/** Root-owned descendants are the grid's sole lineage source. */
export function getDocumentRowChildren(
  item: DocumentRowItem
): readonly DocumentRowItem[] | undefined {
  return Array.isArray(item.children) ? item.children : undefined;
}
