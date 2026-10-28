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
   * Optional slot rendered *below* the merged stream by `feed-stream.tsx`
   * whenever this source is in the active source list. Used for
   * pagination affordances ("load earlier") whose newly-fetched rows sort
   * in below the existing ones under the default newest-first sort — the
   * control and its result then sit at the same end of the stream. Renders
   * nothing when the source has no footer state to surface; the source
   * owns the conditional internally so the stream stays source-agnostic.
   */
  Footer?: ComponentType;

  /**
   * Renders one thread-root item. The source denormalizes replies into
   * the item shape, so this renderer is responsible for the entire card
   * including any reply UI.
   */
  renderItem: (item: TItem) => ReactNode;

  /**
   * Optional per-source overrides for the feed-stream's loading, error,
   * and empty state copy. `feed-stream.tsx` renders these strings when
   * this source is the one driving the active loading/error/empty state.
   * Omit any field (or the whole object) to keep the framework's default
   * source-neutral wording ("Loading feed...", "Unable to load this feed").
   *
   * FEA-3875: a source can supply stateCopy to show its own wording (e.g.
   * "Loading activity…") in place of the neutral default.
   */
  stateCopy?: {
    loading?: string;
    error?: string;
    empty?: string;
  };
};

/** Reads one source's stored filter state (`FeedFilterContextValue.getSourceState`). */
export type FeedSourceStateReader = <T>(sourceId: string) => T | undefined;

/** Stores one source's filter state (`FeedFilterContextValue.setSourceState`). */
export type FeedSourceStateWriter = <T>(sourceId: string, next: T) => void;

/** One item that passed its source's filter, with that source's renderer. */
export type FeedSourceEntry = {
  item: FeedItem;
  render: () => ReactNode;
};

/** What one mounted source publishes into the items registry. */
export type FeedSourceItems = {
  result: FeedSourceUseItemsResult<FeedItem>;
  select: (readState: FeedSourceStateReader) => readonly FeedSourceEntry[];
};

/**
 * A `FeedSource` with its item and filter types hidden, as the runtime,
 * filter bar, stream and filter context hold a heterogeneous list of them.
 * Built by `eraseFeedSource`. `FeedSource` is invariant in both type
 * parameters, so no single instantiation covers every source; instead each
 * operation that consumes a `TItem` or `TFilter` is a closure over the typed
 * source, and an item only ever reaches the `applyFilter` / `renderItem` of
 * the source whose `useItems` produced it.
 */
export type AnyFeedSource = Pick<
  FeedSource,
  | "id"
  | "kind"
  | "label"
  | "Icon"
  | "Composer"
  | "StatusBanner"
  | "Footer"
  | "stateCopy"
> & {
  defaultFilterState: unknown;
  useItems: () => FeedSourceItems;
  isFiltered: (readState: FeedSourceStateReader) => boolean;
  renderFilterControl: (
    readState: FeedSourceStateReader,
    writeState: FeedSourceStateWriter
  ) => ReactNode;
};
