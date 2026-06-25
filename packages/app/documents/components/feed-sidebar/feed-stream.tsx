"use client";

import { Fragment, useMemo, useRef } from "react";
import { useCommentPermalink } from "./comment-permalink-context";
import {
  ACTIVE_KIND_ALL,
  FeedFilterSort,
  useFeedFilter,
} from "./feed-filter-context";
import type { FeedItem } from "./feed-item";
import { useFeedSources } from "./feed-sources-context";
import { useAllSourceItems } from "./source-items-registry";
import { useThreadPermalinkScroll } from "./use-thread-permalink-scroll";

type MergedEntry = {
  item: FeedItem;
  rendered: React.ReactNode;
};

/**
 * Merged + sorted feed renderer. Reads items from the
 * `SourceItemsContext` registry — never calls `source.useItems()`
 * directly (see rules-of-hooks discipline in `feed-source.ts`).
 *
 * Mounted inside the `FeedRuntime`'s `<Suspense>` boundary so any
 * suspending source replaces the entire merged stream with the fallback
 * until items resolve.
 *
 * Source-agnostic: per-source banners (e.g. Liveblocks "Comment not
 * found") are surfaced via the source's optional `StatusBanner` slot,
 * rendered above the stream for every active source. The banner owns
 * its own visibility logic.
 */
export function FeedStream() {
  const sources = useFeedSources();
  const registry = useAllSourceItems();
  const { activeKind, sort, getSourceState, isFiltered, clearFilter } =
    useFeedFilter();
  const { scrollToThreadId, onPermalinkResolved } = useCommentPermalink();
  const containerRef = useRef<HTMLOListElement | null>(null);

  const merged = useMemo<MergedEntry[]>(() => {
    const out: MergedEntry[] = [];
    for (const source of sources) {
      if (activeKind !== ACTIVE_KIND_ALL && source.kind !== activeKind) {
        continue;
      }
      const registered = registry.get(source.id);
      if (registered === undefined) {
        continue;
      }
      const state = getSourceState(source.id) ?? source.defaultFilterState;
      const filtered = source.applyFilter(registered.result.items, state);
      for (const item of filtered) {
        out.push({ item, rendered: source.renderItem(item) });
      }
    }
    const direction = sort === FeedFilterSort.Newest ? -1 : 1;
    out.sort((a, b) => {
      const diff =
        direction * (a.item.createdAt.getTime() - b.item.createdAt.getTime());
      if (diff !== 0) {
        return diff;
      }
      // Stable cross-source tiebreaker keyed on source id then item id —
      // guarantees deterministic ordering when two items from different
      // sources land on the same createdAt millisecond.
      if (a.item.sourceId !== b.item.sourceId) {
        return a.item.sourceId.localeCompare(b.item.sourceId);
      }
      return a.item.id.localeCompare(b.item.id);
    });
    return out;
  }, [sources, registry, activeKind, sort, getSourceState]);

  const visibleIds = useMemo(() => {
    const next = new Set<string>();
    for (const { item } of merged) {
      next.add(item.id);
    }
    return next;
  }, [merged]);

  const hasItem = useMemo(
    () => (id: string) => visibleIds.has(id),
    [visibleIds]
  );

  // Permalink scroll-to-thread. Today only Liveblocks contributes a
  // permalink target — `hasItem` covers every source's items by id, so
  // the hook stays generic.
  useThreadPermalinkScroll({
    containerRef,
    hasThread: hasItem,
    onResolved: onPermalinkResolved,
    targetThreadId: scrollToThreadId ?? null,
    threadsReady: true,
  });

  const banners = (
    <>
      {sources.map((source) => {
        const Banner = source.StatusBanner;
        if (Banner === undefined) {
          return null;
        }
        return (
          <Fragment key={source.id}>
            <Banner />
          </Fragment>
        );
      })}
    </>
  );

  if (merged.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {banners}
        {isFiltered ? (
          <FilteredEmptyState onClear={clearFilter} />
        ) : (
          <UnfilteredEmptyState />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {banners}
      <ol className="flex flex-col gap-4 p-3" ref={containerRef}>
        {merged.map(({ item, rendered }) => (
          <li key={`${item.sourceId}:${item.id}`}>{rendered}</li>
        ))}
      </ol>
    </div>
  );
}

function FilteredEmptyState({ onClear }: Readonly<{ onClear: () => void }>) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
      <div>No items match the current filter.</div>
      <button
        className="rounded border px-2 py-1 text-foreground text-xs hover:bg-muted"
        onClick={onClear}
        type="button"
      >
        Clear filter
      </button>
    </div>
  );
}

function UnfilteredEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
      <div>No items yet</div>
    </div>
  );
}
