import type { AgentSessionListPageInfo } from "@repo/api/src/types/agent-session-list-contract";
import { shouldRenderListPagination } from "../../../shared/lib/list-pagination-visibility";
import { resolveListSurfacePagination } from "../../../shared/lib/list-surface-pagination";
import {
  isSessionsListReadTotalKnown,
  isValidSessionsListTotal,
  SessionsListReadState,
  type SessionsListReadState as SessionsListReadStateValue,
} from "../../lib/sessions-list-read-state";
import { resolveSessionsServedPage } from "../../lib/sessions-served-page";
import { resolveSessionsFooterPagination } from "./sessions-list-surface-controls";

export function resolveSessionsListSurfaceReadState({
  controlledReadState,
  isError,
  isPending,
  isPlaceholderPage,
  isSyncing,
  isServerDriven,
  serverTotalRows,
}: {
  controlledReadState?: SessionsListReadStateValue;
  isError: boolean;
  isPending: boolean;
  isPlaceholderPage: boolean;
  isServerDriven: boolean;
  isSyncing: boolean;
  serverTotalRows?: number;
}): SessionsListReadStateValue {
  if (controlledReadState !== undefined) {
    return controlledReadState;
  }
  if (isPending) {
    return SessionsListReadState.Loading;
  }
  if (isSyncing) {
    return SessionsListReadState.Syncing;
  }
  if (isError) {
    return SessionsListReadState.Error;
  }
  if (isPlaceholderPage) {
    return SessionsListReadState.Placeholder;
  }
  if (isServerDriven && !isValidSessionsListTotal(serverTotalRows)) {
    return SessionsListReadState.Partial;
  }
  return SessionsListReadState.Settled;
}

export function resolveSessionsListSurfacePaging<TRow>({
  changePageSize,
  isGrouped,
  isPending,
  isPlaceholderPage,
  isServerDriven,
  maxOffset,
  onPageSizeChange,
  page,
  pageInfo,
  readState,
  resolvedPageSize,
  rows,
  serverTotalRows,
}: {
  changePageSize: (pageSize: number) => void;
  isGrouped: boolean;
  isPending: boolean;
  isPlaceholderPage: boolean;
  isServerDriven: boolean;
  maxOffset?: number;
  onPageSizeChange: ((pageSize: number) => void) | undefined;
  page: number;
  pageInfo?: AgentSessionListPageInfo;
  readState: SessionsListReadStateValue;
  resolvedPageSize: number;
  rows: readonly TRow[];
  serverTotalRows?: number;
}): {
  footerOnPageSizeChange: ((pageSize: number) => void) | undefined;
  footerTotalRows: number;
  isAwaitingClampedPage: boolean;
  isRangeUnsettled: boolean;
  pagedRows: readonly TRow[];
  rowsPage: number;
  safePage: number;
  showPagination: boolean;
  totalPages: number;
} {
  /*
   * ISS-9555: WHICH page the rows on screen came from is the producer's answer
   * whenever it gave one. Deriving it from `page` instead is the surface
   * guessing that its own request is what the producer honoured — correct only
   * while that holds, and silent when it does not.
   *
   * It feeds the clamp rather than bypassing it, so the footer, the body's
   * awaiting-clamp gate and the surface's report-back all read ONE page index,
   * and an echo naming a page past the population still resolves to the last
   * real one instead of stranding the reader there.
   */
  const rowsPage =
    resolveSessionsServedPage({
      expectedLimit: resolvedPageSize,
      isPlaceholderPage,
      isServerDriven,
      pageInfo,
    }) ?? page;
  const readTotalRows = isServerDriven ? serverTotalRows : rows.length;
  const validReadTotalRows = isValidSessionsListTotal(readTotalRows)
    ? readTotalRows
    : undefined;
  const hasKnownTotal = isSessionsListReadTotalKnown({
    state: readState,
    totalRows: validReadTotalRows,
  });
  const { pagedRows, safePage, totalPages } = hasKnownTotal
    ? resolveListSurfacePagination({
        isGrouped,
        isServerDriven,
        maxOffset,
        page: rowsPage,
        pageSize: resolvedPageSize,
        rows,
        serverTotalRows: validReadTotalRows,
      })
    : resolveListSurfaceUnknownTotalPagination({
        isGrouped,
        isServerDriven,
        page: rowsPage,
        pageSize: resolvedPageSize,
        rows,
      });
  // The rows on screen are not from the page about to be displayed. Read off
  // `rowsPage`, not `page`: with an echo the position is KNOWN, so a request the
  // producer answered from a different page is settled the moment the rows
  // arrive, and holding a skeleton over rows we can already place correctly is
  // the round trip the echo exists to remove. Without one, the derivation moving
  // the position while the rows still came from the request is the real window.
  const isAwaitingClampedPage =
    hasKnownTotal && isServerDriven && safePage !== rowsPage;
  const footerPagination = resolveSessionsFooterPagination({
    changePageSize,
    isAwaitingClampedPage,
    isPending,
    isServerDriven,
    onPageSizeChange,
  });
  return {
    footerOnPageSizeChange: footerPagination.onPageSizeChange,
    footerTotalRows: hasKnownTotal
      ? (validReadTotalRows ?? rows.length)
      : rows.length,
    isAwaitingClampedPage,
    isRangeUnsettled: footerPagination.isRangeUnsettled || !hasKnownTotal,
    pagedRows,
    rowsPage,
    safePage,
    showPagination: shouldRenderListPagination({
      hasPageableRows: rows.length > 0,
      isGroupedClientSide: isGrouped && !isServerDriven,
      isPagingPlaceholder: isPlaceholderPage,
    }),
    totalPages,
  };
}

function resolveListSurfaceUnknownTotalPagination<TRow>({
  isGrouped,
  isServerDriven,
  page,
  pageSize,
  rows,
}: {
  isGrouped: boolean;
  isServerDriven: boolean;
  page: number;
  pageSize: number;
  rows: readonly TRow[];
}): {
  pagedRows: readonly TRow[];
  safePage: number;
  totalPages: number;
} {
  if (isGrouped || isServerDriven) {
    return {
      pagedRows: rows,
      safePage: page,
      totalPages: Math.max(page + 1, 1),
    };
  }
  return resolveListSurfacePagination({
    isGrouped,
    isServerDriven,
    page,
    pageSize,
    rows,
  });
}
