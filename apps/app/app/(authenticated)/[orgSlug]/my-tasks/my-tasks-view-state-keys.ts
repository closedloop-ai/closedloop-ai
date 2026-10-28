"use client";

import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";

/**
 * BASE persisted view-state keys for My Tasks, and the one hook that resolves
 * them (ISS-9726).
 *
 * Hoisted out of `page.tsx` for the reason `documents-index-keys.ts` was
 * hoisted out of its view: the sort key was written out at THREE call sites in
 * that file, so a rename could reach two of them and silently split one
 * reader's sort across two stored values. One definition, one resolution.
 *
 * Base, not final: `useViewStateKey` applies the active organization's
 * namespace, so none of these literals is the string that reaches
 * `localStorage`. Addressing one directly writes to the un-namespaced key every
 * organization shares — which is the defect this module exists to close: the
 * filters payload persists assignee and tag UUIDs, so a filter carried out of
 * one organization names people and tags the next one does not have, and
 * matches nothing there while the chip still counts them.
 */
const MY_TASKS_COLUMN_VISIBILITY_KEY = "table:columns:my-tasks";
const MY_TASKS_COLUMN_ORDER_KEY = "table:column-order:my-tasks";
const MY_TASKS_SEARCH_KEY = "table:search:my-tasks";
const MY_TASKS_SCROLL_KEY = "table:scroll:my-tasks";
const MY_TASKS_SORT_KEY = "table:sort:my-tasks";
const MY_TASKS_FILTERS_KEY = "table:filters:my-tasks";
const MY_TASKS_EXPANSION_KEY = "my-tasks-artifacts";

export type MyTasksViewStateKeys = {
  columnVisibility: string | null;
  columnOrder: string | null;
  search: string | null;
  scroll: string | null;
  sort: string | null;
  filters: string | null;
  expansion: string | null;
};

/**
 * Every persisted My Tasks view-state key that names an entity or narrows a
 * population, namespaced by the signed-in identity. A `null` member means that
 * value is held in memory for this render — the identity has not resolved, so
 * there is no key it can honestly be written under.
 *
 * `table:groupByStatus:my-tasks` and `my-tasks-view` are deliberately absent:
 * both persist a DISPLAY MODE (how to group, which of list/card/kanban), which
 * names nothing organization-scoped and hides no rows, so carrying one between
 * organizations tells the reader nothing untrue.
 */
export function useMyTasksViewStateKeys(): MyTasksViewStateKeys {
  return {
    columnVisibility: useViewStateKey(MY_TASKS_COLUMN_VISIBILITY_KEY),
    columnOrder: useViewStateKey(MY_TASKS_COLUMN_ORDER_KEY),
    search: useViewStateKey(MY_TASKS_SEARCH_KEY),
    scroll: useViewStateKey(MY_TASKS_SCROLL_KEY),
    sort: useViewStateKey(MY_TASKS_SORT_KEY),
    filters: useViewStateKey(MY_TASKS_FILTERS_KEY),
    expansion: useViewStateKey(MY_TASKS_EXPANSION_KEY),
  };
}
