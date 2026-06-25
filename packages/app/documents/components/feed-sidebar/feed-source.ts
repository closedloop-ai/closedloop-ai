import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { FeedItem, FeedItemKind } from "./feed-item";

export type FeedSourceUseItemsResult<TItem extends FeedItem = FeedItem> = {
  items: readonly TItem[];
  isLoading: boolean;
  isError: boolean;
};

/**
 * Contract for a heterogeneous data producer mounted inside the feed
 * sidebar. Each source owns: its items hook, a filter-state schema, a
 * pure filter function, optional in-bar filter UI, optional composer,
 * and a per-item renderer.
 *
 * **Runtime mounting rule (critical).** `useItems()` MUST NOT be called
 * from a loop or conditional branch — doing so violates React's
 * rules-of-hooks the moment the source list or `activeKind` changes,
 * and a Liveblocks suspending hook called from a parent component will
 * not be caught by a `<Suspense>` declared in that same component.
 *
 * The required pattern: one stable child component per source, mounted
 * unconditionally and keyed by `source.id`. Each child calls
 * `useItems()` exactly once and publishes its result into the
 * `SourceItemsContext` registry. Both `feed-stream.tsx` and
 * `feed-filter-bar.tsx` read items + counts from the registry. The
 * runtime wraps the registry in a single `<Suspense>` boundary that
 * catches any suspending source.
 */
export type FeedSource<TItem extends FeedItem = FeedItem, TFilter = unknown> = {
  id: string;
  kind: FeedItemKind;
  label: string;
  Icon: LucideIcon;

  useItems: () => FeedSourceUseItemsResult<TItem>;

  defaultFilterState: TFilter;
  applyFilter: (
    items: readonly TItem[],
    filterState: TFilter
  ) => readonly TItem[];
  isFiltered: (filterState: TFilter) => boolean;

  /**
   * Optional sub-filter rendered inside the feed-filter-bar slot when
   * this source's `kind` is the active filter kind.
   */
  FilterControl?: ComponentType<{
    state: TFilter;
    onChange: (next: TFilter) => void;
  }>;

  /**
   * Sticky bottom composer. Rendered only when exactly one source is in
   * the active source list (single-artifact contexts).
   */
  Composer?: ComponentType;

  /**
   * Optional non-blocking banner rendered above the merged stream by
   * `feed-stream.tsx` whenever this source is in the active source
   * list. Used by the Liveblocks source for the "Comment not found"
   * permalink banner. Renders nothing when the source has no banner
   * state to surface; the source owns the conditional internally so
   * the stream stays source-agnostic.
   */
  StatusBanner?: ComponentType;

  /**
   * Renders one thread-root item. The source denormalizes replies into
   * the item shape, so this renderer is responsible for the entire card
   * including any reply UI.
   */
  renderItem: (item: TItem) => ReactNode;
};

/**
 * Type-erased source alias used by the runtime + filter context where
 * the concrete item / filter shapes don't matter. Each source's own
 * `applyFilter` and `renderItem` are only called via that source's own
 * reference, so the `any` here doesn't leak unsafe access outside the
 * registry boundary.
 */
// biome-ignore lint/suspicious/noExplicitAny: type-erased source alias for the runtime registry; concrete sources retain their TItem/TFilter generics
export type AnyFeedSource = FeedSource<any, any>;
