/**
 * One declaration feeding two consumers: `GridTableV2` renders these columns, and
 * the shared table toolbar menus (sort / group / options / view) read them as
 * canonical {@link ColumnDefinition}s. `kind` and the {@link ColumnWidthBounds}
 * `width` are what those menus require — declaring a second, menu-only inventory
 * beside this one is exactly the drift the registry exists to stop.
 */

import {
  type ColumnDefinition,
  ColumnFieldKind,
  type ColumnWidthBounds,
} from "@repo/design-system/lib/column-registry";

export type ProjectSummaryColumn = ColumnDefinition & {
  width: ColumnWidthBounds;
};

export const PROJECT_SUMMARY_COLUMNS: readonly ProjectSummaryColumn[] = [
  {
    filterable: true,
    groupable: true,
    id: "priority",
    kind: ColumnFieldKind.Choice,
    label: "Priority",
    sortable: true,
    width: { default: 124 },
  },
  {
    filterable: true,
    groupable: true,
    id: "owner",
    kind: ColumnFieldKind.Person,
    label: "Owner",
    sortable: true,
    width: { default: 164 },
  },
  {
    id: "dueDate",
    kind: ColumnFieldKind.Date,
    label: "Due Date",
    sortable: true,
    width: { default: 124 },
  },
  {
    filterable: true,
    id: "updated",
    kind: ColumnFieldKind.Date,
    label: "Updated",
    sortable: true,
    width: { default: 124 },
  },
];

export const PROJECT_SUMMARY_COLUMN_IDS: readonly string[] =
  PROJECT_SUMMARY_COLUMNS.map((column) => column.id);

/**
 * Each column's visible heading, by id. Derived from the one inventory above so
 * a host naming a field — an editable cell's accessible name, say — says the
 * same word the header does instead of re-spelling it.
 */
export const PROJECT_SUMMARY_COLUMN_LABELS: Readonly<Record<string, string>> =
  Object.fromEntries(
    PROJECT_SUMMARY_COLUMNS.map((column) => [column.id, column.label])
  );

/** Leading (name) column default width, in px. */
export const PROJECT_SUMMARY_LEADING_COLUMN_WIDTH_PX = 420;

/**
 * The trailing per-row actions column. Deliberately OUTSIDE
 * {@link PROJECT_SUMMARY_COLUMNS}: that inventory is what the toolbar's sort,
 * group and options menus read, and an actions column is not a field to sort,
 * group, hide or reorder by.
 */
export const PROJECT_ROW_ACTIONS_COLUMN_ID = "rowActions";

/** Width of the column above, in px — one icon button plus its hit area. */
export const PROJECT_ROW_ACTIONS_COLUMN_WIDTH_PX = 48;
