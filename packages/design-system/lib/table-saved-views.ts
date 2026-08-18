/**
 * Generic, domain-agnostic model for NAMED, switchable table views (FEA-4180,
 * a follow-up to the FEA-4021/4150/4165 reorder/sort/show-hide work and
 * FEA-4168's column-width resize). A "saved view" is a named snapshot of a
 * table's arrangement — the caller decides what an arrangement *is* (its opaque
 * `arrangement` payload: column order + visibility + sort + filters, and — once
 * FEA-4168 lands — column widths), and this module owns only the collection
 * shape and the pure create/rename/switch/delete transforms plus a fail-soft
 * parser. Kept as pure functions over the collection so they unit-test in
 * isolation and stay shared by any table without pulling a feature slice into
 * the design system.
 *
 * The arrangement payload is intentionally opaque (`TArrangement`): the model
 * never inspects it, so a caller can widen it additively (e.g. slot
 * `columnWidths` into a saved view once FEA-4168 merges) without touching this
 * module. Version skew degrades gracefully — an unknown/malformed persisted
 * blob parses to an empty collection rather than throwing.
 */

/** A single named saved view: a stable id, a display name, and the opaque arrangement. */
export type SavedView<TArrangement> = {
  /** Stable, collision-resistant id (see `createSavedViewId`). */
  id: string;
  /** User-facing display name (already trimmed/non-empty when created). */
  name: string;
  /** Opaque, caller-owned arrangement payload — the model never inspects it. */
  arrangement: TArrangement;
};

/**
 * The persisted collection: the ordered list of named views plus the id of the
 * currently active one (or `null` when the caller is on the unnamed default
 * arrangement — i.e. no saved view is applied).
 */
export type SavedViewCollection<TArrangement> = {
  views: SavedView<TArrangement>[];
  /** Active view id, or `null` for the default (no saved view) arrangement. */
  activeViewId: string | null;
};

/** An empty collection: no saved views, on the default arrangement. */
export function emptySavedViewCollection<
  TArrangement,
>(): SavedViewCollection<TArrangement> {
  return { views: [], activeViewId: null };
}

/**
 * Generate a stable, collision-resistant view id. Prefers `crypto.randomUUID`
 * (available in browsers and the desktop renderer) and degrades to a
 * timestamp+random fallback where it is absent so the model never throws.
 */
export function createSavedViewId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalize a raw name to the stored form (trimmed). Returns `null` when the
 * name is empty after trimming, so callers can reject a blank name uniformly
 * instead of persisting an unnamed view.
 */
export function normalizeSavedViewName(rawName: string): string | null {
  const trimmed = rawName.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Add a new named view carrying `arrangement` and make it active. Returns a new
 * collection; inputs are never mutated. The name is normalized (trimmed) — an
 * empty name is rejected and the collection is returned unchanged so a blank
 * create is a no-op rather than persisting an unnamed view.
 */
export function addSavedView<TArrangement>(
  collection: SavedViewCollection<TArrangement>,
  rawName: string,
  arrangement: TArrangement
): SavedViewCollection<TArrangement> {
  const name = normalizeSavedViewName(rawName);
  if (name === null) {
    return collection;
  }
  const view: SavedView<TArrangement> = {
    id: createSavedViewId(),
    name,
    arrangement,
  };
  return {
    views: [...collection.views, view],
    activeViewId: view.id,
  };
}

/**
 * Rename the view with `id`. A no-op (returns the same collection) when the id
 * is absent or the new name is empty after trimming. Returns a new collection;
 * inputs are never mutated.
 */
export function renameSavedView<TArrangement>(
  collection: SavedViewCollection<TArrangement>,
  id: string,
  rawName: string
): SavedViewCollection<TArrangement> {
  const name = normalizeSavedViewName(rawName);
  if (name === null || !collection.views.some((view) => view.id === id)) {
    return collection;
  }
  return {
    ...collection,
    views: collection.views.map((view) =>
      view.id === id ? { ...view, name } : view
    ),
  };
}

/**
 * Delete the view with `id`. When the deleted view was active, the active id
 * falls back to `null` (the default arrangement) so no dangling id survives.
 * A no-op when the id is absent. Returns a new collection; inputs are never
 * mutated.
 */
export function deleteSavedView<TArrangement>(
  collection: SavedViewCollection<TArrangement>,
  id: string
): SavedViewCollection<TArrangement> {
  if (!collection.views.some((view) => view.id === id)) {
    return collection;
  }
  return {
    views: collection.views.filter((view) => view.id !== id),
    activeViewId: collection.activeViewId === id ? null : collection.activeViewId,
  };
}

/**
 * Overwrite the arrangement of the view with `id` with `arrangement`, keeping
 * its id, name, and list position. This is the "Update <name>" action — it lets
 * a user fold the live table state back into the view they are on instead of
 * always creating a new one. A no-op (returns the same collection) when the id
 * is absent. Returns a new collection; inputs are never mutated.
 */
export function updateSavedView<TArrangement>(
  collection: SavedViewCollection<TArrangement>,
  id: string,
  arrangement: TArrangement
): SavedViewCollection<TArrangement> {
  if (!collection.views.some((view) => view.id === id)) {
    return collection;
  }
  return {
    ...collection,
    views: collection.views.map((view) =>
      view.id === id ? { ...view, arrangement } : view
    ),
  };
}

/**
 * Switch the active view to `id` (or to `null` for the default arrangement).
 * A no-op that clears the active id to `null` when `id` names a view that does
 * not exist, so a stale id can never leave the switcher pointing at a missing
 * view. Returns a new collection; inputs are never mutated.
 */
export function setActiveSavedView<TArrangement>(
  collection: SavedViewCollection<TArrangement>,
  id: string | null
): SavedViewCollection<TArrangement> {
  if (id !== null && !collection.views.some((view) => view.id === id)) {
    return { ...collection, activeViewId: null };
  }
  return { ...collection, activeViewId: id };
}

/** The currently active view, or `null` when on the default arrangement. */
export function activeSavedView<TArrangement>(
  collection: SavedViewCollection<TArrangement>
): SavedView<TArrangement> | null {
  if (collection.activeViewId === null) {
    return null;
  }
  return (
    collection.views.find((view) => view.id === collection.activeViewId) ?? null
  );
}
