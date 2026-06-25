"use client";

import { Priority } from "@repo/api/src/types/common";
import { GROUP_BY_LABELS, GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  ALL_ARTIFACT_COLUMNS,
  ARTIFACT_COLUMN_LABELS,
  DocumentColumn as Col,
  type ColumnVisibility,
  type DocumentColumn,
} from "@repo/app/shared/hooks/use-column-visibility";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  TableViewMenu as SharedTableViewMenu,
  type TableViewMode as SharedTableViewMode,
} from "@repo/design-system/components/ui/table-view-menu";
import {
  BadgeCheckIcon,
  CalendarIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  ListTreeIcon,
  RefreshCwIcon,
  TagIcon,
  UserIcon,
} from "lucide-react";
import type { ReactNode } from "react";

const COLUMN_ICONS: Partial<Record<DocumentColumn, ReactNode>> = {
  [Col.Type]: <FileIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Assignee]: <UserIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Loop]: <RefreshCwIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Parent]: <ListTreeIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Priority]: <PriorityIcon priority={Priority.Medium} size={16} />,
  [Col.Score]: <BadgeCheckIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Tags]: <TagIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.DueDate]: <CalendarIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Updated]: <ClockIcon className="h-4 w-4 text-muted-foreground" />,
  [Col.Project]: <FolderIcon className="h-4 w-4 text-muted-foreground" />,
};

export type TableViewMode = SharedTableViewMode;

type TableViewMenuProps = Readonly<{
  visibility?: ColumnVisibility;
  onToggle?: (column: DocumentColumn) => void;
  /** Override the list of columns shown in the panel. Defaults to ALL_ARTIFACT_COLUMNS. */
  columns?: DocumentColumn[];
  /** Active group-by mode (none | status | assignee | priority). */
  groupBy?: GroupByMode;
  /** Change the active group-by mode. */
  onChangeGroupBy?: (mode: GroupByMode) => void;
  /** Active view mode (list | card). When provided with onChangeView, renders a view toggle at the top. */
  view?: TableViewMode;
  /** Change the active view mode. */
  onChangeView?: (view: TableViewMode) => void;
  /** Reset all persisted view state (filters, sort, search, scroll). */
  onResetView?: () => void;
  /**
   * Restore stack-rank ordering by clearing the active sort + group state.
   * Surfaces a dedicated menu item alongside "Reset view" so a user who has
   * picked a column sort can revert to the canonical project order without
   * also losing their column visibility / search / filter state (PRD-421 /
   * PLN-755 Phase D). Omit when the stack-rank page is not in scope so the
   * item is hidden.
   */
  onResetToStackRank?: () => void;
}>;

const GROUP_BY_OPTIONS: GroupByMode[] = [
  GroupByMode.None,
  GroupByMode.Status,
  GroupByMode.Assignee,
  GroupByMode.Priority,
];

export function TableViewMenu({
  visibility,
  onToggle,
  columns = ALL_ARTIFACT_COLUMNS,
  groupBy,
  onChangeGroupBy,
  view,
  onChangeView,
  onResetView,
  onResetToStackRank,
}: TableViewMenuProps) {
  return (
    <SharedTableViewMenu
      columns={
        visibility
          ? columns.map((column) => ({
              id: column,
              icon: COLUMN_ICONS[column],
              label: ARTIFACT_COLUMN_LABELS[column],
              visible: visibility[column],
            }))
          : undefined
      }
      groupByOptions={GROUP_BY_OPTIONS.map((mode) => ({
        value: mode,
        label: GROUP_BY_LABELS[mode],
      }))}
      groupByValue={groupBy}
      onChangeGroupBy={(mode) => onChangeGroupBy?.(mode as GroupByMode)}
      onChangeView={onChangeView}
      onResetToStackRank={onResetToStackRank}
      onResetView={onResetView}
      onToggleColumn={(columnId) => onToggle?.(columnId as DocumentColumn)}
      view={view}
    />
  );
}
