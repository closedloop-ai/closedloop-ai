"use client";

import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback } from "react";

/**
 * Shared list-URL writer for FEA-3560 facet mirroring, consumed by the web and
 * desktop Sessions/Branches surfaces so the "copy params → write facets →
 * (optionally) write page → replace" glue exists once instead of per surface.
 *
 * The returned callback ALWAYS writes the given filters, so every list-URL
 * write (a filter change, a pagination click, a sort/date reset) re-asserts
 * the active facets from state. That closes the race where a page/sort click
 * lands while the previous facet replace is still reconciling into the search
 * params snapshot — copying the stale snapshot alone would silently drop the
 * facet params the previous write just added.
 *
 * Uses `replace` (not `navigate`) so list-state churn never adds history
 * entries; the URL is a restore/permalink vehicle, not a navigation log.
 *
 * The optional `clearParamKeys` are deleted from the copied snapshot before the
 * filters/page are written — for a "Clear filters" action that must also strip
 * URL-owned narrowers the facet writer doesn't manage (FEA-4181: a `?search=`
 * term that produced the empty result). Because the copy preserves any param the
 * writer doesn't touch, without this the clear would re-run the same empty
 * search. `writeFilters`/`writePage` still run after the delete, so a cleared key
 * they own would be re-asserted — only pass keys no writer owns.
 */
export function useReplaceListParams<TFilters>(
  writeFilters: (params: URLSearchParams, filters: TFilters) => void,
  writePage?: (params: URLSearchParams, pageIndex: number) => void
): (
  filters: TFilters,
  pageIndex?: number,
  clearParamKeys?: readonly string[]
) => void {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();

  return useCallback(
    (filters: TFilters, pageIndex = 0, clearParamKeys?: readonly string[]) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      for (const key of clearParamKeys ?? []) {
        nextParams.delete(key);
      }
      writeFilters(nextParams, filters);
      writePage?.(nextParams, pageIndex);
      const qs = nextParams.toString();
      navigation.replace(qs ? `${pathname}?${qs}` : pathname, {
        scroll: false,
      });
    },
    [navigation, pathname, searchParams, writeFilters, writePage]
  );
}
