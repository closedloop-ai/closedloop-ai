"use client";

import type { GridPreferenceGridKey } from "@repo/api/src/types/grid-preferences";
import { GridPreferenceScopeKey } from "@repo/api/src/types/grid-preferences";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFeatureFlagEnabledOptional } from "../feature-flags/use-feature-flag-enabled";
import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "../lib/feature-flags";
import {
  filterValidColumnOrder,
  filterValidColumnWidths,
  NO_PRESERVED_COLUMN_IDS,
  type PreservedColumnIds,
  resizeColumnWidth,
} from "../lib/preserved-column-ids";
import {
  NO_OPAQUE_STORED_VIEW_FIELDS,
  normalizeStoredTableView,
  opaqueStoredViewFields,
  type StoredViewSnapshot,
  serializeTableView,
  serializeTableViewWithinCeiling,
} from "./persisted-table-view-snapshot";
import {
  decodeStoredRecord,
  readFallbackStoredRecord,
  readStoredRecord,
  subscribeToStorageKey,
} from "./subscribe-to-storage-key";
import { useGridPreferenceRemote } from "./use-grid-preference-remote";
import { useTableViewStorageKey } from "./use-table-view-storage-key";

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
  /**
   * ISS-9692: persisted rows-per-page. Optional so a feature that does not
   * persist a page size (or a saved view written before this field existed)
   * degrades to the caller's `defaultPageSize`.
   *
   * Stored as the raw number the reader chose, NOT clamped to a ladder here:
   * this hook is generic and does not know which rungs a surface offers, and the
   * ladder itself moves with a feature flag. The surface resolves it against the
   * ladder in force at the point of use (`useTablePageSizeOptions`), which is
   * what lets a 500 chosen while the flag was on come back as 500 when it is
   * turned on again instead of having been flattened to 100 on disk.
   */
  pageSize?: number;
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
   * ISS-10356: ids OUTSIDE `columnIds` whose WIDTH this view holds, and only
   * their width. Such an id is restored, resized and persisted like a declared
   * one, but it never enters the hidden set or the order, so the view restores
   * how that column looks without deciding whether it shows. Pass a stable
   * (module-level) function. Omit it and every id outside `columnIds` is
   * version skew: carried, not applied (ISS-9447 D1).
   */
  isWidthOnlyColumnId?: (id: string) => boolean;
  /**
   * ISS-5315: column ids a NEVER-SAVED view starts with hidden, and the set
   * `resetColumns` restores to. Pass a stable (module-level) reference.
   *
   * It is deliberately NOT applied on top of a restored view: once a user has a
   * saved view, their `hiddenColumns` is the whole truth about what they hid or
   * showed, so a column they deliberately turned ON is never turned back off by
   * a later change to this default. Omit for "everything visible", the prior
   * behavior every existing caller keeps.
   *
   * "A user HAS a saved view" means they shaped one — see `viewEditedRef`. A
   * surface nobody has touched writes nothing, so it cannot manufacture the very
   * saved view that would then outrank this default.
   */
  defaultHiddenColumns?: readonly TColumnId[];
  defaultSortKey: TSort;
  defaultSortDir: TSortDir;
  /**
   * ISS-9692: the rows-per-page a never-saved view starts on. Omit and the
   * surface holds `DEFAULT_TABLE_PAGE_SIZE`, which is what every list shipped.
   */
  defaultPageSize?: number;
  /** The two sort directions `toggleSortDir` flips between. */
  sortDirs: readonly [TSortDir, TSortDir];
  defaultExtras: TExtra;
  /**
   * ISS-9447: fold the `extras` a COLUMN RESET invalidates back to what this
   * build ships, applied by `resetColumns` in the same gesture.
   *
   * `resetColumns` rewrites the hidden-column set and the column order to this
   * build's defaults. A surface that also persists a MIGRATION STAMP for those
   * axes has to move it with them: a stamp a NEWER build wrote is kept verbatim
   * on read (see `runViewStateMigration`), so left behind it would go on
   * vouching — back on that newer build — for a repair the reset has just
   * undone, and the default-hidden column that repair exists to hide would
   * render permanently. That is ISS-6065, reached through Reset view rather
   * than through the mount-time erasure ISS-9447 D1 removed.
   *
   * Declared by the feature because `extras` is opaque here: only the surface
   * knows which of its fields stamp the two axes this reset rewrites. Pass a
   * stable (module-level) function reference. Omit it when the surface stamps
   * neither — Branches stores no stamp at all, and Agent Components stamps only
   * its SORT axis, which a column reset does not touch.
   */
  resetColumnVersions?: (extras: TExtra) => TExtra;
  /**
   * Validate an already-JSON-parsed value into a restored view, or `null` when
   * it is missing/malformed. Pass a stable (module-level) function reference.
   */
  parse: (raw: unknown) => RestoredTableView<TSort, TSortDir, TExtra> | null;
  /**
   * ISS-9450: which `grid_preferences` row this surface's view is the
   * account-level copy of. Omit and the view stays `localStorage`-only, which is
   * also what every surface does while the closed-by-default PostHog gate in
   * `useGridPreferenceRemote` is shut.
   *
   * The selector, not a boolean: the flag is read at the one site that swaps on
   * it (`no-threaded-feature-flag`), and what a caller declares here is which row
   * it owns, which does not change with the gate.
   */
  gridKey?: GridPreferenceGridKey;
  /**
   * ISS-9450: the scope within {@link gridKey}. Defaults to `default`; only
   * Branches has a second projection (`approved`) that keeps its own layout.
   */
  scopeKey?: GridPreferenceScopeKey;
};

/**
 * The inputs the restore keys on: the resolved storage key and the parser.
 * Either changing means the stored bytes decode to a different view, so the
 * restore must run again (see `restoredInputsRef` / `committedRestoreInputs`).
 */
type RestoreInputs<TSort, TSortDir, TExtra> = {
  restoreKey: string | null;
  fallbackKeys: readonly string[];
  parse: (raw: unknown) => RestoredTableView<TSort, TSortDir, TExtra> | null;
  /**
   * ISS-5528: the default-hidden set is in the guard for exactly the reason the
   * parser is (see `restoredInputsRef`). A feature may SELECT its
   * `defaultHiddenColumns` from a flag that resolves AFTER mount, and the
   * no-saved-view branch below is the only thing that applies it — so guarding
   * on key+parser alone meant whichever set won the race was the only one that
   * ever landed, and a late-resolving flag silently never hid its column.
   *
   * The effect already declared this in its dependency array; the guard is what
   * threw the re-run away.
   *
   * Compared by IDENTITY, like `parse` beside it — this is the memoized `Set`,
   * which only changes when the feature's own `defaultHiddenColumns` input does,
   * so identity is exactly "the feature answered differently" and never a
   * per-render churn.
   */
  defaultHiddenColumnIds: ReadonlySet<string>;
};

/**
 * Generic sort + hidden-columns + persistence machinery for a client-side table
 * view, shared by both the web app and the desktop renderer. Owns the sort key /
 * direction, the visible-column set, and the single `localStorage` object that
 * persists them alongside a feature-specific `extras` blob — keyed by surface and
 * fail-soft (private mode, malformed JSON and unknown enum values all degrade to
 * defaults rather than throwing). A column id this build does not declare is the
 * one exception: it is not applied, but it is carried and written back, so
 * version skew between two shells costs nobody their layout (ISS-9447 D1).
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
    isWidthOnlyColumnId,
    defaultHiddenColumns,
    defaultSortKey,
    defaultSortDir,
    defaultPageSize = DEFAULT_TABLE_PAGE_SIZE,
    sortDirs,
    defaultExtras,
    resetColumnVersions,
    parse,
    gridKey,
    scopeKey = GridPreferenceScopeKey.Default,
  } = config;
  const [ascSortDir, descSortDir] = sortDirs;

  /**
   * ISS-9692: whether a page-size choice made here is DURABLE.
   *
   * Read HERE rather than threaded in from each feature hook — that would hand a
   * flag boolean across a module boundary, which `no-threaded-feature-flag`
   * forbids and which would let two surfaces answer the same question
   * differently. A reader without the gate gets exactly the behaviour that
   * shipped: the control still moves for this visit, and the next visit opens on
   * the default.
   *
   * It does NOT stop the restore, and does not erase what is on disk: the write
   * puts back the value this view was restored with (see
   * `restoredPageSizeRef`), so a reader whose gate is later closed keeps their
   * stored choice for when it opens again.
   */
  const persistPageSize = useFeatureFlagEnabledOptional(
    TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY
  );
  // FEA-4168 / ISS-8262 / ISS-10091: resolve write/read/migration keys once so
  // the ISS-9450 server sync reads the same key this hook writes.
  const { storageKey, restoreStorageKey, fallbackStorageKeys, authSettled } =
    useTableViewStorageKey({ keyPrefix, persistKey });
  // ISS-9450: the account-level copy of this same record. Inert unless the
  // caller declared a `gridKey` AND the closed-by-default gate inside is open,
  // so a surface that declares nothing — and every surface while the gate is
  // shut — keeps exactly the `localStorage`-only behaviour that shipped.
  const remote = useGridPreferenceRemote({ gridKey, scopeKey, storageKey });
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
  // order. Only ids in `columnIds` are APPLIED, so a stale/unknown id cannot
  // reorder a column the table no longer has; the rest ride in
  // `preservedColumnIds` below rather than being dropped.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => []);
  // FEA-4168: persisted per-column widths (px), keyed by data-column id. Empty ⇒
  // the table's natural widths. Only ids in `columnIds` (and width-only ids,
  // ISS-10356) are APPLIED, so a stale/unknown id cannot inject a width for a
  // column the table no longer has;
  // a well-formed width for one of those ids rides in `preservedColumnIds`.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => ({})
  );
  // ISS-9447 D1: the stored ids this build has no column for. Held apart from
  // the applied state above — which stays strictly typed, so nothing the table
  // cannot draw reaches the render path — and merged back by the persist effect,
  // so the stored record round-trips whole. Before this, restoring FILTERED all
  // three axes and the write below put the filtered set back, which destroyed a
  // reader's arrangement on mount alone.
  const [preservedColumnIds, setPreservedColumnIds] =
    useState<PreservedColumnIds>(NO_PRESERVED_COLUMN_IDS);
  // ISS-9692: persisted rows-per-page. Seeded from the feature's own default (a
  // module constant, not storage) so the first client render still matches the
  // SSR markup — the FEA-4125 hydration contract above covers this dimension
  // exactly as it covers the sort.
  const [pageSize, setPageSizeState] = useState<number>(defaultPageSize);
  // The page size this view was RESTORED with. Written back verbatim while
  // `persistPageSize` is false, so a gated-off session neither makes its own
  // choice durable nor destroys a choice made while the gate was open.
  const restoredPageSizeRef = useRef<number>(defaultPageSize);
  // ISS-9568: a page size adopted from another tab while this reader's ladder
  // gate was still closed. Promoted into the visible state the moment the gate
  // opens (see the effect below the persist effect), because the write-back
  // becomes durable at that instant and must carry the adopted value, not the
  // pre-adoption one still on screen.
  const pendingAdoptedPageSizeRef = useRef<number | null>(null);
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
  // The parser is in the guard for the same reason (ISS-4890, whitlockk review): a
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
  // Whether the last restore found a view IN STORAGE (as opposed to falling back
  // to the defaults), and whether anything the user did has since changed the
  // view. Together they answer the one question the persist effect below has to
  // ask before it writes: is there a view here that somebody would miss?
  //
  // ISS-5528 (whitlockk review, PR #6592). Without them the answer was always yes,
  // and that made a flag-selected `defaultHiddenColumns` a no-op on every
  // PERSISTING surface — the case every real viewer is in. The first restore
  // runs before the flag resolves, finds nothing, commits the pre-flag defaults,
  // and the write below immediately materializes them as a saved view. The
  // re-run the resolved flag triggers then finds THAT view, takes the `saved`
  // branch, and never reaches `defaultHiddenColumnIds` at all — so the column
  // the flag exists to hide stayed visible forever, while the memory-only path
  // (no `persistKey`, which is what the ISS-5528 test drove) worked fine.
  //
  // A view the user actually shaped still outranks the default, which is the
  // ISS-5315 contract one paragraph up: `viewEditedRef` is what distinguishes it
  // from this hook's own echo of the defaults.
  const savedViewRestoredRef = useRef(false);
  const viewEditedRef = useRef(false);
  // ISS-9568: the bytes last written to, or adopted from, `key`. The persist
  // effect skips a write whose bytes match, which is what makes a cross-tab
  // adoption write-free — the adopted snapshot is serialized into this ref by
  // the same function the persist effect uses, so the next run computes the
  // identical string and writes nothing. Keyed by storage key and cleared at
  // every restore boundary so the load-bearing re-save under a newly resolved
  // per-user key (the legacy-key migration below) is never suppressed.
  const lastWrittenRef = useRef<{ key: string; serialized: string } | null>(
    null
  );
  // ISS-9568: this tab has committed an edit that the passive persist effect has
  // not written yet. Set by every setter that marks the view edited, cleared the
  // moment that effect takes responsibility for the bytes. It exists because a
  // sibling-tab event can land in the commit-to-flush gap, and adopting there
  // would replace the edit in memory AND seed `lastWrittenRef` with the remote
  // bytes, so the pending run would find nothing to do — the edit would be gone
  // from screen and disk having never existed on either. A boolean rather than a
  // re-serialization of the live state, because the handler runs from a closure
  // one render behind whenever two events arrive before a flush.
  const unflushedEditRef = useRef(false);
  // ISS-9450: the top-level fields of the record this view was restored from
  // that this build does not write — a whole axis a newer build added, which the
  // feature's `z.object` parser strips on the way in. Held here, never
  // rendered, and folded back by every serialization below, so neither a mount
  // nor an edit deletes it. A ref rather than state because it only ever
  // changes alongside a restore, an adoption, or a server delivery, each of
  // which already commits the state change that re-runs the persist effect.
  const opaqueFieldsRef = useRef<Record<string, unknown>>(
    NO_OPAQUE_STORED_VIEW_FIELDS
  );

  // Setting the two together is the whole contract: `viewEditedRef` is "this
  // reader shaped a view" (durable, ISS-5528), `unflushedEditRef` is "and disk
  // does not have it yet" (cleared per flush). A setter that marks one without
  // the other is the bug this helper exists to make unwritable.
  const markViewEdited = useCallback(() => {
    viewEditedRef.current = true;
    unflushedEditRef.current = true;
  }, []);

  const normalizeStoredView = useCallback(
    (saved: RestoredTableView<TSort, TSortDir, TExtra>) =>
      normalizeStoredTableView<TSort, TSortDir, TColumnId, TExtra>(
        saved,
        validColumnIds,
        defaultPageSize,
        isWidthOnlyColumnId
      ),
    [validColumnIds, defaultPageSize, isWidthOnlyColumnId]
  );

  // Push a normalized snapshot onto the seven state slices.
  // `applyPageSizeToState` false updates only the write-back ref: a reader whose page-size gate is
  // closed keeps the rows-per-page they are looking at (ISS-9692 promised
  // them exactly the behaviour that shipped) while the next write still
  // carries the stored value rather than a stale one.
  const applySnapshot = useCallback(
    (
      snapshot: StoredViewSnapshot<TSort, TSortDir, TColumnId, TExtra>,
      applyPageSizeToState: boolean
    ) => {
      setSortKey(snapshot.sortKey);
      setSortDir(snapshot.sortDir);
      setExtras(snapshot.extras);
      setHiddenColumns(snapshot.hiddenColumns);
      setColumnOrder(snapshot.columnOrder);
      setColumnWidths(snapshot.columnWidths);
      // ISS-9447 D1: the ids this build has no column for ride along with the
      // applied halves, so a cross-tab adoption carries a sibling tab's newer
      // columns instead of erasing them on its next write.
      setPreservedColumnIds(snapshot.preservedColumnIds);
      restoredPageSizeRef.current = snapshot.pageSize;
      if (applyPageSizeToState) {
        pendingAdoptedPageSizeRef.current = null;
        setPageSizeState(snapshot.pageSize);
      } else {
        pendingAdoptedPageSizeRef.current = snapshot.pageSize;
      }
    },
    []
  );

  useEffect(() => {
    if (
      restoredInputsRef.current?.restoreKey === restoreStorageKey &&
      restoredInputsRef.current?.fallbackKeys === fallbackStorageKeys &&
      restoredInputsRef.current?.parse === parse &&
      restoredInputsRef.current?.defaultHiddenColumnIds ===
        defaultHiddenColumnIds
    ) {
      return;
    }
    lastWrittenRef.current = null;
    // A restore replaces the view wholesale, so whatever a setter marked before
    // it is no longer work this tab owes disk — the persist run that follows
    // writes the RESTORED bytes, not the superseded edit.
    unflushedEditRef.current = false;
    // One object marks both edges of this run: assigned to the ref now ("this
    // run has started", closing the re-entry guard) and committed to state at
    // the end ("this run has finished"), so the two can never describe
    // different runs.
    const inputs: RestoreInputs<TSort, TSortDir, TExtra> = {
      defaultHiddenColumnIds,
      fallbackKeys: fallbackStorageKeys,
      parse,
      restoreKey: restoreStorageKey,
    };
    restoredInputsRef.current = inputs;
    // Read the primary identity key first, then older identities in migration
    // order. The follow-up persist effect re-saves whichever record restored
    // under the current write key, without deleting the old one.
    const saved = restoreStorageKey
      ? (readStoredRecord(restoreStorageKey, parse) ??
        readFallbackStoredRecord(fallbackStorageKeys, parse))
      : null;
    if (saved) {
      savedViewRestoredRef.current = true;
      opaqueFieldsRef.current = opaqueStoredViewFields(
        saved.raw,
        saved.parsed.extras
      );
      applySnapshot(normalizeStoredView(saved.parsed), true);
    } else {
      // No saved view for this key (fresh user, signed out, or first visit):
      // fall back to defaults so a prior account's in-memory view never leaks
      // across a switch. Both refs go back to "nothing here yet" — an account
      // switch inherits neither the previous key's storage nor its edits.
      savedViewRestoredRef.current = false;
      viewEditedRef.current = false;
      opaqueFieldsRef.current = NO_OPAQUE_STORED_VIEW_FIELDS;
      setSortKey(defaultSortKey);
      setSortDir(defaultSortDir);
      setExtras(defaultExtras);
      setHiddenColumns(new Set<TColumnId>(defaultHiddenColumnIds));
      setColumnOrder([]);
      setColumnWidths({});
      setPreservedColumnIds(NO_PRESERVED_COLUMN_IDS);
      restoredPageSizeRef.current = defaultPageSize;
      pendingAdoptedPageSizeRef.current = null;
      setPageSizeState(defaultPageSize);
    }
    // Enable persistence in a follow-up commit so any restored values above are
    // applied first — the persist effect then writes through real changes only.
    setCommittedRestoreInputs(inputs);
  }, [
    restoreStorageKey,
    fallbackStorageKeys,
    parse,
    normalizeStoredView,
    applySnapshot,
    defaultSortKey,
    defaultSortDir,
    defaultExtras,
    defaultHiddenColumnIds,
    defaultPageSize,
  ]);

  // Whether the restore has committed for the inputs currently in force. False
  // both before the first run and across a mid-life input change (auth
  // hydrating, an account switch, a parser swap, a default-visibility swap)
  // until that run's own restore lands — during which the in-memory view still
  // describes the PREVIOUS inputs. Compares the same fields the re-entry
  // guard does, so "started" and "finished" can never disagree about what an
  // input change is.
  const restoredForCurrentInputs =
    committedRestoreInputs !== null &&
    committedRestoreInputs.restoreKey === restoreStorageKey &&
    committedRestoreInputs.fallbackKeys === fallbackStorageKeys &&
    committedRestoreInputs.parse === parse &&
    committedRestoreInputs.defaultHiddenColumnIds === defaultHiddenColumnIds;

  useEffect(() => {
    // Do not persist until the restore effect has committed for the current
    // `storageKey` (or persistence is off because there is no key — no
    // `persistKey`, or auth is not yet loaded / signed out); otherwise the
    // initial default state would overwrite the saved view before the restore
    // effect above reads it.
    //
    // ISS-8262: gating on `storageKey`, never on the restore key, is what keeps
    // the deadline-expiry read one-way. A surface whose auth never hydrates
    // restores the legacy view and then writes NOTHING, so an unidentified
    // viewer can never overwrite the view it was allowed to read.
    //
    // ISS-5528: and never write a view nobody has. A surface whose restore found
    // nothing and whose user has changed nothing holds the DEFAULTS, which are
    // recomputed from the feature's own inputs on every mount — writing them
    // stores no information and costs the one thing a stored view outranks, the
    // default itself (see `savedViewRestoredRef`). The write resumes the instant
    // either is true, so a restored view is still re-serialized (which is what
    // re-saves a legacy view under the per-user key, and what carries a migrated
    // sort back to disk) and a first edit still lands.
    const hasViewWorthWriting =
      savedViewRestoredRef.current || viewEditedRef.current;
    if (
      !(storageKey && restoredForCurrentInputs && hasViewWorthWriting) ||
      typeof localStorage === "undefined"
    ) {
      return;
    }
    // The page size written is the reader's choice only while their ISS-9692
    // gate is open; otherwise the value the view was restored or adopted with
    // goes back verbatim. And the gate may have just opened on an adopted page
    // size the screen does not show yet: write the adopted value, not the
    // on-screen one, and let the promotion effect below bring the screen into
    // line. Resolved HERE so the flag never crosses into the serializer.
    let pageSizeToWrite = restoredPageSizeRef.current;
    if (persistPageSize) {
      pageSizeToWrite = pendingAdoptedPageSizeRef.current ?? pageSize;
    }
    const serialized = serializeTableViewWithinCeiling(
      {
        extras,
        sortKey,
        sortDir,
        hiddenColumns,
        columnOrder,
        columnWidths,
        preservedColumnIds,
        opaqueFields: opaqueFieldsRef.current,
        pageSize: pageSizeToWrite,
      },
      validColumnIds
    );
    // This run now owns whatever the setters marked: these bytes are either
    // already on disk or about to be. Cleared before the write rather than after
    // it because the failure arms (quota, private mode, and ISS-9449's ceiling
    // below) can never write them, and a flag left standing there would block
    // cross-tab adoption for the life of the mount.
    unflushedEditRef.current = false;
    if (serialized === null) {
      // ISS-9449: past the ceiling even with the carried ids and the
      // width-only widths shed. Only the feature `extras` can do that, and
      // this hook may not drop what the reader chose, so the record on disk
      // stays as it was and this edit goes unpersisted. No log: this is
      // browser code (no-client-debug-logging).
      return;
    }
    if (
      lastWrittenRef.current?.key === storageKey &&
      lastWrittenRef.current.serialized === serialized
    ) {
      return;
    }
    // ISS-9450: the same bytes, offered to the account-level copy. Before the
    // local write, not after it, because a runtime that refuses `localStorage`
    // (private mode, quota) is exactly the one whose reader most needs the
    // server copy — and the remote dedupes on what the SERVER confirmed, so an
    // offer it has already stored costs nothing.
    remote.publish(serialized);
    try {
      localStorage.setItem(storageKey, serialized);
      lastWrittenRef.current = { key: storageKey, serialized };
    } catch {
      // Private mode / quota — persistence is best-effort.
    }
  }, [
    remote.publish,
    storageKey,
    restoredForCurrentInputs,
    validColumnIds,
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    preservedColumnIds,
    pageSize,
    persistPageSize,
    extras,
  ]);

  useEffect(() => {
    if (!persistPageSize || pendingAdoptedPageSizeRef.current === null) {
      return;
    }
    setPageSizeState(pendingAdoptedPageSizeRef.current);
    pendingAdoptedPageSizeRef.current = null;
  }, [persistPageSize]);

  // ISS-9450: apply a layout the SERVER is authoritative for — the account copy
  // adopted on mount, or the last confirmed one handed back after a rejected or
  // failed write. Applied by sequence number, so a rollback that re-delivers
  // bytes already on screen still lands: it is the same layout arriving for a
  // different reason, and the reader has to see the change they made come back
  // out.
  //
  // Deliberately NOT routed through `adoptStoredValueRef` beside it: a
  // cross-tab adoption yields to an unflushed local edit (there is no authority
  // between two tabs), whereas this delivery IS the authority — the server has
  // already refused the edit, so yielding would leave the screen showing a
  // layout the account does not have. Not marked as an edit, for the same
  // reason a cross-tab adoption is not: `viewEditedRef` records what THIS reader
  // shaped, and the ISS-5528 ranking must not move because a server answered.
  const appliedInboundSeqRef = useRef<number | null>(null);
  useEffect(() => {
    const delivery = remote.inbound;
    if (
      !(delivery && restoredForCurrentInputs) ||
      appliedInboundSeqRef.current === delivery.seq
    ) {
      return;
    }
    appliedInboundSeqRef.current = delivery.seq;
    const record = decodeStoredRecord(delivery.serialized, parse);
    if (!record) {
      // A stored record this build cannot decode. Keep what is on screen rather
      // than fall back to the defaults — the server's copy is not lost, and a
      // newer build will decode it.
      return;
    }
    savedViewRestoredRef.current = true;
    // Take the residue from the ACCOUNT copy along with the rest of it. This
    // delivery is marked restored, so the persist effect re-serializes right
    // after — and without the carry that write would put the stripped record
    // back on the account, deleting a newer build's axis for every device on a
    // mount this reader never edited.
    opaqueFieldsRef.current = opaqueStoredViewFields(
      record.raw,
      record.parsed.extras
    );
    applySnapshot(normalizeStoredView(record.parsed), persistPageSize);
  }, [
    remote.inbound,
    restoredForCurrentInputs,
    parse,
    normalizeStoredView,
    applySnapshot,
    persistPageSize,
  ]);

  // ISS-9568: adopt another same-origin tab's write to THIS key. Everything the
  // handler needs is read through a ref so the subscription is keyed on the
  // two things that actually decide whether adopting is legal — the write key
  // and the committed restore — and is torn down the moment either changes.
  // Deliberately NOT marked as an edit: `viewEditedRef` records what THIS
  // reader shaped, and the ISS-5528 ranking of a shaped view over a
  // flag-selected default must not move because another tab wrote.
  const adoptStoredValueRef = useRef<(raw: string | null) => void>(() => {});
  adoptStoredValueRef.current = (raw) => {
    if (!storageKey) {
      return;
    }
    if (raw === null) {
      // The key was removed elsewhere. Keep what is on screen — a removal is
      // not a view to adopt — but forget the last write so the next local edit
      // lands instead of being deduped against bytes that are no longer there.
      lastWrittenRef.current = null;
      return;
    }
    if (unflushedEditRef.current) {
      // This tab has an edit that has COMMITTED but whose persist effect has not
      // run — a real gap, since a passive flush is a separate task from the one
      // delivering this event. Adopting here would drop that edit from the
      // screen and seed `lastWrittenRef` with the remote bytes, so the pending
      // run would dedupe itself away and the edit would reach neither. Skip
      // instead: the flush goes out and the OTHER tab adopts it in turn, which
      // is what `usePersistedSavedViews` does over the same window and what
      // `main` did by never adopting at all.
      return;
    }
    const record = decodeStoredRecord(raw, parse);
    if (!record) {
      return;
    }
    const snapshot = normalizeStoredView(record.parsed);
    savedViewRestoredRef.current = true;
    opaqueFieldsRef.current = opaqueStoredViewFields(
      record.raw,
      record.parsed.extras
    );
    applySnapshot(snapshot, persistPageSize);
    // Whichever way the gate reads, the write-back carries the adopted page
    // size (see `pageSizeToWrite` in the persist effect), so the snapshot's own
    // value is the byte-identical string. Seeded from the plain serializer, not
    // the shedding one (ISS-9449): the ref must hold what is ON DISK, and a
    // record past the ceiling is on disk exactly as the sibling wrote it. An
    // oversized adoption therefore seeds nothing, so the persist run that
    // follows answers for it — shedding the carry and writing that back, or
    // refusing — instead of deduping against bytes this tab never wrote.
    const adoptedSerialized = serializeTableView({
      ...snapshot,
      opaqueFields: opaqueFieldsRef.current,
    });
    lastWrittenRef.current =
      adoptedSerialized === null
        ? null
        : { key: storageKey, serialized: adoptedSerialized };
  };
  useEffect(() => {
    if (!(storageKey && restoredForCurrentInputs)) {
      return;
    }
    return subscribeToStorageKey(storageKey, (event) =>
      adoptStoredValueRef.current(event.newValue)
    );
  }, [storageKey, restoredForCurrentInputs]);

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
   *
   * ISS-8262: past the deadline this opens on the view restored from
   * `restoreStorageKey`, not on the defaults. Both conjuncts are load-bearing
   * there — the deadline flips `authSettled` and `restoreStorageKey` in the same
   * render, which makes `restoredForCurrentInputs` false until that key's own
   * restore commits, so the one read a stalled surface issues still carries the
   * saved sort rather than racing it.
   */
  const isViewReady = restoredForCurrentInputs && authSettled;

  const visibleColumns = useMemo(
    () => new Set<TColumnId>(columnIds.filter((id) => !hiddenColumns.has(id))),
    [columnIds, hiddenColumns]
  );

  // ISS-7052 Part A: `TSort`, not `NonNullable<TSort>`. The state and the
  // persisted schema have always allowed a null sort — "no explicit sort", which
  // is what lets a query omit `sortBy` and take the server's default order — but
  // the setter could not express it, so a host wired to a control that CLEARS
  // the sort (the v2 grid toolbar has one) could move that control and persist
  // nothing. Widening a parameter is safe for every existing caller: they all
  // pass a non-null key and still typecheck.
  const setSort = useCallback(
    (key: TSort, dir?: TSortDir) => {
      markViewEdited();
      setSortKey(key);
      if (dir) {
        setSortDir(dir);
      }
    },
    [markViewEdited]
  );

  const toggleSortDir = useCallback(() => {
    markViewEdited();
    setSortDir((dir) => (dir === ascSortDir ? descSortDir : ascSortDir));
  }, [ascSortDir, descSortDir, markViewEdited]);

  // ISS-5528: the feature `extras` setter, wrapped so a grouping/date-range/
  // metric-mode change counts as shaping the view exactly as a sort or a column
  // toggle does. The restore effect keeps using the raw setter, so applying a
  // stored view is never mistaken for editing one.
  const setExtrasEdited = useCallback(
    (value: SetStateAction<TExtra>) => {
      markViewEdited();
      setExtras(value);
    },
    [markViewEdited]
  );

  // ISS-9692: choose a rows-per-page. Marks the view EDITED for the same reason
  // a sort or a column toggle does — it is a choice the reader made and would
  // miss, and without the mark the ISS-5528 write gate would never flush it.
  //
  // NOT marked when the choice is not durable: a gated-off reader moving this
  // control would otherwise materialize a saved view out of the defaults, which
  // is the exact write ISS-5528 exists to prevent and which would then outrank a
  // later change to those defaults.
  const setPageSize = useCallback(
    (next: number) => {
      if (persistPageSize) {
        markViewEdited();
      }
      pendingAdoptedPageSizeRef.current = null;
      setPageSizeState(next);
    },
    [persistPageSize, markViewEdited]
  );

  const toggleColumn = useCallback(
    (id: TColumnId) => {
      markViewEdited();
      setHiddenColumns((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [markViewEdited]
  );

  // Reorder the data columns (FEA-4021). The primitive emits the full new id
  // order; keep only ids the table still has so a stale id can't linger.
  const setColumnOrderSafe = useCallback(
    (nextOrder: readonly string[]) => {
      markViewEdited();
      setColumnOrder(nextOrder.filter((id) => validColumnIds.has(id)));
    },
    [validColumnIds, markViewEdited]
  );

  // Resize one data column (FEA-4168). The primitive emits an already-clamped
  // width; keep it only for an id the table still has so a stale id can't inject
  // a phantom width. A merge (not replace) so each column's width is independent.
  const setColumnWidth = useCallback(
    (id: string, widthPx: number) => {
      if (!(validColumnIds.has(id) || isWidthOnlyColumnId?.(id))) {
        return;
      }
      markViewEdited();
      // ISS-10356: the width-only cap holds live too, so a resize cannot keep
      // what a reload would trim.
      setColumnWidths((prev) =>
        resizeColumnWidth(
          prev,
          { id, widthPx },
          validColumnIds,
          isWidthOnlyColumnId
        )
      );
    },
    [validColumnIds, isWidthOnlyColumnId, markViewEdited]
  );

  // Restore the feature's DEFAULT column visibility (all visible unless the
  // feature declares a `defaultHiddenColumns` set, ISS-5315) AND the natural
  // order AND natural widths — a feature's "Reset view". Reset means "back to
  // how the surface ships", so a feature whose default hides a column must land
  // there, not on a state the user has never seen.
  const resetColumns = useCallback(() => {
    markViewEdited();
    setHiddenColumns(new Set<TColumnId>(defaultHiddenColumnIds));
    setColumnOrder([]);
    setColumnWidths({});
    // The carried ids go too. A reset is the reader asking for the shipped
    // arrangement outright, so dropping them here is a choice they made and can
    // see — the opposite of the silent mount-time erasure ISS-9447 D1 removes.
    setPreservedColumnIds(NO_PRESERVED_COLUMN_IDS);
    // ISS-9447: and the stamps describing what was just rewritten, so the record
    // does not keep claiming a newer build's repair for a payload this build has
    // replaced. Here rather than in each surface's own "Reset view" because a
    // consumer calling `resetColumns` directly rewrites exactly the same axes.
    //
    // Inside the same gesture as the payload above, so the stamp and what it
    // describes reach `serializeTableView` in ONE commit — a sibling tab can
    // never adopt a record whose stamp outranks its payload. The
    // `markViewEdited` at the top is what holds that window shut: it raises
    // `unflushedEditRef`, so a `storage` event landing before this reset flushes
    // is skipped rather than adopted over it.
    if (resetColumnVersions) {
      setExtras(resetColumnVersions);
    }
  }, [defaultHiddenColumnIds, resetColumnVersions, markViewEdited]);

  // FEA-4180: apply a whole arrangement at once (switching to a named saved
  // view). Sets sort + order + visibility + extras together so a switch lands as
  // one coherent transition instead of a cascade of individual toggles. Unknown
  // hidden/order ids are not applied, exactly as on restore, so a stale id from
  // an old saved view cannot reorder or hide a column the table no longer has.
  const applyView = useCallback(
    (view: {
      sortKey: TSort;
      sortDir: TSortDir;
      hiddenColumns: readonly string[];
      columnOrder?: readonly string[];
      /**
       * ISS-9447 M5: widths and rows-per-page, for a surface whose named views
       * capture them. Omitted means "this view has no opinion" and the live
       * value stands — not capturing an axis is not asking for it cleared.
       */
      columnWidths?: Record<string, number>;
      pageSize?: number;
      /**
       * An updater, not a value, because `extras` carries more than the
       * arrangement: the ISS-9447 version envelope and any key only a NEWER
       * build names ride there, and an incoming arrangement says nothing about
       * either. Replacing the blob wholesale would erase them on every apply —
       * the same erasure the carried column ids below are exempt from. A plain
       * value still works for a surface whose extras are all arrangement.
       */
      extras: SetStateAction<TExtra>;
    }) => {
      markViewEdited();
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
      setColumnOrder(filterValidColumnOrder(view.columnOrder, validColumnIds));
      if (view.columnWidths) {
        // Filtered exactly as a restore filters them, so a width for a column
        // this build does not draw cannot enter state through the apply path
        // either. What the RESTORE carried stays carried — `preservedColumnIds`
        // is untouched below — but an unknown width in the INCOMING arrangement
        // is dropped rather than added to it: an arrangement captured inside the
        // app says nothing about a column its capturing build could not see,
        // which is why `partitionPreservedColumnIds` reads storage and nothing
        // else.
        setColumnWidths(
          filterValidColumnWidths(
            view.columnWidths,
            validColumnIds,
            isWidthOnlyColumnId
          )
        );
      }
      if (view.pageSize !== undefined) {
        // The same setter a reader's own choice takes, so the ISS-9692
        // durability gate answers both identically — and inside this callback,
        // so the whole arrangement reaches `serializeTableView` in ONE commit
        // and no sibling tab can adopt a half-applied view (ISS-9568).
        setPageSize(view.pageSize);
      }
      // The carried ids ride through untouched, on all three axes — the rule the
      // widths axis already followed, now the rule for every axis. An
      // arrangement captured on a build that could not see a column says nothing
      // about that column, so "the view did not mention it" is not "the reader
      // wants it gone"; re-deriving what to carry from the incoming view would
      // erase the carried ids on every apply, selecting the default view
      // included.
    },
    [validColumnIds, isWidthOnlyColumnId, markViewEdited, setPageSize]
  );

  return {
    sortKey,
    sortDir,
    extras,
    setExtras: setExtrasEdited,
    isViewReady,
    visibleColumns,
    columnOrder,
    setColumnOrder: setColumnOrderSafe,
    columnWidths,
    setColumnWidth,
    pageSize,
    setPageSize,
    setSort,
    toggleSortDir,
    toggleColumn,
    resetColumns,
    applyView,
  };
}
