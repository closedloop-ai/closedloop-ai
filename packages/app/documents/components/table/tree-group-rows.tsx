"use client";

import { DocumentType } from "@repo/api/src/types/document";
import {
  DocumentRow,
  type DocumentRowItem,
} from "@repo/app/documents/components/table/document-row";
import type { DisplayGroup } from "@repo/app/documents/components/table/document-tree";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import {
  RankInteractionMode,
  shouldShowRankSlot,
} from "@repo/app/documents/components/table/sort-keys";
import { SortableTreeGroup } from "@repo/app/documents/components/table/sortable-tree-group";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import type { ReactNode } from "react";

function isPlanItem(item: DocumentRowItem): boolean {
  return (
    item.kind === "document" &&
    item.data.type === DocumentType.ImplementationPlan
  );
}

type TreeGroupRowsProps = {
  group: DisplayGroup;
  editHandlers?: RowEditHandlers;
  isGroupExpanded: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  selectedIds?: Set<string>;
  handleSelectionChange?: (id: string, checked: boolean) => void;
  handleMoreMenu?: (item: DocumentRowItem, anchor: HTMLElement) => void;
  parentMap: Map<string, { title: string; href: string | null }>;
  visibleColumns: DocumentColumn[];
  showCheckbox?: boolean;
  /**
   * Stack-rank interaction state to apply to the ROOT row of this group
   * (PRD-421 / PLN-755 Phase E). Children are never rankable — they reserve
   * an empty rank slot instead so root and child grids share the same leading
   * columns. Pass `undefined` outside the stack-rank surface.
   */
  rankInteractionMode?: RankInteractionMode;
};

export function TreeGroupRows({
  group,
  editHandlers,
  isGroupExpanded,
  toggleGroup,
  selectedIds,
  handleSelectionChange,
  handleMoreMenu,
  parentMap,
  visibleColumns,
  showCheckbox = false,
  rankInteractionMode,
}: TreeGroupRowsProps) {
  const { root, children } = group;
  // Plans are always expanded, regardless of stored expansion state.
  const isOpen = isPlanItem(root) || isGroupExpanded(group.groupKey);
  const hasChildren = children.length > 0;

  const collectVisibleChildren = (
    items: DocumentRowItem[],
    depth: number
  ): { item: DocumentRowItem; depth: number }[] => {
    const visible: { item: DocumentRowItem; depth: number }[] = [];
    for (const item of items) {
      visible.push({ item, depth });
      const hasNestedChildren =
        (item.children && item.children.length > 0) ?? false;
      // Plans are always expanded — there is only one Plan per PRD/Feature, so
      // collapsing its branches adds no information.
      const shouldExpand =
        hasNestedChildren &&
        (isPlanItem(item) || isGroupExpanded(item.data.id));
      if (shouldExpand && item.children) {
        visible.push(...collectVisibleChildren(item.children, depth + 1));
      }
    }
    return visible;
  };

  const renderRow = (
    item: DocumentRowItem,
    depth: number,
    isLastRowOfGroup: boolean,
    dragHandle?: ReactNode
  ) => {
    const isChild = depth > 0;
    const itemHasChildren = isChild
      ? (item.children?.length ?? 0) > 0
      : hasChildren;
    const itemIsPlan = isPlanItem(item);
    // Plans never render a chevron — they are auto-expanded — but their slot is
    // still reserved so column alignment is preserved.
    const showChevron = itemHasChildren && !itemIsPlan;
    const itemIsExpanded = isChild
      ? showChevron && isGroupExpanded(item.data.id)
      : showChevron && isOpen;
    // Edit handlers operate on document fields, so only document rows receive
    // them. Every row still gets the shared ellipsis menu via `onMoreMenu`;
    // the menu host gates per-row actions by type (e.g. the registry's
    // `deletable`), which is how branch artifacts are deleted from the tree.
    const itemEditHandlers = isDocumentRowItem(item) ? editHandlers : undefined;
    const onToggleExpand = buildToggleHandler(
      item,
      isChild,
      showChevron,
      group.groupKey,
      toggleGroup
    );

    const commonProps = {
      editHandlers: itemEditHandlers,
      indentDepth: depth,
      isExpanded: showChevron ? itemIsExpanded : undefined,
      isSelected: selectedIds?.has(item.data.id) ?? false,
      item,
      onMoreMenu: handleMoreMenu,
      onSelectionChange: handleSelectionChange,
      onToggleExpand,
      parentHref: parentMap.get(item.data.id)?.href,
      parentTitle: parentMap.get(item.data.id)?.title,
      reserveChevronSlot: !isChild,
      // Child rows are not rankable, but on a rank surface they must reserve
      // the empty rank slot — otherwise the 28px slot rendered only on root
      // rows exactly cancels one level of child indentation.
      reserveRankSlot: isChild && shouldShowRankSlot(rankInteractionMode),
      // Rows of one group read as a single visual block: only the group's
      // last visible row draws the divider to the next group.
      showBottomBorder: isLastRowOfGroup,
      showCheckbox,
      visibleColumns,
    };
    return renderTreeRow(commonProps, isChild, rankInteractionMode, dragHandle);
  };

  const visibleChildren = isOpen ? collectVisibleChildren(children, 1) : [];
  const rootIsLastRow = visibleChildren.length === 0;
  const childRows = visibleChildren.map(({ item, depth }, index) =>
    renderRow(item, depth, index === visibleChildren.length - 1)
  );

  // On the active rank surface, wrap the whole group in a single sortable node
  // so a drag moves the root and all its children together.
  if (rankInteractionMode === RankInteractionMode.Enabled) {
    return (
      <SortableTreeGroup
        id={root.data.id}
        renderRoot={(dragHandle) =>
          renderRow(root, 0, rootIsLastRow, dragHandle)
        }
      >
        {childRows}
      </SortableTreeGroup>
    );
  }

  return (
    <div>
      {renderRow(root, 0, rootIsLastRow)}
      {childRows}
    </div>
  );
}

function buildToggleHandler(
  item: DocumentRowItem,
  isChild: boolean,
  itemHasChildren: boolean,
  rootGroupKey: string,
  toggleGroup: (key: string) => void
): (() => void) | undefined {
  if (!itemHasChildren) {
    return undefined;
  }
  if (isChild) {
    return () => toggleGroup(item.data.id);
  }
  return () => toggleGroup(rootGroupKey);
}

type RankableCommonProps = Omit<
  React.ComponentProps<typeof DocumentRow>,
  "rankInteractionMode" | "dragHandle"
>;

/**
 * Render a tree row, applying rank state to roots only. Extracted from
 * `renderRow` so that closure stays under the cognitive complexity cap. Child
 * rows always get `undefined` mode and no handle (they reserve an empty rank
 * slot via `reserveRankSlot` instead); the root row reflects the group's mode
 * and (in `Enabled` mode) hosts the drag handle from `SortableTreeGroup`.
 */
function renderTreeRow(
  props: RankableCommonProps,
  isChild: boolean,
  rankInteractionMode: RankInteractionMode | undefined,
  dragHandle: ReactNode
): React.ReactElement {
  return (
    <DocumentRow
      {...props}
      dragHandle={isChild ? undefined : dragHandle}
      key={props.item.data.id}
      rankInteractionMode={isChild ? undefined : rankInteractionMode}
    />
  );
}
