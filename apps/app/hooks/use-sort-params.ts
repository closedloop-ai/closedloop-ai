"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import type { SortDirection } from "@/lib/table-utils";

type UseSortParamsConfig<TColumn extends string> = {
  defaultColumn: TColumn | null;
  defaultDirection?: SortDirection;
  paramPrefix?: string;
  validColumns: readonly TColumn[];
};

type UseSortParamsResult<TColumn extends string> = {
  sortBy: TColumn | null;
  sortDir: SortDirection;
  setSort: (column: TColumn, direction: SortDirection) => void;
  clearSort: () => void;
};

export function useSortParams<TColumn extends string = string>(
  config: UseSortParamsConfig<TColumn>
): UseSortParamsResult<TColumn> {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const prefix = config.paramPrefix ?? "";
  const byKey = `${prefix}sortBy`;
  const dirKey = `${prefix}sortDir`;

  const rawFromUrl = searchParams.get(byKey);
  const urlSortBy =
    rawFromUrl !== null && config.validColumns.includes(rawFromUrl as TColumn)
      ? (rawFromUrl as TColumn)
      : null;
  const sortBy = urlSortBy ?? config.defaultColumn ?? null;

  const rawDir = searchParams.get(dirKey);
  const sortDir: SortDirection =
    rawDir === "asc" || rawDir === "desc"
      ? rawDir
      : (config.defaultDirection ?? "desc");

  const setSort = useCallback(
    (column: TColumn, direction: SortDirection) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(byKey, column);
      params.set(dirKey, direction);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, byKey, dirKey]
  );

  const clearSort = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(byKey);
    params.delete(dirKey);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams, byKey, dirKey]);

  return { sortBy, sortDir, setSort, clearSort };
}
