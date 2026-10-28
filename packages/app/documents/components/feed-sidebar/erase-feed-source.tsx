"use client";

import { useMemo } from "react";
import type { FeedItem } from "./feed-item";
import type {
  AnyFeedSource,
  FeedSource,
  FeedSourceItems,
  FeedSourceStateReader,
} from "./feed-source";

/**
 * Hides a source's item and filter types so it can sit in a heterogeneous
 * `AnyFeedSource[]`. Callers memoize the resulting array exactly as they
 * memoized the raw sources.
 */
export function eraseFeedSource<TItem extends FeedItem, TFilter>(
  source: FeedSource<TItem, TFilter>
): AnyFeedSource {
  const readFilter = (readState: FeedSourceStateReader): TFilter =>
    readState<TFilter>(source.id) ?? source.defaultFilterState;

  function useSourceItems(): FeedSourceItems {
    const result = source.useItems();
    return useMemo(
      () => ({
        result,
        select: (readState: FeedSourceStateReader) =>
          source
            .applyFilter(result.items, readFilter(readState))
            .map((item) => ({ item, render: () => source.renderItem(item) })),
      }),
      [result]
    );
  }

  const { FilterControl } = source;
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    Icon: source.Icon,
    Composer: source.Composer,
    StatusBanner: source.StatusBanner,
    Footer: source.Footer,
    stateCopy: source.stateCopy,
    defaultFilterState: source.defaultFilterState,
    useItems: useSourceItems,
    isFiltered: (readState) => source.isFiltered(readFilter(readState)),
    renderFilterControl: (readState, writeState) =>
      FilterControl === undefined ? null : (
        <FilterControl
          onChange={(next) => writeState(source.id, next)}
          state={readFilter(readState)}
        />
      ),
  };
}
