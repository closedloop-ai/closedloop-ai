// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list controls.

import type { SortDirection } from "./sortable-column-header";

/**
 * The domain-agnostic vocabulary the v2 toolbar menus speak (ISS-7051).
 *
 * The prototype's menus each took the artifact model directly — `columns`
 * (grid-table column descriptors carrying a `width`), `customFields`
 * (`CustomFieldDefinition`), and `metricDefinitions`
 * (`ArtifactListSummaryMetric`) — and did the "which of these are sortable /
 * groupable / visible" merging inside the menu. That is exactly the coupling
 * that cannot be promoted: a Sessions or Branches toolbar has no custom fields
 * and no artifact columns, but it has the same three menus.
 *
 * So the menus take flat option lists and the CALLER does the merging. Every
 * surface then answers the same question in its own vocabulary — "what can be
 * sorted by, and what is it called" — and the menu stays one implementation.
 */

/** One selectable field in the sort / group menus. */
export type TableFieldOption = {
  id: string;
  label: string;
};

/** One ordered sort clause. Array position is the clause's precedence. */
export type TableSortRule = {
  fieldId: string;
  direction: SortDirection;
};

/** One switch row in the options / compact-view menus. */
export type TableToggleOption = {
  key: string;
  label: string;
};

/**
 * Sort order WITHIN a group. `Custom` is the caller's own ordering (a stack
 * rank, a status pipeline order) rather than a comparison, which is why it is a
 * third value and not a boolean.
 */
export const TableGroupOrder = {
  Custom: "custom",
  Ascending: "asc",
  Descending: "desc",
} as const;
export type TableGroupOrder =
  (typeof TableGroupOrder)[keyof typeof TableGroupOrder];

/** Who a saved view belongs to. Drives the sectioning in the views menu. */
export const TableSavedViewScope = {
  Personal: "personal",
  Team: "team",
  Project: "project",
} as const;
export type TableSavedViewScope =
  (typeof TableSavedViewScope)[keyof typeof TableSavedViewScope];

export type TableSavedView = {
  id: string;
  name: string;
  scope: TableSavedViewScope;
};

/**
 * One grouping level. The toolbar supports two (primary + secondary); a level
 * whose `fieldId` is `null` is not grouping at all.
 *
 * `showEmptyGroups` is per level rather than per table: hiding empty top-level
 * groups while still showing empty subgroups is a real configuration, and the
 * prototype's two separate booleans (`showEmptyGroups` / `showEmptySubgroups`)
 * were the same thing spelled twice.
 */
export type TableGroupingLevel = {
  fieldId: string | null;
  order: TableGroupOrder;
  showEmptyGroups: boolean;
};

export type TableGroupingState = {
  primary: TableGroupingLevel;
  secondary: TableGroupingLevel;
};

/** A grouping state with nothing grouped — the menus' resting value. */
export const EMPTY_TABLE_GROUPING: TableGroupingState = {
  primary: {
    fieldId: null,
    order: TableGroupOrder.Custom,
    showEmptyGroups: false,
  },
  secondary: {
    fieldId: null,
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};

/** How many levels of `grouping` are actually grouping by something. */
export function countActiveGroupingLevels(grouping: TableGroupingState): number {
  return (
    Number(grouping.primary.fieldId !== null) +
    Number(grouping.secondary.fieldId !== null)
  );
}

/**
 * Remove the primary level. The SECONDARY level is promoted into its place
 * rather than dropped — removing "group by Status, then by Owner" should leave
 * "group by Owner", not ungroup the table entirely.
 */
export function removePrimaryGroupingLevel(
  grouping: TableGroupingState
): TableGroupingState {
  if (grouping.secondary.fieldId === null) {
    return { ...grouping, primary: EMPTY_TABLE_GROUPING.primary };
  }
  return {
    primary: grouping.secondary,
    secondary: EMPTY_TABLE_GROUPING.secondary,
  };
}

/** Swap the two levels, preserving each level's order and empty-group setting. */
export function swapGroupingLevels(
  grouping: TableGroupingState
): TableGroupingState {
  if (grouping.secondary.fieldId === null) {
    return grouping;
  }
  return { primary: grouping.secondary, secondary: grouping.primary };
}

/**
 * Set the primary field. Clearing it, or choosing the field the secondary level
 * already groups by, drops the secondary level — otherwise the table would be
 * asked to group twice by the same column, which produces one row per group.
 */
export function setPrimaryGroupingField(
  grouping: TableGroupingState,
  fieldId: string | null
): TableGroupingState {
  if (fieldId === null) {
    return EMPTY_TABLE_GROUPING;
  }
  const collides = grouping.secondary.fieldId === fieldId;
  return {
    primary: { ...grouping.primary, fieldId },
    secondary: collides ? EMPTY_TABLE_GROUPING.secondary : grouping.secondary,
  };
}

/**
 * Whether two grouping states describe the SAME arrangement.
 *
 * Beside the transition rules rather than in a surface, because "has the live
 * grouping diverged from the saved one?" is asked wherever a saved view carries
 * this state, and two surfaces answering it with two hand-written field
 * comparisons is how one of them comes to ignore a level the other honours.
 */
export function tableGroupingsEqual(
  a: TableGroupingState,
  b: TableGroupingState
): boolean {
  return (
    groupingLevelsEqual(a.primary, b.primary) &&
    groupingLevelsEqual(a.secondary, b.secondary)
  );
}

function groupingLevelsEqual(
  a: TableGroupingLevel,
  b: TableGroupingLevel
): boolean {
  return (
    a.fieldId === b.fieldId &&
    a.order === b.order &&
    a.showEmptyGroups === b.showEmptyGroups
  );
}

/** The label for `fieldId`, or `fallback` when nothing is selected or matched. */
export function resolveFieldLabel(
  options: readonly TableFieldOption[],
  fieldId: string | null,
  fallback: string
): string {
  if (fieldId === null) {
    return fallback;
  }
  return options.find((option) => option.id === fieldId)?.label ?? fallback;
}

export function appendTableSort(
  sorts: readonly TableSortRule[],
  fieldId: string,
  direction: SortDirection = "asc"
): TableSortRule[] {
  if (sorts.some((sort) => sort.fieldId === fieldId)) {
    return [...sorts];
  }
  return [...sorts, { direction, fieldId }];
}

export function removeTableSort(
  sorts: readonly TableSortRule[],
  fieldId: string
): TableSortRule[] {
  return sorts.filter((sort) => sort.fieldId !== fieldId);
}

export function setTableSortDirection(
  sorts: readonly TableSortRule[],
  fieldId: string,
  direction: SortDirection
): TableSortRule[] {
  return sorts.map((sort) =>
    sort.fieldId === fieldId ? { ...sort, direction } : sort
  );
}

/** Make a header-selected field primary while preserving the other clauses. */
export function setPrimaryTableSort(
  sorts: readonly TableSortRule[],
  fieldId: string,
  direction: SortDirection
): TableSortRule[] {
  return [
    { direction, fieldId },
    ...sorts.filter((sort) => sort.fieldId !== fieldId),
  ];
}
