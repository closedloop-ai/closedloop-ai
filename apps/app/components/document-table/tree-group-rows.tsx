"use client";

import {
  DocumentRow,
  type DocumentRowItem,
  type RowEditHandlers,
} from "@/components/document-table/document-row";
import type { DisplayGroup } from "@/components/document-table/document-tree";
import type { DocumentColumn } from "@/hooks/use-column-visibility";

type TreeGroupRowsProps = {
  group: DisplayGroup;
  editHandlers?: RowEditHandlers;
  isGroupExpanded: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  selectedIds?: Set<string>;
  handleSelectionChange?: (id: string, checked: boolean) => void;
  handleMoreMenu?: (item: DocumentRowItem, anchor: HTMLElement) => void;
  /** Custom content to render in the more-menu cell (replaces default ellipsis). */
  moreMenuContent?: (
    item: DocumentRowItem,
    onRequestDelete: () => void
  ) => React.ReactNode;
  /** Per-row delete handler; required if moreMenuContent is provided. */
  onRequestDelete?: (item: DocumentRowItem) => void;
  parentMap: Map<string, { title: string; href: string | null }>;
  visibleColumns: DocumentColumn[];
  showCheckbox?: boolean;
};

export function TreeGroupRows({
  group,
  editHandlers,
  isGroupExpanded,
  toggleGroup,
  selectedIds,
  handleSelectionChange,
  handleMoreMenu,
  moreMenuContent,
  onRequestDelete,
  parentMap,
  visibleColumns,
  showCheckbox = false,
}: TreeGroupRowsProps) {
  const { root, children } = group;
  const isOpen = isGroupExpanded(group.groupKey);
  const hasChildren = children.length > 0;

  const collectVisibleChildren = (items: DocumentRowItem[]): DocumentRowItem[] => {
    const visible: DocumentRowItem[] = [];
    for (const item of items) {
      visible.push(item);
      if (
        item.children &&
        item.children.length > 0 &&
        isGroupExpanded(item.data.id)
      ) {
        visible.push(...collectVisibleChildren(item.children));
      }
    }
    return visible;
  };

  const renderRow = (
    item: DocumentRowItem,
    isChild: boolean,
    last: boolean
  ) => {
    const rowMoreMenuContent =
      item.kind !== "branch" && moreMenuContent && onRequestDelete
        ? moreMenuContent(item, () => onRequestDelete(item))
        : undefined;
    const itemHasChildren = (item.children?.length ?? 0) > 0;
    const itemIsExpanded = isChild
      ? itemHasChildren && isGroupExpanded(item.data.id)
      : hasChildren && isOpen;
    const itemEditHandlers = item.kind === "branch" ? undefined : editHandlers;
    const itemMoreMenuHandler =
      item.kind === "branch" ? undefined : handleMoreMenu;

    return (
      <DocumentRow
        editHandlers={itemEditHandlers}
        extendIndentedBottomBorderLeft={isChild && last}
        indented={isChild}
        isExpanded={itemHasChildren ? itemIsExpanded : undefined}
        isSelected={selectedIds?.has(item.data.id) ?? false}
        item={item}
        key={item.data.id}
        moreMenuContent={rowMoreMenuContent}
        onMoreMenu={itemMoreMenuHandler}
        onSelectionChange={handleSelectionChange}
        onToggleExpand={
          !itemHasChildren
            ? undefined
            : isChild
              ? () => toggleGroup(item.data.id)
              : () => toggleGroup(group.groupKey)
        }
        parentHref={parentMap.get(item.data.id)?.href}
        parentTitle={parentMap.get(item.data.id)?.title}
        showCheckbox={showCheckbox}
        visibleColumns={visibleColumns}
      />
    );
  };

  return (
    <div key={group.groupKey}>
      {renderRow(root, false, false)}
      {isOpen &&
        collectVisibleChildren(children).map((child, childIndex, visibleChildren) =>
          renderRow(
            child,
            true,
            childIndex === visibleChildren.length - 1
          )
        )}
    </div>
  );
}
