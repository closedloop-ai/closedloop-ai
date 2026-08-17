"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { AlertCircleIcon, LoaderCircleIcon } from "lucide-react";
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
  const activeSourceStatus = useMemo(() => {
    let hasError = false;
    let isLoading = false;
    // Copy for the state currently being surfaced comes from the source
    // that drives it (the first loading/erroring source). Defaults to the
    // comments wording when a source omits `stateCopy` (see feed-source.ts).
    // The empty override has no single driving source, so take the first
    // active source's `stateCopy.empty` (single-artifact contexts have one
    // source; multi-source contexts fall back to the neutral default).
    let loadingCopy: string | undefined;
    let errorCopy: string | undefined;
    let emptyCopy: string | undefined;

    for (const source of sources) {
      if (activeKind !== ACTIVE_KIND_ALL && source.kind !== activeKind) {
        continue;
      }
      emptyCopy ??= source.stateCopy?.empty;
      const registered = registry.get(source.id);
      if (registered === undefined || registered.result.isLoading) {
        isLoading = true;
        loadingCopy ??= source.stateCopy?.loading;
        continue;
      }
      if (registered.result.isError) {
        hasError = true;
        errorCopy ??= source.stateCopy?.error;
      }
    }

    return {
      hasError,
      isLoading,
      isReady: !(hasError || isLoading),
      loadingCopy: loadingCopy ?? DEFAULT_LOADING_COPY,
      errorCopy: errorCopy ?? DEFAULT_ERROR_COPY,
      emptyCopy: emptyCopy ?? DEFAULT_EMPTY_COPY,
    };
  }, [sources, registry, activeKind]);

  // Permalink scroll-to-thread. `hasItem` covers every source's items
  // by id, and readiness waits for active async sources before showing
  // a missing-thread state. Failed sources are not ready: a load error
  // cannot prove the permalink target is absent.
  useThreadPermalinkScroll({
    containerRef,
    hasThread: hasItem,
    onResolved: onPermalinkResolved,
    targetThreadId: scrollToThreadId ?? null,
    threadsReady: activeSourceStatus.isReady,
  });

  const isSourceActive = useMemo(
    () => (kind: FeedItem["kind"]) =>
      activeKind === ACTIVE_KIND_ALL || kind === activeKind,
    [activeKind]
  );

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

  const footers = (
    <>
      {sources.map((source) => {
        const Footer = source.Footer;
        if (Footer === undefined || !isSourceActive(source.kind)) {
          return null;
        }
        return (
          <Fragment key={source.id}>
            <Footer />
          </Fragment>
        );
      })}
    </>
  );

  if (merged.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {banners}
        {renderEmptyContent({
          emptyCopy: activeSourceStatus.emptyCopy,
          errorCopy: activeSourceStatus.errorCopy,
          hasError: activeSourceStatus.hasError,
          isFiltered,
          isLoading: activeSourceStatus.isLoading,
          loadingCopy: activeSourceStatus.loadingCopy,
          onClearFilter: clearFilter,
        })}
        {footers}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {banners}
      {activeSourceStatus.hasError ? (
        <FeedErrorBanner errorCopy={activeSourceStatus.errorCopy} />
      ) : null}
      <ol className="flex flex-col gap-4 p-3" ref={containerRef}>
        {merged.map(({ item, rendered }) => (
          <li key={`${item.sourceId}:${item.id}`}>{rendered}</li>
        ))}
      </ol>
      {footers}
    </div>
  );
}

function renderEmptyContent({
  emptyCopy,
  errorCopy,
  hasError,
  isFiltered,
  isLoading,
  loadingCopy,
  onClearFilter,
}: Readonly<{
  emptyCopy: string;
  errorCopy: string;
  hasError: boolean;
  isFiltered: boolean;
  isLoading: boolean;
  loadingCopy: string;
  onClearFilter: () => void;
}>) {
  if (hasError) {
    return <FeedErrorState errorCopy={errorCopy} />;
  }
  if (isLoading) {
    return <FeedLoadingState loadingCopy={loadingCopy} />;
  }
  if (isFiltered) {
    return <FilteredEmptyState onClear={onClearFilter} />;
  }
  return <UnfilteredEmptyState emptyCopy={emptyCopy} />;
}

function FeedErrorBanner({ errorCopy }: Readonly<{ errorCopy: string }>) {
  return (
    <div className="px-3 pt-3">
      <FeedErrorAlert errorCopy={errorCopy} />
    </div>
  );
}

function FeedErrorState({ errorCopy }: Readonly<{ errorCopy: string }>) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <FeedErrorAlert errorCopy={errorCopy} />
    </div>
  );
}

function FeedErrorAlert({ errorCopy }: Readonly<{ errorCopy: string }>) {
  return (
    <Alert className="max-w-sm" variant="destructive">
      <AlertCircleIcon className="h-4 w-4" />
      <AlertTitle>{errorCopy}</AlertTitle>
      <AlertDescription>Try loading this feed again.</AlertDescription>
    </Alert>
  );
}

function FeedLoadingState({ loadingCopy }: Readonly<{ loadingCopy: string }>) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
      <LoaderCircleIcon className="h-4 w-4 animate-spin" />
      <div>{loadingCopy}</div>
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

function UnfilteredEmptyState({ emptyCopy }: Readonly<{ emptyCopy: string }>) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
      <div>{emptyCopy}</div>
    </div>
  );
}

// Default state copy is source-neutral ("this feed") so a multi-source feed
// (comments + activity) never shows comments-only wording when a source omits
// `stateCopy` (see FeedSource.stateCopy in feed-source.ts). A source can still
// override any of these via `stateCopy`.
const DEFAULT_LOADING_COPY = "Loading feed...";
const DEFAULT_ERROR_COPY = "Unable to load this feed";
const DEFAULT_EMPTY_COPY = "No items yet";
