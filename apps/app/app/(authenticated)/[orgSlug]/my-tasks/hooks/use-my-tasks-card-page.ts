"use client";

import {
  DOCUMENT_LIST_MAX_OFFSET,
  type DocumentListPage,
} from "@repo/api/src/types/document";
import { useEffect, useState } from "react";

export type MyTasksCardPageCursor = {
  /** Zero-based page the view is asking the server for. */
  page: number;
  setPage: (page: number) => void;
  /** The `offset` to send with the read. */
  offset: number;
};

/**
 * The page cursor for the API-paged My Tasks card board (ISS-4576).
 *
 * Split from the clamp ({@link useMyTasksCardPageBounds}) because of an ordering
 * constraint the list view's render-layer paginator does not have: the card page
 * is an INPUT to the read, so the offset must be resolved BEFORE the query runs,
 * while the total that bounds it only exists AFTER the response lands. One hook
 * that did both would have to clamp against a total it cannot have yet.
 *
 * `pageSize` floors at 1 — a 0 would make every page request offset 0 while the
 * bounds hook reported infinite pages (repo numeric guardrail: `Math.min` alone
 * does not floor).
 */
export function useMyTasksCardPage(pageSize: number): MyTasksCardPageCursor {
  const [pageInput, setPage] = useState(0);
  const page = Math.max(0, pageInput);
  return { page, setPage, offset: page * Math.max(1, pageSize) };
}

/**
 * Bound the card cursor against the server's total, once that total is known.
 *
 * While `total` is `undefined` — first load, or a refetch with no cached page —
 * no clamp happens at all. Treating an unknown total as zero would snap an
 * in-flight page 4 back to page 1 on every refetch and then request the wrong
 * window. Once a total lands and it is smaller than the current page implies
 * (rows completed, or a bookmarked page past the end), the page is written back
 * down so the next read asks for a window that exists rather than stranding the
 * viewer on a permanently empty board.
 *
 * The exposed page count is ALSO capped so the last page's offset
 * (`page * pageSize`) never exceeds the API's {@link DOCUMENT_LIST_MAX_OFFSET}
 * ceiling. Past ~10,050 assigned tasks the raw `ceil(total / pageSize)` would
 * advertise pages whose offset the route validator rejects with 400 — clicking
 * one replaced the board with its load-failed state and left the tail
 * unreachable (codex P2). Capping here keeps every advertised page a request the
 * server accepts; the residue beyond the cap is out of reach at this page size
 * regardless, so exposing an unclickable page helps no one.
 */
export function useMyTasksCardPageBounds({
  page,
  setPage,
  total,
  pageSize,
}: {
  page: number;
  setPage: (page: number) => void;
  total: number | undefined;
  pageSize: number;
}): number {
  const safePageSize = Math.max(1, pageSize);
  // The most pages we can offer before the next offset would exceed the API
  // ceiling: the last valid offset is DOCUMENT_LIST_MAX_OFFSET, so the last
  // reachable page index is floor(ceiling / pageSize), i.e. that many + 1 pages.
  const maxReachablePages =
    Math.floor(DOCUMENT_LIST_MAX_OFFSET / safePageSize) + 1;
  const knownTotalPages =
    total === undefined
      ? null
      : Math.min(
          maxReachablePages,
          Math.max(1, Math.ceil(Math.max(0, total) / safePageSize))
        );
  const lastPage = knownTotalPages === null ? null : knownTotalPages - 1;

  useEffect(() => {
    if (lastPage !== null && page > lastPage) {
      setPage(lastPage);
    }
  }, [lastPage, page, setPage]);

  return knownTotalPages ?? page + 1;
}

/**
 * `placeholderData` for the My Tasks paged read that keeps a turning page from
 * flickering WITHOUT reusing a wider window across a view switch (shafty023
 * review, ISS-4576).
 *
 * Unconditional `keepPreviousData` reused the previous envelope across the WHOLE
 * query key. That is safe for Sessions/Branches — only the offset moves between
 * their pages — but the My Tasks list and card views ask for DIFFERENT `limit`s
 * (the list requests {@link DOCUMENT_LIST_MAX_LIMIT}, the card board one screen
 * page). Switching list → card would keep the successful 500-row envelope as
 * placeholder data while the 50-row read is in flight, so the card branch
 * transiently mounted all 500 draggable cards — re-creating the exact full-set
 * render this PR fixes.
 *
 * This reuses the previous page ONLY when its effective `limit` matches the one
 * the incoming request will apply (an offset-only move within the same view). A
 * `limit` change (the view switch) drops the placeholder, so the card board
 * never mounts more than a page of cards; the offset-only page turn still holds
 * the previous page under the pagination control. The comparison is against the
 * envelope's own server-clamped `limit`, not the raw request, so a value the
 * server narrowed cannot smuggle a wider placeholder through.
 */
export function keepSamePageSizePlaceholder(
  requestedLimit: number
): (previous: DocumentListPage | undefined) => DocumentListPage | undefined {
  const safeRequestedLimit = Math.max(1, requestedLimit);
  return (previous) => {
    if (previous?.limit === safeRequestedLimit) {
      return previous;
    }
    return undefined;
  };
}
