"use client";

import { DOCUMENT_LIST_MAX_OFFSET } from "@repo/api/src/types/document";
import { useMyTasksCardPage } from "@repo/app/documents/hooks/use-my-tasks-card-page";
import { useTablePageSizeOptions } from "@repo/app/shared/hooks/use-table-page-size-options";
import { useViewStatePersistence } from "@repo/app/shared/hooks/use-view-state-persistence";
import { resolveListSurfacePagination } from "@repo/app/shared/lib/list-surface-pagination";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  resolveLegalTablePageSize,
} from "@repo/design-system/components/ui/table-page-size-select";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Everything whose change means "the rows the reader was paging through are
 * not the rows behind the pager any more": the term the server was sent, the
 * sort the table renders, and the organization the persisted keys are scoped
 * to. A change resets the cursor to page 0 in the SAME render, before the
 * offset is derived, so the first request after the change already asks for
 * the first page (`use-table-view-pagination.ts` takes the same approach; an
 * effect would let one request go out at the old offset first).
 */
export type DocumentsIndexPagingIdentity = {
  /** The org-namespaced page-size key; `null` while the org is unresolved. */
  pageSizeStorageKey: string | null;
  search: string | undefined;
  sortBy: string | null;
  sortDir: string;
  recencyDays?: number;
};

export type DocumentsIndexPaging = {
  /** Zero-based page the next read asks for. */
  page: number;
  /**
   * `page` strided by the size the server APPLIED to the page it was turned
   * from, not the size asked for. The envelope's `limit` is the effective size
   * after the server's clamp, so a page turned from one served narrower than
   * `pageSize` is asked for where that page ended: a version-skewed API that
   * narrows 50 to 25 would otherwise be asked for offset 50 next, and rows
   * 26–50 would never render (whitlockk review, #7568).
   */
  offset: number;
  /** The size the next read ASKS for; the server may apply a narrower one. */
  pageSize: number;
  pageSizeOptions: readonly number[];
  /**
   * Whether `pageSize` is the size this reader should be read at. False only
   * while the `table-page-size-ladder` flag is resolving (ISS-9692); a read
   * keyed on the size must wait for it.
   */
  isPageSizeReady: boolean;
  setPage: (page: number) => void;
  /**
   * Turn to `page`, strided by `servedPageSize` — the size the server applied
   * to the page on screen, which the pager reads off its envelope.
   */
  onPageChange: (page: number, servedPageSize: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

export function useDocumentsIndexPaging({
  identity,
  scrollContainer,
}: {
  identity: DocumentsIndexPagingIdentity;
  scrollContainer: HTMLElement | null;
}): DocumentsIndexPaging {
  // Read whatever the ladder gate says (the ISS-9692 stale-value contract): a
  // stored 500 resolves to the largest rung still offered rather than to the
  // default, and the write below is what the gate controls.
  const [persistedPageSize, setPersistedPageSize] =
    useViewStatePersistence<number>(
      identity.pageSizeStorageKey,
      DEFAULT_TABLE_PAGE_SIZE
    );
  // The size chosen this visit, keyed to the organization it was chosen in:
  // the persisted read above re-keys the moment the org changes, and an
  // unkeyed override would outrank it and carry one org's choice into the
  // next org's first request (davetho review, #7568).
  const [visitPageSize, setVisitPageSize] = useState<VisitPageSize | null>(
    null
  );
  const visitPageSizeForOrg =
    visitPageSize?.storageKey === identity.pageSizeStorageKey
      ? visitPageSize.pageSize
      : null;
  const {
    isExtendedLadderEnabled,
    isReady: isPageSizeReady,
    options: pageSizeOptions,
    pageSize,
  } = useTablePageSizeOptions(visitPageSizeForOrg ?? persistedPageSize);

  // The stride the cursor was last turned at: the size the server applied to
  // the page it was turned from, captured in the turn itself. Only a turn
  // leaves page 0, and every reset returns to it, so the stride is always the
  // one the page being asked for was measured in. The requested size stands
  // in until the first turn.
  const [turnedAtPageSize, setTurnedAtPageSize] = useState<number | null>(null);
  const cursor = useMyTasksCardPage(turnedAtPageSize ?? pageSize);

  const resetKey = JSON.stringify([
    identity.pageSizeStorageKey,
    identity.search,
    identity.sortBy,
    identity.sortDir,
    identity.recencyDays,
    pageSize,
  ]);
  const previousResetKey = useRef(resetKey);
  // Whether the latest reset MOVED the cursor. Only a reset that did earns the
  // scroll-to-top below: the rows behind the pager jumped pages, so the reader's
  // offset into them is meaningless. A reset from page 0 re-reads the same
  // page and leaves the offset alone — which is also what keeps the shipped
  // unbounded arm untouched, since this hook mounts there too and that arm
  // never leaves page 0 (marisolashgrove review, #7568).
  const resetMovedCursor = useRef(false);
  const identityChanged = previousResetKey.current !== resetKey;
  if (identityChanged) {
    previousResetKey.current = resetKey;
    resetMovedCursor.current = cursor.page !== 0;
    if (cursor.page !== 0) {
      cursor.setPage(0);
    }
  }
  const page = identityChanged ? 0 : cursor.page;
  const offset = identityChanged ? 0 : cursor.offset;

  // The container's scroll element, read through a ref so the scroll-to-top
  // effect keys on the identity alone: the element mounting must not scroll,
  // or it would fight `useScrollRestore` on the way in.
  const scrollContainerRef = useRef(scrollContainer);
  scrollContainerRef.current = scrollContainer;
  const scrollToTop = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, []);
  const scrolledForResetKey = useRef(resetKey);
  useEffect(() => {
    if (scrolledForResetKey.current === resetKey) {
      return;
    }
    scrolledForResetKey.current = resetKey;
    if (resetMovedCursor.current) {
      scrollToTop();
    }
  }, [resetKey, scrollToTop]);

  const { setPage } = cursor;
  const onPageChange = useCallback(
    (nextPage: number, servedPageSize: number) => {
      setTurnedAtPageSize(Math.max(1, servedPageSize));
      setPage(nextPage);
      scrollToTop();
    },
    [setPage, scrollToTop]
  );
  const onPageSizeChange = useCallback(
    (next: number) => {
      if (resolveLegalTablePageSize(next, pageSizeOptions) === pageSize) {
        return;
      }
      setVisitPageSize({
        storageKey: identity.pageSizeStorageKey,
        pageSize: next,
      });
      // Only a gated-ON choice is durable (ISS-9692, davetho review): a
      // reader without the extended ladder still moves the control, but a
      // write from that session would destroy the value the flag exists to
      // restore. The page reset (and, off page 0, the scroll) ride on the
      // identity change.
      if (isExtendedLadderEnabled) {
        setPersistedPageSize(next);
      }
    },
    [
      pageSizeOptions,
      pageSize,
      identity.pageSizeStorageKey,
      isExtendedLadderEnabled,
      setPersistedPageSize,
    ]
  );

  return {
    page,
    offset,
    pageSize,
    pageSizeOptions,
    isPageSizeReady,
    setPage,
    onPageChange,
    onPageSizeChange,
  };
}

/**
 * Page bounds for the paged read, from the ONE owner of capped total-pages and
 * safe-page arithmetic (ISS-9225). `maxOffset` keeps every advertised page a
 * request `GET /documents` accepts (ISS-9074).
 */
export function resolveDocumentsIndexPageBounds({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}): { safePage: number; totalPages: number } {
  const { safePage, totalPages } = resolveListSurfacePagination({
    isGrouped: false,
    isServerDriven: true,
    maxOffset: DOCUMENT_LIST_MAX_OFFSET,
    page,
    pageSize: Math.max(1, pageSize),
    rows: NO_ROWS,
    serverTotalRows: Math.max(0, total),
  });
  return { safePage, totalPages };
}

/**
 * Write the cursor back down once the server's total says the requested page
 * does not exist. Runs only when the read is enabled, holds SUCCESS data, and
 * is not fetching (the Sessions `use-sessions-page-clamp` posture): a warm
 * cached total must not move the reader while the gate that keys the read is
 * still unresolved, and a total from a read still in flight is not the one
 * this page will be judged against.
 */
export function useDocumentsIndexPageClamp({
  enabled,
  hasData,
  isFetching,
  page,
  pageSize,
  setPage,
  total,
}: {
  enabled: boolean;
  hasData: boolean;
  isFetching: boolean;
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  total: number;
}): void {
  useEffect(() => {
    if (!(enabled && hasData) || isFetching) {
      return;
    }
    const { safePage } = resolveDocumentsIndexPageBounds({
      page,
      pageSize,
      total,
    });
    if (safePage !== page) {
      setPage(safePage);
    }
  }, [enabled, hasData, isFetching, page, pageSize, setPage, total]);
}

type VisitPageSize = {
  storageKey: string | null;
  pageSize: number;
};

const NO_ROWS: readonly never[] = [];
