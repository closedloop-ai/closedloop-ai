"use client";

import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback } from "react";
import type { SortDirection } from "../lib/table-utils";
import { useViewStatePersistence } from "./use-view-state-persistence";

type SortState<TColumn extends string> = {
  column: TColumn;
  direction: SortDirection;
};

type UseSortParamsConfig<TColumn extends string> = {
  defaultColumn: TColumn | null;
  defaultDirection?: SortDirection;
  paramPrefix?: string;
  validColumns: readonly TColumn[];
  persistenceKey?: string;
};

type UseSortParamsResult<TColumn extends string> = {
  sortBy: TColumn | null;
  sortDir: SortDirection;
  setSort: (column: TColumn, direction: SortDirection) => void;
  clearSort: () => void;
  clearPersistedSort: () => void;
};

export function useSortParams<TColumn extends string = string>(
  config: UseSortParamsConfig<TColumn>
): UseSortParamsResult<TColumn> {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();

  const prefix = config.paramPrefix ?? "";
  const byKey = `${prefix}sortBy`;
  const dirKey = `${prefix}sortDir`;

  const [savedSort, setSavedSort, clearPersistedSort] =
    useViewStatePersistence<SortState<TColumn> | null>(
      config.persistenceKey ?? null,
      null,
      {
        validate: (data) => {
          if (
            data === null ||
            !config.validColumns.includes(data.column) ||
            (data.direction !== "asc" && data.direction !== "desc")
          ) {
            return null;
          }
          return data;
        },
      }
    );

  const rawFromUrl = searchParams.get(byKey);
  const urlSortBy =
    rawFromUrl !== null && config.validColumns.includes(rawFromUrl as TColumn)
      ? (rawFromUrl as TColumn)
      : null;

  const rawDir = searchParams.get(dirKey);
  const urlSortDir: SortDirection | null =
    rawDir === "asc" || rawDir === "desc" ? rawDir : null;

  const persistedSort = config.persistenceKey ? savedSort : null;
  const sortBy =
    urlSortBy ?? persistedSort?.column ?? config.defaultColumn ?? null;

  // When the URL specifies a sort column, ignore the saved direction so the
  // URL params are self-consistent. Otherwise fall back to saved, then default.
  const savedDirection =
    urlSortBy === null ? persistedSort?.direction : undefined;
  const sortDir: SortDirection =
    urlSortDir ?? savedDirection ?? config.defaultDirection ?? "desc";

  const setSort = useCallback(
    (column: TColumn, direction: SortDirection) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(byKey, column);
      params.set(dirKey, direction);
      const qs = params.toString();
      navigation.replace(qs ? `${pathname}?${qs}` : pathname, {
        scroll: false,
      });
      setSavedSort({ column, direction });
    },
    [navigation, pathname, searchParams, byKey, dirKey, setSavedSort]
  );

  const clearSort = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(byKey);
    params.delete(dirKey);
    const qs = params.toString();
    navigation.replace(qs ? `${pathname}?${qs}` : pathname, {
      scroll: false,
    });
    clearPersistedSort();
  }, [navigation, pathname, searchParams, byKey, dirKey, clearPersistedSort]);

  return { sortBy, sortDir, setSort, clearSort, clearPersistedSort };
}
