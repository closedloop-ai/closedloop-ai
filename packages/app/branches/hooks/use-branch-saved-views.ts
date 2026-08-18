"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useRef } from "react";
import { useOptionalAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { usePersistedSavedViews } from "../../shared/hooks/use-persisted-saved-views";
import type { DateRange } from "../../shared/lib/format-utils";
import type { BranchFilters } from "../lib/branch-row";
import {
  type BranchViewArrangement,
  branchArrangementsEqual,
  DEFAULT_BRANCH_ARRANGEMENT,
  parseBranchSavedViews,
} from "../lib/branch-saved-views";
import type { BranchSortDir, BranchSortKey } from "../lib/branch-sort-group";

/** The live dimensions the switcher CAPTURES into a new named saved view. */
export type BranchViewSnapshot = {
  sortKey: BranchSortKey;
  sortDir: BranchSortDir;
  dateRange: DateRange;
  hiddenColumns: string[];
  columnOrder: string[];
  filters: BranchFilters;
};

/** How a switched saved view is APPLIED back onto the live table state. */
export type BranchViewApply = {
  /** Sort + window + visibility + order applied together (`useBranchViewState`). */
  applyArrangement: (arrangement: {
    sortKey: BranchSortKey;
    sortDir: BranchSortDir;
    dateRange: DateRange;
    hiddenColumns: string[];
    columnOrder: string[];
  }) => void;
  /** The facet filters applied separately (`useBranchFilterState`). */
  applyFilters: (filters: BranchFilters) => void;
};

// Stable module-level parser reference so the generic store's restore effect
// does not re-run each render.
const parse = parseBranchSavedViews;

/**
 * NAMED, switchable Branches saved views (FEA-4180) — the follow-up to the
 * FEA-4021/4150/4165 reorder/sort/show-hide work and FEA-4168's width resize.
 * Wraps the generic `usePersistedSavedViews` store (which owns the collection +
 * `localStorage`) with the Branches arrangement shape, so both the web
 * `/branches` page and the desktop Branches view share one store keyed by
 * surface and cannot drift.
 *
 * `snapshot` is the CURRENT live arrangement (sort + window + columns +
 * filters), captured verbatim when the user saves a new view. `apply` pushes a
 * switched view's arrangement back onto the two live-state hooks — sort/window/
 * columns through `applyArrangement`, facet filters through `applyFilters` —
 * so a switch applies order, visibility, sort, AND filters together.
 *
 * `columnWidths` is intentionally out of the arrangement until FEA-4168 (PR
 * #3774) merges; see `branch-saved-views.ts` for the additive slot-in note.
 */
export function useBranchSavedViews(
  persistKey: string | undefined,
  snapshot: BranchViewSnapshot,
  apply: BranchViewApply,
  approved = false
) {
  // FEA-4180: saved views carry org-specific repo/owner filters and per-user
  // arrangements, but `localStorage` is shared by every account on the browser
  // and is NOT cleared on sign-out. Scope the persistence key by org + user so
  // one account/organization can never read or apply another's named views.
  // Both surfaces route through here: web supplies Clerk's user/org, desktop
  // supplies its keychain-session identity, so neither leaks across accounts.
  // Use the NON-throwing snapshot: a provider-less render (the branches page
  // test, Storybook, an unauthenticated surface) degrades to the stable
  // signed-out `anon`/`no-org` scope rather than crashing the whole page — the
  // per-account isolation still holds because a real provider yields the real
  // identity, and the signed-out fallback is itself a stable, non-leaking scope.
  const { isLoaded, userId, orgId } = useOptionalAuthSnapshot();
  const scopedKey = scopeSavedViewsKey(
    approved && persistKey ? `${persistKey}:approved` : persistKey,
    isLoaded,
    userId,
    orgId
  );

  const {
    views,
    activeViewId,
    createView,
    renameView,
    deleteView,
    updateView,
    selectView,
    restored,
    restoredKey,
  } = usePersistedSavedViews<BranchViewArrangement>({
    persistKey: scopedKey,
    keyPrefix: "branches:saved-views:",
    parse,
    onPersistError: notifySavedViewPersistFailed,
  });

  const { applyArrangement, applyFilters } = apply;

  // Push an arrangement (a switched view's, or the default) onto BOTH live-state
  // hooks together — sort/window/columns via `applyArrangement`, facet filters
  // via `applyFilters` — so a switch lands as one coherent transition.
  const applyArrangementAndFilters = useCallback(
    (arrangement: BranchViewArrangement) => {
      const normalized = normalizeArrangement(arrangement, approved);
      applyArrangement(normalized);
      applyFilters(normalized.filters);
    },
    [applyArrangement, applyFilters, approved]
  );

  // Reapply the restored active view's arrangement ONCE per storage key. The
  // store restores `activeViewId` so the trigger reads "Views: Mine" after a
  // reload or a return through the plain Branches route — but without this the
  // live table would keep whatever the URL/defaults produced, so the trigger
  // would name a view the table is not actually on (a control that lies).
  // Reapplying the arrangement makes the table match the name the trigger shows.
  //
  // Keyed to `restoredKey` and guarded by a ref so it fires exactly once per key
  // (not on every render, which would fight the user's own edits) yet re-fires
  // when the identity/key changes (org/user switch restores a different active
  // view). We intentionally do NOT depend on the live `snapshot` — this is a
  // mount/identity-change reapply, not a live sync.
  const reappliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!restored) {
      return;
    }
    if (reappliedKeyRef.current === restoredKey) {
      return;
    }
    reappliedKeyRef.current = restoredKey;
    if (activeViewId === null) {
      return;
    }
    const active = views.find((view) => view.id === activeViewId);
    if (active) {
      applyArrangementAndFilters(active.arrangement);
    }
  }, [restored, restoredKey, activeViewId, views, applyArrangementAndFilters]);

  const handleCreateView = useCallback(
    (name: string) =>
      createView(name, normalizeArrangement(snapshot, approved)),
    [createView, snapshot, approved]
  );

  const handleSelectView = useCallback(
    (id: string | null) => {
      const arrangement = selectView(id);
      // A named view returns its snapshot; "Default view" (`null`, or a missing
      // view) returns `null`. Selecting "Default view" must RESTORE the default
      // arrangement — sort, window, all columns visible in natural order, and
      // cleared facet filters — not merely clear the active marker, otherwise
      // the table stays on the saved layout while the trigger claims it is on
      // the defaults (a control that lies about its state).
      applyArrangementAndFilters(arrangement ?? defaultArrangement(approved));
    },
    [selectView, applyArrangementAndFilters, approved]
  );

  const handleDeleteView = useCallback(
    (id: string) => {
      // Deleting the ACTIVE view leaves the switcher on "Default view" (the
      // model clears `activeViewId` when the active view is removed), so the
      // live table must fall back to the default arrangement too — same reason
      // as selecting "Default view": don't strand the deleted view's layout on
      // screen under a "Default view" label.
      const wasActive = id === activeViewId;
      deleteView(id);
      if (wasActive) {
        applyArrangementAndFilters(defaultArrangement(approved));
      }
    },
    [deleteView, activeViewId, applyArrangementAndFilters, approved]
  );

  // Fold the CURRENT live arrangement back into the active view (the "Update
  // <name>" action). Overwriting the existing view — rather than only ever
  // creating a new one — is what stops the Mine / Mine 2 / Mine 3 pileup the
  // reviewer flagged. Snapshot is captured verbatim, matching create.
  const handleUpdateView = useCallback(
    (id: string) => updateView(id, normalizeArrangement(snapshot, approved)),
    [updateView, snapshot, approved]
  );

  // Whether the live table has DIVERGED from the active view's saved snapshot,
  // so the switcher shows a "modified" marker and offers "Update <name>" and the
  // trigger never claims the table is exactly on a view it has drifted from
  // (the on-return / after-edit "lie" the reviewer called out). On the default
  // arrangement (no active view) there is nothing to diverge from → not
  // modified. Compared set-insensitively for column/facet lists so re-selecting
  // the same facets in a different order is not a false "modified".
  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const modified = activeView
    ? !branchArrangementsEqual(
        normalizeArrangement(activeView.arrangement, approved),
        normalizeArrangement(snapshot, approved)
      )
    : false;

  return {
    views,
    activeViewId,
    modified,
    onSelectView: handleSelectView,
    onCreateView: handleCreateView,
    onUpdateView: handleUpdateView,
    onRenameView: renameView,
    onDeleteView: handleDeleteView,
  };
}

function normalizeArrangement(
  arrangement: BranchViewArrangement | BranchViewSnapshot,
  approved: boolean
): BranchViewArrangement {
  if (!approved) {
    return { ...arrangement };
  }
  return {
    ...arrangement,
    columnOrder: [],
    filters: { ...arrangement.filters, sessionPresence: [] },
  };
}

function defaultArrangement(approved: boolean): BranchViewArrangement {
  return approved
    ? { ...DEFAULT_BRANCH_ARRANGEMENT, dateRange: "30d" }
    : DEFAULT_BRANCH_ARRANGEMENT;
}

/**
 * Build the org+user-scoped `localStorage` key for a surface's saved views, or
 * `undefined` when the surface is memory-only (`baseKey` omitted). Returns
 * `undefined` until auth has hydrated so the empty default is never persisted
 * under an unscoped/`anon` key that a later-resolved identity would then read.
 * A signed-out session (loaded, null identity) falls back to stable `anon`/
 * `no-org` segments rather than persisting to a shared unscoped key.
 */
export function scopeSavedViewsKey(
  baseKey: string | undefined,
  isLoaded: boolean,
  userId: string | null,
  orgId: string | null
): string | undefined {
  if (!(baseKey && isLoaded)) {
    return;
  }
  return `${orgId ?? "no-org"}:${userId ?? "anon"}:${baseKey}`;
}

// Stable module-level handler so the persist effect's error callback reference
// never changes across renders. Fired when a saved-view write to localStorage
// fails (quota / private mode) AFTER the store has rolled the change back, so
// the toast matches what the user now sees: the view was not saved.
function notifySavedViewPersistFailed() {
  toast.error("Couldn't save your view — storage is full or unavailable.");
}
