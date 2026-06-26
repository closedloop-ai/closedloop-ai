"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCommentPermalink } from "./comment-permalink-context";
import type { FeedItemKind } from "./feed-item";
import { useFeedSources } from "./feed-sources-context";

export const FeedFilterVersionOfOrigin = {
  All: "all",
  Current: "current",
  Prior: "prior",
} as const;
export type FeedFilterVersionOfOrigin =
  (typeof FeedFilterVersionOfOrigin)[keyof typeof FeedFilterVersionOfOrigin];

/**
 * User-facing comment categories used by the Liveblocks source's
 * sub-filter dropdown. Re-exported from this barrel so the source can
 * import alongside its other filter primitives without duplicating the
 * enum.
 */
export const FeedFilterCommentType = {
  All: "all",
  Anchored: "anchored",
  DocumentLevel: "document-level",
} as const;
export type FeedFilterCommentType =
  (typeof FeedFilterCommentType)[keyof typeof FeedFilterCommentType];

export const FeedFilterSort = {
  Newest: "newest",
  Oldest: "oldest",
} as const;
export type FeedFilterSort =
  (typeof FeedFilterSort)[keyof typeof FeedFilterSort];

export const ACTIVE_KIND_ALL = "all" as const;
export type ActiveKind = FeedItemKind | typeof ACTIVE_KIND_ALL;

export type FeedFilterContextValue = {
  activeKind: ActiveKind;
  setActiveKind: (next: ActiveKind) => void;
  /**
   * Keyed by `source.id`. Sources retain their own filter-state shape;
   * the context stores them as a record and exposes typed getters.
   */
  getSourceState: <T>(sourceId: string) => T | undefined;
  setSourceState: <T>(sourceId: string, next: T) => void;
  sort: FeedFilterSort;
  setSort: (next: FeedFilterSort) => void;
  /**
   * `true` when any filter dimension (kind or any source state) differs
   * from its default. Sort is excluded.
   */
  isFiltered: boolean;
  /**
   * Resets `activeKind` to `"all"` and every source state to its source's
   * `defaultFilterState`. **Does NOT** restore `initialSourceState` — the
   * permalink auto-clear path must surface every comment regardless of
   * the historical-view seed.
   */
  clearFilter: () => void;
};

const DEFAULT_SORT = FeedFilterSort.Newest;

const NOOP_VALUE: FeedFilterContextValue = {
  activeKind: ACTIVE_KIND_ALL,
  setActiveKind: () => undefined,
  getSourceState: () => undefined,
  setSourceState: () => undefined,
  sort: DEFAULT_SORT,
  setSort: () => undefined,
  isFiltered: false,
  clearFilter: () => undefined,
};

const FeedFilterContext = createContext<FeedFilterContextValue>(NOOP_VALUE);

/**
 * Consumer hook. Returns no-op defaults outside a `FeedFilterProvider`
 * so isolated test renders and standalone source previews work without
 * wrapping.
 */
export function useFeedFilter(): FeedFilterContextValue {
  return useContext(FeedFilterContext);
}

export type FeedFilterProviderProps = {
  /**
   * Optional caller-provided initial state for any source whose default
   * isn't appropriate. Keyed by `source.id`. Used by the doc editor
   * scaffold to seed `versionFilter` for historical view. Read once on
   * provider mount.
   */
  initialSourceState?: Record<string, unknown>;
  children: ReactNode;
};

export function FeedFilterProvider({
  initialSourceState,
  children,
}: Readonly<FeedFilterProviderProps>) {
  const sources = useFeedSources();
  const { scrollToThreadId } = useCommentPermalink();
  const lastClearedFor = useRef<string | undefined>(undefined);

  const defaultPerSourceState = useMemo<Record<string, unknown>>(() => {
    const next: Record<string, unknown> = {};
    for (const s of sources) {
      next[s.id] = s.defaultFilterState;
    }
    return next;
  }, [sources]);

  // The seeded state is the per-source baseline this provider should
  // fall back to whenever the user changes kinds. It mixes each
  // source's `defaultFilterState` with any caller-provided
  // `initialSourceState` (e.g. doc-side historical view's
  // `versionFilter: N`). Captured in a ref so seeded values survive
  // kind switches even though the prop is read only once on mount.
  const initialSeedRef = useRef(initialSourceState);
  const seedState = useMemo<Record<string, unknown>>(
    () => ({
      ...defaultPerSourceState,
      ...(initialSeedRef.current ?? {}),
    }),
    [defaultPerSourceState]
  );

  const [activeKind, setActiveKindState] =
    useState<ActiveKind>(ACTIVE_KIND_ALL);
  const [sort, setSort] = useState<FeedFilterSort>(DEFAULT_SORT);
  const [perSourceState, setPerSourceState] = useState<Record<string, unknown>>(
    () => seedState
  );

  const setActiveKind = useCallback(
    (next: ActiveKind) => {
      if (activeKind === next) {
        return;
      }
      setActiveKindState(next);
      // Sub-filters are scoped to the kind selection: when the user
      // shifts focus to another kind (or back to "all"), their
      // in-kind sub-filter choices should not persist invisibly. The
      // FilterControl that exposes them only renders for the active
      // kind, so without this reset the user could land in a state
      // where filtering is applied but no UI surfaces it. Seeded
      // values (e.g. historical-mode `versionFilter`) are preserved.
      setPerSourceState(seedState);
    },
    [activeKind, seedState]
  );

  const getSourceState = useCallback(
    // The cast to `T | undefined` is the standard pattern for a generic
    // key-value accessor: state was put in via `setSourceState<T>(id, ...)`,
    // so retrieval via `getSourceState<T>(id)` returns the same T the caller
    // contributed. Outside-provider consumers see `undefined` and must
    // handle it defensively (NOOP_VALUE.getSourceState already returns
    // undefined for those).
    <T,>(sourceId: string): T | undefined =>
      (perSourceState[sourceId] ?? defaultPerSourceState[sourceId]) as
        | T
        | undefined,
    [perSourceState, defaultPerSourceState]
  );

  const setSourceState = useCallback(<T,>(sourceId: string, next: T) => {
    setPerSourceState((prev) => ({ ...prev, [sourceId]: next }));
  }, []);

  const clearFilter = useCallback(() => {
    setActiveKindState(ACTIVE_KIND_ALL);
    setPerSourceState({ ...defaultPerSourceState });
  }, [defaultPerSourceState]);

  // Permalink auto-clear: fire exactly once per permalink target so the
  // user can re-apply a filter after the permalink resolved without
  // having the effect immediately undo it.
  useEffect(() => {
    if (scrollToThreadId === undefined) {
      lastClearedFor.current = undefined;
      return;
    }
    if (lastClearedFor.current === scrollToThreadId) {
      return;
    }
    lastClearedFor.current = scrollToThreadId;
    clearFilter();
  }, [scrollToThreadId, clearFilter]);

  const isFiltered = useMemo(() => {
    if (activeKind !== ACTIVE_KIND_ALL) {
      return true;
    }
    for (const s of sources) {
      const state = perSourceState[s.id] ?? defaultPerSourceState[s.id];
      if (s.isFiltered(state)) {
        return true;
      }
    }
    return false;
  }, [activeKind, sources, perSourceState, defaultPerSourceState]);

  const value = useMemo<FeedFilterContextValue>(
    () => ({
      activeKind,
      setActiveKind,
      getSourceState,
      setSourceState,
      sort,
      setSort,
      isFiltered,
      clearFilter,
    }),
    [
      activeKind,
      setActiveKind,
      getSourceState,
      setSourceState,
      sort,
      isFiltered,
      clearFilter,
    ]
  );

  return (
    <FeedFilterContext.Provider value={value}>
      {children}
    </FeedFilterContext.Provider>
  );
}
