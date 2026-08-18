"use client";

import {
  addSavedView,
  deleteSavedView,
  emptySavedViewCollection,
  renameSavedView,
  type SavedView,
  type SavedViewCollection,
  setActiveSavedView,
  updateSavedView,
} from "@repo/design-system/lib/table-saved-views";
import { useCallback, useEffect, useRef, useState } from "react";

export type PersistedSavedViewsConfig<TArrangement> = {
  /** Surface key; when omitted the collection is memory-only (no persistence). */
  persistKey?: string;
  /** localStorage key namespace, e.g. `"branches:saved-views:"`. */
  keyPrefix: string;
  /**
   * Validate an already-JSON-parsed value into a saved-view collection, or
   * `null` when it is missing/malformed. Pass a stable (module-level) function
   * reference so the restore effect does not re-run every render.
   */
  parse: (raw: unknown) => SavedViewCollection<TArrangement> | null;
  /**
   * Invoked when persisting the collection to `localStorage` fails (quota
   * exceeded, private/incognito mode, storage disabled). The failed mutation is
   * ROLLED BACK to the last-persisted collection before this fires, so the UI
   * never shows a "saved" row that vanishes on refresh. The feature layer wires
   * this to a toast so the user learns the change did not stick. Optional — a
   * memory-only surface (no `persistKey`) never persists and never calls it.
   */
  onPersistError?: () => void;
};

function loadCollection<TArrangement>(
  keyPrefix: string,
  persistKey: string,
  parse: (raw: unknown) => SavedViewCollection<TArrangement> | null
): SavedViewCollection<TArrangement> | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(`${keyPrefix}${persistKey}`);
    if (!raw) {
      return null;
    }
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Generic persistence + mutation machinery for a collection of NAMED, switchable
 * table views (FEA-4180), shared by both the web app and the desktop renderer.
 * Owns the `SavedViewCollection` (the ordered named views + the active id) and
 * the single `localStorage` object that persists it — keyed by surface and
 * fail-soft (private mode, malformed JSON, unknown/legacy shapes all degrade to
 * an empty collection rather than throwing).
 *
 * Deliberately a SIBLING of `usePersistedTableViewState` (which owns the single
 * live sort/columns/filters arrangement) rather than an extension of it: this
 * hook stores the caller's *opaque* arrangement snapshots and never inspects
 * them, so a caller widens the arrangement additively (e.g. slots FEA-4168's
 * `columnWidths` into a saved view) without touching this hook. The two compose
 * in a feature hook — one owns the live view, this one owns the named snapshots.
 *
 * Like the live-view hook (FEA-4125), the persisted collection is restored in a
 * POST-MOUNT effect, not a `useState` initializer, so the first client render
 * matches the server-rendered HTML and hydration stays stable; the persist
 * effect is gated on the `restored` flag so the empty default never clobbers the
 * saved collection before it is read.
 */
export function usePersistedSavedViews<TArrangement>(
  config: PersistedSavedViewsConfig<TArrangement>
) {
  const { persistKey, keyPrefix, parse, onPersistError } = config;

  const [collection, setCollection] = useState<
    SavedViewCollection<TArrangement>
  >(() => emptySavedViewCollection<TArrangement>());
  // The collection last known to be safely on disk under the current key. On a
  // write failure the in-memory collection is rolled back to this so a mutation
  // that could not be persisted (quota / private mode) does not leave a row that
  // looks saved but vanishes on refresh. Kept in a ref (not state) so updating
  // it after a successful write does not itself trigger a re-render/re-write.
  const lastPersistedRef =
    useRef<SavedViewCollection<TArrangement>>(collection);
  // Latest error callback in a ref so the write effect need not depend on it
  // (an unstable inline callback would otherwise re-run the effect each render).
  const onPersistErrorRef = useRef(onPersistError);
  onPersistErrorRef.current = onPersistError;
  // The storage key this hook has finished restoring under. `null` = nothing
  // restored yet. Tracked (not a one-shot ref) so an identity change that
  // rekeys the store — a signed-in user switching org, FEA-4180 — RE-restores
  // the new key's collection instead of leaving the old one in memory, which
  // the write effect below would otherwise persist under the new key (cross-
  // account/-org leak). The full storage key folds the prefix in so a prefix
  // change also forces a reload.
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const fullKey =
    persistKey === undefined ? undefined : `${keyPrefix}${persistKey}`;
  const restored = restoredKey === (fullKey ?? null);

  useEffect(() => {
    if (restored) {
      return;
    }
    // Load the collection for the CURRENT key before enabling write-back, so a
    // stale in-memory collection from a previous key is never flushed under the
    // new one. A memory-only surface (`persistKey` omitted) resets to empty.
    const restoredCollection = persistKey
      ? (loadCollection(keyPrefix, persistKey, parse) ??
        emptySavedViewCollection<TArrangement>())
      : emptySavedViewCollection<TArrangement>();
    // The restored value IS what's on disk for this key, so seed the rollback
    // baseline to it before enabling write-back — a first failed write rolls
    // back to the persisted collection, not to a stale previous-key baseline.
    lastPersistedRef.current = restoredCollection;
    setCollection(restoredCollection);
    setRestoredKey(fullKey ?? null);
  }, [persistKey, keyPrefix, parse, restored, fullKey]);

  useEffect(() => {
    // Gate writes on `restored` for THIS key: while a new key is still loading
    // (identity just changed), the collection in memory still belongs to the
    // old key and must not be written under the new one.
    if (!(persistKey && restored) || typeof localStorage === "undefined") {
      return;
    }
    // Skip when the in-memory collection already equals the last-persisted one.
    // This covers two cases: (1) the restored collection was never mutated, so
    // there is nothing new to flush, and (2) the effect re-runs after a failed
    // write rolled the collection back to this baseline — re-writing it would
    // just fail again and double-report the error.
    if (collection === lastPersistedRef.current) {
      return;
    }
    try {
      localStorage.setItem(
        `${keyPrefix}${persistKey}`,
        JSON.stringify(collection)
      );
      lastPersistedRef.current = collection;
    } catch {
      // Quota exceeded / private mode / storage disabled: the mutation did not
      // stick. Roll the in-memory collection back to the last-persisted value
      // so the switcher never shows a view that is gone on refresh, and report
      // the failure so the feature layer can tell the user.
      setCollection(lastPersistedRef.current);
      onPersistErrorRef.current?.();
    }
  }, [persistKey, keyPrefix, restored, collection]);

  // Save the caller's CURRENT arrangement as a new named view and make it
  // active. Blank names are rejected in the pure model (no-op).
  const createView = useCallback((name: string, arrangement: TArrangement) => {
    setCollection((prev) => addSavedView(prev, name, arrangement));
  }, []);

  const renameView = useCallback((id: string, name: string) => {
    setCollection((prev) => renameSavedView(prev, id, name));
  }, []);

  const deleteView = useCallback((id: string) => {
    setCollection((prev) => deleteSavedView(prev, id));
  }, []);

  // Overwrite an existing view's arrangement with `arrangement` (the "Update
  // <name>" action) — keeps the id/name/position, so folding the live table
  // state back into the active view does not spawn a "Mine 2".
  const updateView = useCallback((id: string, arrangement: TArrangement) => {
    setCollection((prev) => updateSavedView(prev, id, arrangement));
  }, []);

  // Switch the active view (or to `null` for the default arrangement). Returns
  // the arrangement to apply so the caller can push it into the live view
  // state; `null` means "restore the default arrangement" and the caller
  // decides what that is. The returned arrangement is derived synchronously
  // from the current collection (not from inside the setState updater, which
  // React may run deferred/twice) so the caller always gets the right payload.
  const selectView = useCallback(
    (id: string | null): TArrangement | null => {
      const target: SavedView<TArrangement> | null =
        id === null
          ? null
          : (collection.views.find((view) => view.id === id) ?? null);
      setCollection((prev) => setActiveSavedView(prev, id));
      return target ? target.arrangement : null;
    },
    [collection.views]
  );

  return {
    views: collection.views,
    activeViewId: collection.activeViewId,
    createView,
    renameView,
    deleteView,
    updateView,
    selectView,
    // Whether the collection for the CURRENT key has finished loading from
    // storage. Callers that must apply the restored active view exactly once
    // (so the table matches the trigger on mount) gate that on this flag.
    restored,
    // The storage key the current collection was restored under (`null` before
    // the first restore, or for a memory-only surface). Callers key their
    // one-shot reapply on this so an identity switch (org/user change) re-applies
    // the NEW key's active view instead of staying on the old one.
    restoredKey,
  };
}
