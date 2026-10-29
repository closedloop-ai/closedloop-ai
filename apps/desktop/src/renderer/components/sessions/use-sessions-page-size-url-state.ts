import { TABLE_PAGE_SIZE_OPTIONS_EXTENDED } from "@closedloop-ai/design-system/components/ui/table-page-size-select";
import {
  normalizeSessionsPageSize,
  parseSessionsPageSizeParam,
  writeSessionsPageParam,
  writeSessionsPageSizeParam,
} from "@repo/app/agents/lib/session-pagination";
import { useCallback, useEffect, useRef } from "react";
import { PAGE_SIZE } from "./sessions-render-model";

const SESSIONS_URL_PAGE_SIZE_OPTIONS = TABLE_PAGE_SIZE_OPTIONS_EXTENDED;

/**
 * URL-backed rows-per-page state for the Desktop Sessions v2 host.
 *
 * The shared surface calls `onPageSizeChange` before it reports the page reset,
 * so the selected size is staged in a ref and written by the same list-URL
 * replace as the reset instead of issuing a second replace from the stale URL.
 * The URL accepts the full shared ladder; `SessionsView` resolves the actual
 * read size through the current flag-gated ladder before it reaches the query.
 */
export function useSessionsPageSizeUrlState({
  searchParams,
}: {
  searchParams: Pick<URLSearchParams, "getAll">;
}) {
  const selectedPageSize = parseSessionsPageSizeParam(
    searchParams,
    SESSIONS_URL_PAGE_SIZE_OPTIONS,
    PAGE_SIZE
  );
  const pendingPageSizeRef = useRef<number | null>(null);
  const pageSizeForUrlRef = useRef(selectedPageSize);

  useEffect(() => {
    pageSizeForUrlRef.current = selectedPageSize;
  }, [selectedPageSize]);

  const stagePageSizeChange = useCallback((nextPageSize: number) => {
    pendingPageSizeRef.current = normalizeSessionsPageSize(
      nextPageSize,
      SESSIONS_URL_PAGE_SIZE_OPTIONS,
      pageSizeForUrlRef.current
    );
  }, []);

  const writePageWithPageSize = useCallback(
    (params: URLSearchParams, pageIndex: number, effectivePageSize: number) => {
      writeSessionsPageParam(params, pageIndex);
      writeSessionsPageSizeParam(
        params,
        pendingPageSizeRef.current ?? effectivePageSize,
        PAGE_SIZE
      );
    },
    []
  );

  const settlePageSizeWrite = useCallback(() => {
    if (pendingPageSizeRef.current !== null) {
      pageSizeForUrlRef.current = pendingPageSizeRef.current;
    }
    pendingPageSizeRef.current = null;
  }, []);

  return {
    selectedPageSize,
    settlePageSizeWrite,
    stagePageSizeChange,
    writePageWithPageSize,
  };
}
