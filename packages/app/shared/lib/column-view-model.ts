import type { TableFieldOption } from "@repo/design-system/components/ui/table-toolbar-model";

/**
 * ISS-9676 — what one list column may be ASKED to do, in the vocabulary
 * `packages/api/src/types/custom-field.ts` already uses for a custom field.
 *
 * A list surface owns three menus it does not implement: sort, group, and
 * filter all live in `ListSurfaceToolbarV2` and in `GridTableV2`'s column header
 * actions. Those components are generic by construction and therefore cannot
 * know which of a surface's columns may be ordered, banded, or narrowed on — so
 * each surface answered it by hand, at each call site, in its own spelling.
 * Sessions declares `sortable` on a column spec and a separate group table;
 * Branches declared nothing at all and simply omitted `sortGrouping`.
 *
 * This is the declaration those components read instead. A surface states the
 * capability ONCE per column and the shared controls derive their option lists
 * from it, so a column that loses `isSortable` disappears from the sort menu and
 * from its own clickable header in the same edit.
 *
 * `isSortable` / `isFilterable` are deliberately the custom-field spelling
 * rather than a fourth one: `CustomField.isSortable` is what an admin sets on a
 * field, `CUSTOM_FIELD_CAPABILITIES` is the type-level ceiling over it, and a
 * built-in column is the same question asked of a column the org did not
 * create.
 */

/**
 * The filter half, as a discriminated pair rather than two loose fields.
 *
 * A column that cannot be filtered has no facet to serve, and a column that can
 * needs one NAMED — a surface's facet vocabulary is its own and does not have to
 * equal its column ids (Branches serves the `pr` column from the `pullRequest`
 * facet). Pairing them makes "filterable, from nowhere" a compile error instead
 * of a popover entry that narrows nothing.
 */
type ColumnFilterCapability =
  | { isFilterable: false; filterFacetId: null }
  | { isFilterable: true; filterFacetId: string };

/**
 * The grouping half, paired for the same reason.
 *
 * `groupLabel` is the DIMENSION's name in the group menu, which is not always
 * the column header: a header names what the cell holds, a group option names
 * what the bands are cut by, and the two are chosen separately.
 */
type ColumnGroupCapability =
  | { isGroupable: false; groupLabel: null }
  | { isGroupable: true; groupLabel: string };

export type ColumnViewModel = {
  id: string;
  /** The column header. */
  label: string;
  isSortable: boolean;
} & ColumnFilterCapability &
  ColumnGroupCapability;

/**
 * The sort menu's options, in declaration order.
 *
 * Derived rather than hand-listed beside the menu, which is the whole point: a
 * second list is how a surface comes to offer an ordering its rows do not have.
 */
export function sortableColumnOptions(
  columns: readonly ColumnViewModel[]
): readonly TableFieldOption[] {
  return columns
    .filter((column) => column.isSortable)
    .map((column) => ({ id: column.id, label: column.label }));
}

/**
 * The group menu's options, in declaration order, each under the dimension's own
 * name rather than the column header.
 */
export function groupableColumnOptions(
  columns: readonly ColumnViewModel[]
): readonly TableFieldOption[] {
  return columns.flatMap((column) =>
    column.isGroupable ? [{ id: column.id, label: column.groupLabel }] : []
  );
}

/** Whether `columnId` is a column this surface declares as sortable. */
export function isSortableColumn(
  columns: readonly ColumnViewModel[],
  columnId: string
): boolean {
  return columns.some((column) => column.id === columnId && column.isSortable);
}

/** Whether `columnId` is a column this surface declares as filterable. */
export function isFilterableColumn(
  columns: readonly ColumnViewModel[],
  columnId: string
): boolean {
  return columns.some(
    (column) => column.id === columnId && column.isFilterable
  );
}

/** Whether `columnId` is a column this surface declares as groupable. */
export function isGroupableColumn(
  columns: readonly ColumnViewModel[],
  columnId: string
): boolean {
  return columns.some((column) => column.id === columnId && column.isGroupable);
}

/**
 * The facet ids the declared columns admit — the filter popover's allow-list.
 *
 * Null-prototype-free because the members come from this build's own
 * declaration, not from request text.
 */
export function filterableFacetIds(
  columns: readonly ColumnViewModel[]
): ReadonlySet<string> {
  return new Set(
    columns.flatMap((column) =>
      column.isFilterable ? [column.filterFacetId] : []
    )
  );
}

/**
 * Keep only the facet groups a declared column admits.
 *
 * Order is the CALLER's, not the view model's: a facet list is built with its
 * own reading order and this is an admission rule, not a re-sort.
 */
export function admitFilterableGroups<Group extends { id: string }>(
  columns: readonly ColumnViewModel[],
  groups: readonly Group[]
): Group[] {
  const admitted = filterableFacetIds(columns);
  return groups.filter((group) => admitted.has(group.id));
}
