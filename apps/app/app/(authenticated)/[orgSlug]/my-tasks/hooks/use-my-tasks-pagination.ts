"use client";

import {
  type UseTableViewPaginationInput,
  type UseTableViewPaginationResult,
  useTableViewPagination,
} from "@repo/app/documents/hooks/use-table-view-pagination";

/** Default page size for the My Tasks board (mirrors Sessions/Branches). */
export const MY_TASKS_PAGE_SIZE = 50;

export type UseMyTasksPaginationResult = UseTableViewPaginationResult;

/**
 * The My Tasks board's binding of the shared `DocumentsView` paginator
 * (ISS-4466, hoisted to `@repo/app/documents` by ISS-5307).
 *
 * All this adds is the board's own default page size. It stays a named My Tasks
 * hook rather than a bare re-export so `MY_TASKS_PAGE_SIZE` has exactly one
 * home: the board's page also imports that constant to size its card-view read,
 * and a page that sized its fetch from one constant while its list paged by
 * another would show a footer describing a different window than the one it
 * fetched.
 */
export function useMyTasksPagination(
  input: UseTableViewPaginationInput
): UseMyTasksPaginationResult {
  return useTableViewPagination({
    ...input,
    pageSize: input.pageSize ?? MY_TASKS_PAGE_SIZE,
  });
}
