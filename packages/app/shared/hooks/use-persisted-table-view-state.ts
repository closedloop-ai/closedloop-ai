"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalAuthSnapshot } from "../auth/use-auth-snapshot";
import { useResolvedOrDeadline } from "./use-resolved-or-deadline";

/**
 * A table view restored from persistence: the sort dimensions, the hidden-column
 * ids, and the feature-specific "extra" dimensions (date range, grouping, metric
 * mode, reveal toggles, …). `extras` is opaque to the generic hook — each feature
 * hook owns its shape via {@link PersistedTableViewConfig.parse}.
 */
export type RestoredTableView<TSort, TSortDir, TExtra> = {
  sortKey: TSort;
  sortDir: TSortDir;
  hiddenColumns: string[];
  /**
   * FEA-4021: persisted data-column order (ids). Optional so a feature that does
   * not persist order (or an older saved view predating the field) degrades to
   * the table's natural column order.
   */
  columnOrder?: string[];
  /**
   * FEA-4168: persisted per-column widths (px), keyed by data-column id.
   * Optional so a feature that does not persist widths (or an older saved view
   * predating the field) degrades to the table's natural column widths.
   */
  columnWidths?: Record<string, number>;
  extras: TExtra;
};

export type PersistedTableViewConfig<
  TSort,
  TSortDir,
  TColumnId extends string,
  TExtra,
> = {
  /** Surface key; when omitted the view is memory-only (no persistence). */
  persistKey?: string;
  /** localStorage key namespace, e.g. `"sessions:saved-view:"`. */
  keyPrefix: string;
  /**
   * All toggleable column ids. Pass a stable (module-level) reference so the
   * derived `visibleColumns` memo does not churn on every render.
   */
  columnIds: readonly TColumnId[];
  /**
   * ISS-5315: column ids a NEVER-SAVED view starts with hidden, and the set
   * `resetColumns` restores to. Pass a stable (module-level) reference.
   *
   * It is deliberately NOT applied on top of a restored view: once a user has a
   * saved view, their `hiddenColumns` is the whole truth about what they hid or
   * showed, so a column they deliberately turned ON is never turned back off by
   * a later change to this default. Omit for "everything visible", the prior
   * behavior every existing caller keeps.
   */
  defaultHiddenColumns?: readonly TColumnId[];
  defaultSortKey: TSort;
  defaultSortDir: TSortDir;
  /** The two sort directions `toggleSortDir` flips between. */
  sortDirs: readonly [TSortDir, TSortDir];
  defaultExtras: TExtra;
  /**
   * Validate an already-JSON-parsed value into a restored view, or `null` when
   * it is missing/malformed. Pass a stable (module-level) function reference.
   */
  parse: (raw: unknown) => RestoredTableView<TSort, TSortDir, TExtra> | null;
};

/**
 * The inputs the restore keys on: the resolved storage key and the parser.
 * Either changing means the stored bytes decode to a different view, so the
 * restore must run again (see `restoredInputsRef` / `committedRestoreInputs`).
 */
type RestoreInputs<TSort, TSortDir, TExtra> = {
  storageKey: string | null;
  parse: (raw: unknown) => RestoredTableView<TSort, TSortDir, TExtra> | null;
};

/**
 * How long a surface gating a data request on `isViewReady` waits for auth to
 * hydrate before proceeding on the DEFAULT view (ISS-4655).
 *
 * `authLoaded` is the one input to `isViewReady` that can stall indefinitely: if
 * Clerk never initializes it stays false forever. {@link useResolvedOrDeadline}
 * carries the mechanism and the reasoning; this is only the duration, kept
 * separate from FEA-1626's `FEATURE_FLAG_RESOLUTION_DEADLINE_MS` because the two
 * answer to different services and should be tunable apart, even though both are
 * 3s today.
 */
export const VIEW_RESTORE_AUTH_DEADLINE_MS = 3000;

function loadRestoredView<TSort, TSortDir, TExtra>(
  storageKey: string,
  parse: (raw: unknown) => RestoredTableView<TSort, TSortDir, TExtra> | null
): RestoredTableView<TSort, TSortDir, TExtra> | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Generic sort + hidden-columns + persistence machinery for a client-side table
 * view, shared by both the web app and the desktop renderer. Owns the sort key /
 * direction, the visible-column set, and the single `localStorage` object that
 * persists them alongside a feature-specific `extras` blob — keyed by surface and
 * fail-soft (private mode, malformed JSON, unknown enum/column values all degrade
 * to defaults rather than throwing).
 *
 * Concrete hooks (`useSessionsViewState`, `useAgentComponentsViewState`,
 * `useBranchViewState`) wrap this with their own column list, sort enums, and
 * extra dimensions (date range, grouping, metric mode, reveal toggles); the
 * common machinery lives here so the three surfaces cannot drift apart.
 *
 * When `persistKey` is provided the view is restored from `localStorage` on mount
 * and re-persisted on every change; without it the view is memory-only.
 */
export function usePersistedTableViewState<
  TSort,
  TSortDir,
  TColumnId extends string,
  TExtra extends Record<string, unknown>,
>(config: PersistedTableViewConfig<TSort, TSortDir, TColumnId, TExtra>) {
  const {
    persistKey,
    keyPrefix,
    columnIds,
    defaultHiddenColumns,
    defaultSortKey,
    defaultSortDir,
    sortDirs,
    defaultExtras,
    parse,
  } = config;
  const [ascSortDir, descSortDir] = sortDirs;

  // Namespace the saved view by the authenticated user so two accounts sharing
  // one OS profile / browser (common on the desktop) never read or write each
  // other's layout (wongk review, FEA-4168). While auth is still hydrating we
  // hold off (`storageKey` null) so an anonymous default can't land under — and
  // shadow — a real user's key. Once loaded: a signed-in user gets a per-user
  // key; a genuinely signed-out surface (or a mount with no auth provider at
  // all, e.g. Storybook) falls back to the legacy un-namespaced key, preserving
  // prior behavior rather than silently dropping persistence.
  const { userId, isLoaded: authLoaded } = useOptionalAuthSnapshot();
  const storageKey = useMemo(() => {
    if (!(persistKey && authLoaded)) {
      return null;
    }
    return userId
      ? `${keyPrefix}${persistKey}:u:${userId}`
      : `${keyPrefix}${persistKey}`;
  }, [persistKey, keyPrefix, authLoaded, userId]);
  // Legacy un-namespaced key. Before the per-user namespacing above (FEA-4168),
  // every user's view was saved under this single key. A signed-in user whose
  // per-user key is still empty — because they saved a view *before* this change
  // shipped — must still restore that pre-existing view, so the restore reads
  // the legacy key as a one-time migration fallback. Null when signed out (the
  // signed-out key already IS the legacy key) or before persistence is possible,
  // so the fallback never shadows the primary read in those cases.
  const legacyStorageKey = useMemo(() => {
    if (!(persistKey && authLoaded && userId)) {
      return null;
    }
    return `${keyPrefix}${persistKey}`;
  }, [persistKey, keyPrefix, authLoaded, userId]);

  const validColumnIds = useMemo(() => new Set<string>(columnIds), [columnIds]);

  // ISS-5315: the hidden set a never-saved view starts from (and the one
  // `resetColumns` returns to). Filtered against `columnIds` for the same reason
  // a restored set is: a default naming a column this table no longer has must
  // not hide a phantom.
  const defaultHiddenColumnIds = useMemo(
    () =>
      new Set<TColumnId>(
        (defaultHiddenColumns ?? []).filter((id) => validColumnIds.has(id))
      ),
    [defaultHiddenColumns, validColumnIds]
  );

  // FEA-4125: the persisted view is restored in a POST-MOUNT effect, not a
  // `useState` initializer, so the first client render matches the server-
  // rendered HTML (both start from the defaults below). Reading `localStorage`
  // during the initial render diverged the first client render from SSR — a
  // saved sort/column/date-range surfaces in the toolbar's initial markup — and
  // tripped React hydration error #418 (text/HTML mismatch), which the route's
  // error boundary caught and blanked the screen. The effect applies the saved
  // view after hydration; `restoredForCurrentInputs` below also gates the
  // persistence write so the default state does not clobber the saved view
  // before it is restored.
  const [sortKey, setSortKey] = useState<TSort>(defaultSortKey);
  const [sortDir, setSortDir] = useState<TSortDir>(defaultSortDir);
  const [extras, setExtras] = useState<TExtra>(defaultExtras);
  // Seeded from the feature's default-hidden set (ISS-5315), which is a pure
  // module constant — not storage — so the first client render still matches the
  // SSR markup and the FEA-4125 hydration contract above is untouched.
  const [hiddenColumns, setHiddenColumns] = useState<Set<TColumnId>>(
    () => new Set<TColumnId>(defaultHiddenColumnIds)
  );
  // FEA-4021: persisted data-column order (ids). Empty ⇒ the table's natural
  // order. Only ids in `columnIds` survive a restore so a stale/unknown id
  // cannot reorder a column the table no longer has.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => []);
  // FEA-4168: persisted per-column widths (px), keyed by data-column id. Empty ⇒
  // the table's natural widths. Only ids in `columnIds` survive a restore so a
  // stale/unknown id cannot inject a width for a column the table no longer has.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => ({})
  );
  // The inputs the restore has COMMITTED for, in state so committing them
  // re-renders. Gates the persistence write below — non-null and matching the
  // current inputs only AFTER the restore effect has applied the saved view (or
  // determined there is nothing to restore) — so the initial default state is
  // never written over the saved view.
  //
  // ISS-4655: this is a matched pair of INPUTS rather than the one-shot boolean
  // it used to be, because `isViewReady` below needs to distinguish "restored"
  // from "restored against the key/parser we are still going to keep". A
  // boolean could not: it flipped true on the first effect run even when
  // `storageKey` was still null because auth had not hydrated, so a consumer
  // gating a fetch on it fetched the DEFAULT window and then refetched the
  // restored one — the very double-read the gate exists to prevent.
  const [committedRestoreInputs, setCommittedRestoreInputs] =
    useState<RestoreInputs<TSort, TSortDir, TExtra> | null>(null);
  // Tracks the INPUTS the restore effect last STARTED against (the state above
  // records the ones it FINISHED against). A ref because the re-entry guard has
  // to see the write the instant the effect body runs. Keying on the values (not
  // a one-shot boolean) makes an in-place account switch — the resolved
  // `storageKey` changing while the component stays mounted — re-run the restore
  // for the new user instead of stranding the previous account's view.
  //
  // The parser is in the guard for the same reason (ISS-4890, wongk review): a
  // feature hook may SWAP its `parse` mid-life, and the swap changes what the
  // stored bytes decode to. `useSessionsViewState` does exactly this — its
  // migrating parser is selected by a flag that resolves after mount (PostHog
  // hydrating on web; a desktop Labs key that starts `false` and hydrates
  // asynchronously). Guarding on the key alone meant whichever parser won the
  // race was the only one that ever ran, so on Desktop the migration could be
  // skipped on EVERY launch. Re-reading is safe: every change is persisted as it
  // happens, so the storage the second pass reads already carries the current
  // in-session state.
  const restoredInputsRef = useRef<RestoreInputs<
    TSort,
    TSortDir,
    TExtra
  > | null>(null);

  useEffect(() => {
    if (
      restoredInputsRef.current?.storageKey === storageKey &&
      restoredInputsRef.current?.parse === parse
    ) {
      return;
    }
    // One object marks both edges of this run: assigned to the ref now ("this
    // run has started", closing the re-entry guard) and committed to state at
    // the end ("this run has finished"), so the two can never describe
    // different runs.
    const inputs: RestoreInputs<TSort, TSortDir, TExtra> = {
      parse,
      storageKey,
    };
    restoredInputsRef.current = inputs;
    // Read the per-user key first; if it holds nothing (a signed-in user who
    // saved a view before per-user namespacing shipped), fall back to the legacy
    // un-namespaced key so the pre-existing view still restores. The follow-up
    // persist effect then re-saves it under the per-user key.
    const saved = storageKey
      ? (loadRestoredView(storageKey, parse) ??
        (legacyStorageKey ? loadRestoredView(legacyStorageKey, parse) : null))
      : null;
    if (saved) {
      setSortKey(saved.sortKey);
      setSortDir(saved.sortDir);
      setExtras(saved.extras);
      setHiddenColumns(
        new Set<TColumnId>(
          saved.hiddenColumns.filter((id): id is TColumnId =>
            validColumnIds.has(id)
          )
        )
      );
      setColumnOrder(
        (saved.columnOrder ?? []).filter((id) => validColumnIds.has(id))
      );
      setColumnWidths(
        filterValidColumnWidths(saved.columnWidths, validColumnIds)
      );
    } else {
      // No saved view for this key (fresh user, signed out, or first visit):
      // fall back to defaults so a prior account's in-memory view never leaks
      // across a switch.
      setSortKey(defaultSortKey);
      setSortDir(defaultSortDir);
      setExtras(defaultExtras);
      setHiddenColumns(new Set<TColumnId>(defaultHiddenColumnIds));
      setColumnOrder([]);
      setColumnWidths({});
    }
    // Enable persistence in a follow-up commit so any restored values above are
    // applied first — the persist effect then writes through real changes only.
    setCommittedRestoreInputs(inputs);
  }, [
    storageKey,
    legacyStorageKey,
    parse,
    validColumnIds,
    defaultSortKey,
    defaultSortDir,
    defaultExtras,
    defaultHiddenColumnIds,
  ]);

  // Whether the restore has committed for the inputs currently in force. False
  // both before the first run and across a mid-life input change (auth
  // hydrating, an account switch, a parser swap) until that run's own restore
  // lands — during which the in-memory view still describes the PREVIOUS inputs.
  const restoredForCurrentInputs =
    committedRestoreInputs !== null &&
    committedRestoreInputs.storageKey === storageKey &&
    committedRestoreInputs.parse === parse;

  // ISS-4655: bound the wait on auth hydration, via the shared latch that also
  // backs `useFeatureFlagGate`. A memory-only surface has no stored view to wait
  // for, so it counts as already resolved and never arms a timer.
  const authSettled = useResolvedOrDeadline(
    authLoaded || !persistKey,
    VIEW_RESTORE_AUTH_DEADLINE_MS
  );

  useEffect(() => {
    // Do not persist until the restore effect has committed for the current
    // `storageKey` (or persistence is off because there is no key — no
    // `persistKey`, or auth is not yet loaded / signed out); otherwise the
    // initial default state would overwrite the saved view before the restore
    // effect above reads it.
    if (
      !(storageKey && restoredForCurrentInputs) ||
      typeof localStorage === "undefined"
    ) {
      return;
    }
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          // Spread the feature `extras` FIRST, then the reserved canonical keys,
          // so an `extras` blob that happens to carry a `sortKey`/`sortDir`/
          // `hiddenColumns`/`columnOrder`/`columnWidths` key can never clobber
          // the real view state on serialization (reserved keys always win).
          ...extras,
          sortKey,
          sortDir,
          hiddenColumns: [...hiddenColumns],
          columnOrder,
          columnWidths,
        })
      );
    } catch {
      // Private mode / quota — persistence is best-effort.
    }
  }, [
    storageKey,
    restoredForCurrentInputs,
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    extras,
  ]);

  /**
   * Whether the view has SETTLED on the dimensions it will keep — the signal a
   * surface should gate a data request on (`enabled: isViewReady`), so it
   * paginates once against the restored window instead of once against the
   * default and again against the restored one (ISS-4655).
   *
   * True once the restore has committed for the inputs in force AND those
   * inputs are final. They are final when the surface does not persist at all
   * (memory-only: Storybook, prototypes — nothing to wait for), or once auth has
   * resolved, or once {@link VIEW_RESTORE_AUTH_DEADLINE_MS} has elapsed waiting
   * for it. That last clause is what keeps this from being a way to never load.
   */
  const isViewReady = restoredForCurrentInputs && authSettled;

  const visibleColumns = useMemo(
    () => new Set<TColumnId>(columnIds.filter((id) => !hiddenColumns.has(id))),
    [columnIds, hiddenColumns]
  );

  const setSort = useCallback((key: NonNullable<TSort>, dir?: TSortDir) => {
    setSortKey(key);
    if (dir) {
      setSortDir(dir);
    }
  }, []);

  const toggleSortDir = useCallback(
    () => setSortDir((dir) => (dir === ascSortDir ? descSortDir : ascSortDir)),
    [ascSortDir, descSortDir]
  );

  const toggleColumn = useCallback((id: TColumnId) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Reorder the data columns (FEA-4021). The primitive emits the full new id
  // order; keep only ids the table still has so a stale id can't linger.
  const setColumnOrderSafe = useCallback(
    (nextOrder: readonly string[]) => {
      setColumnOrder(nextOrder.filter((id) => validColumnIds.has(id)));
    },
    [validColumnIds]
  );

  // Resize one data column (FEA-4168). The primitive emits an already-clamped
  // width; keep it only for an id the table still has so a stale id can't inject
  // a phantom width. A merge (not replace) so each column's width is independent.
  const setColumnWidth = useCallback(
    (id: string, widthPx: number) => {
      if (!validColumnIds.has(id)) {
        return;
      }
      setColumnWidths((prev) => ({ ...prev, [id]: widthPx }));
    },
    [validColumnIds]
  );

  // Restore the feature's DEFAULT column visibility (all visible unless the
  // feature declares a `defaultHiddenColumns` set, ISS-5315) AND the natural
  // order AND natural widths — a feature's "Reset view". Reset means "back to
  // how the surface ships", so a feature whose default hides a column must land
  // there, not on a state the user has never seen.
  const resetColumns = useCallback(() => {
    setHiddenColumns(new Set<TColumnId>(defaultHiddenColumnIds));
    setColumnOrder([]);
    setColumnWidths({});
  }, [defaultHiddenColumnIds]);

  // FEA-4180: apply a whole arrangement at once (switching to a named saved
  // view). Sets sort + order + visibility + extras together so a switch lands as
  // one coherent transition instead of a cascade of individual toggles. Unknown
  // hidden/order ids are dropped exactly as on restore so a stale id from an old
  // saved view cannot reorder or hide a column the table no longer has.
  const applyView = useCallback(
    (view: {
      sortKey: TSort;
      sortDir: TSortDir;
      hiddenColumns: readonly string[];
      columnOrder?: readonly string[];
      extras: TExtra;
    }) => {
      setSortKey(view.sortKey);
      setSortDir(view.sortDir);
      setExtras(view.extras);
      setHiddenColumns(
        new Set<TColumnId>(
          view.hiddenColumns.filter((id): id is TColumnId =>
            validColumnIds.has(id)
          )
        )
      );
      setColumnOrder(
        (view.columnOrder ?? []).filter((id) => validColumnIds.has(id))
      );
    },
    [validColumnIds]
  );

  return {
    sortKey,
    sortDir,
    extras,
    setExtras,
    isViewReady,
    visibleColumns,
    columnOrder,
    setColumnOrder: setColumnOrderSafe,
    columnWidths,
    setColumnWidth,
    setSort,
    toggleSortDir,
    toggleColumn,
    resetColumns,
    applyView,
  };
}

/**
 * Keep only entries whose id is a known column and whose width is a finite
 * positive number (FEA-4168). A stale/unknown id from an older saved view, or a
 * malformed non-numeric width, is dropped so a restore never injects a phantom
 * or NaN width. Returns a new record; the input is never mutated.
 */
function filterValidColumnWidths(
  widths: Record<string, number> | undefined,
  validColumnIds: ReadonlySet<string>
): Record<string, number> {
  if (!widths) {
    return {};
  }
  const next: Record<string, number> = {};
  for (const [id, width] of Object.entries(widths)) {
    if (validColumnIds.has(id) && Number.isFinite(width) && width > 0) {
      next[id] = width;
    }
  }
  return next;
}
