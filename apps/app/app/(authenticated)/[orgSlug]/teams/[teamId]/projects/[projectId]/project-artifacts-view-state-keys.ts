"use client";

import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { useViewStateKey } from "@repo/app/shared/hooks/use-view-state-key";

/**
 * BASE persisted view-state keys for the project detail page's artifact tabs,
 * and the one hook that resolves them (ISS-9726).
 *
 * Hoisted out of `page.tsx` for the reason `my-tasks-view-state-keys.ts` and
 * `documents-index-keys.ts` were hoisted out of theirs: the sort key alone was
 * written out at THREE call sites across two files (the page's clear-sort
 * handle, the `DocumentsView` prop, and the pagination hook's own read), so a
 * rename could reach two of them and silently split one reader's sort across two
 * stored values.
 *
 * ## Why these are namespaced at all
 *
 * Every key here already carried `<projectId>`, and a project id is unique
 * across organizations — so they were organization-isolated before this change
 * and the first pass deliberately left them alone. That reasoning was only half
 * the threat (whitlockk, PR #6875): a project id separates ORGANIZATIONS, it does
 * not separate USERS. On a shared browser profile two accounts that both belong
 * to the same organization opened the same project and restored each other's
 * search text, filters, sort, page size, and expansion — and the filters payload
 * names teammates by UUID.
 *
 * `useViewStateKey` namespaces by the same user+organization pair the rest of
 * this surface uses, which closes the user half and leaves the organization half
 * as it already was. Base, not final: none of these strings is what reaches
 * `localStorage`.
 *
 * `table:groupByStatus:project-artifacts` and the column keys the page owns
 * directly are deliberately absent — the former persists a DISPLAY MODE (how to
 * group), which names nothing organization-scoped and hides no rows, exactly the
 * carve-out `useMyTasksViewStateKeys` documents for its own grouping key.
 */
function searchBaseKey(projectId: string): string {
  return `table:search:project-artifacts:${projectId}`;
}

function scrollBaseKey(projectId: string, category: FilterCategory): string {
  // Scoped per category — each of All/Documents/Issues/Plans/Branches renders a
  // different list, so a shared key would leak one tab's offset onto another.
  return `table:scroll:project-artifacts:${projectId}:${category}`;
}

function sortBaseKey(projectId: string): string {
  return `table:sort:project-artifacts:${projectId}`;
}

function filtersBaseKey(projectId: string): string {
  return `table:filters:project-artifacts:${projectId}`;
}

function pageSizeBaseKey(projectId: string): string {
  return `table:page-size:project-artifacts:${projectId}`;
}

function expansionBaseKey(projectId: string): string {
  return `project-artifacts:${projectId}`;
}

function boardBaseKey(projectId: string): string {
  return `project-artifacts:board:${projectId}`;
}

export type ProjectArtifactsViewStateKeys = {
  board: string | null;
  search: string | null;
  scroll: string | null;
  sort: string | null;
  filters: string | null;
  pageSize: string | null;
  expansion: string | null;
};

/**
 * Every persisted project-artifacts view-state key that names an entity or
 * narrows a population, namespaced by the signed-in identity. A `null` member
 * means that value is held in memory for this render — either the identity has
 * not resolved, or the flag itself has not resolved yet, and there is no key the
 * value can honestly be written under in the meantime.
 */
export function useProjectArtifactsViewStateKeys(
  projectId: string,
  filterCategory: FilterCategory
): ProjectArtifactsViewStateKeys {
  return {
    board: useViewStateKey(boardBaseKey(projectId)),
    search: useViewStateKey(searchBaseKey(projectId)),
    scroll: useViewStateKey(scrollBaseKey(projectId, filterCategory)),
    sort: useViewStateKey(sortBaseKey(projectId)),
    filters: useViewStateKey(filtersBaseKey(projectId)),
    pageSize: useViewStateKey(pageSizeBaseKey(projectId)),
    expansion: useViewStateKey(expansionBaseKey(projectId)),
  };
}
