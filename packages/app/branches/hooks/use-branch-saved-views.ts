"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { usePersistedSavedViews } from "../../shared/hooks/use-persisted-saved-views";
import type { BranchFilters } from "../lib/branch-row";
import {
  type BranchAppliedArrangement,
  type BranchViewArrangement,
  branchArrangementsEqual,
  DEFAULT_BRANCH_ARRANGEMENT,
  mergeBranchArrangement,
  parseBranchSavedViews,
} from "../lib/branch-saved-views";

/**
 * The live dimensions the switcher CAPTURES into a new named saved view — the
 * whole arrangement, since capture and apply have to describe the same view.
 *
 * `pageSize` is REQUIRED here while the stored arrangement leaves it optional,
 * and the asymmetry is the point: optional on the stored shape means "a view
 * saved before ISS-9447 M5 has none", which is a fact about old data, whereas a
 * LIVE table always has a rows-per-page. Requiring it is what makes a shell that
 * forgets to capture it fail `tsc` — both `apps/app` and `apps/desktop` assemble
 * this object themselves, so nothing else holds the two to the same capture.
 */
export type BranchViewSnapshot = BranchViewArrangement & { pageSize: number };

/** How a switched saved view is APPLIED back onto the live table state. */
export type BranchViewApply = {
  /**
   * Sort + window + visibility + order + widths + rows-per-page applied
   * together (`useBranchViewState`).
   */
  applyArrangement: (arrangement: BranchAppliedArrangement) => void;
  /**
   * The facet filters applied separately (`useBranchFilterState`), carrying the
   * arrangement's rows-per-page with them.
   *
   * ISS-9447 M5: the size travels on THIS call rather than a second one because
   * both land in the surface's URL, and two writes would each start from the
   * pre-switch params. Omitted when the application is not a gesture the reader
   * just made — see `applyArrangementAndFilters`.
   */
  applyFilters: (filters: BranchFilters, appliedPageSize?: number) => void;
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
 * `snapshot` is the CURRENT live arrangement (sort + window + columns + widths
 * + rows-per-page + filters), captured verbatim when the user saves a new view.
 * `apply` pushes a switched view's arrangement back onto the two live-state
 * hooks — everything but the facets through `applyArrangement`, facet filters
 * through `applyFilters` — so a switch applies order, visibility, sort, widths,
 * rows-per-page AND filters together.
 *
 * ISS-9447 M5 added the last two: `columnWidths` and `pageSize` were persisted
 * by the single live view and dropped by this one, so a reader who resized a
 * column or chose 100 rows, saved the view, and came back got neither.
 *
 * The collection itself is owned by {@link useBranchSavedViewsStore}, which the
 * host calls FIRST and passes in here — see that hook for why the two halves are
 * separate.
 */
export function useBranchSavedViews(
  store: BranchSavedViewsStore,
  snapshot: BranchViewSnapshot,
  apply: BranchViewApply
) {
  const {
    approved,
    views,
    activeViewId,
    createView,
    renameView,
    deleteView,
    updateView,
    selectView,
    restored,
    restoredKey,
    adoptionCount,
    appliedAdoptionCount,
    isArrangementSettled,
    markAdoptionApplied,
    markArrangementSettled,
  } = store;

  const { applyArrangement, applyFilters } = apply;

  // ISS-10209 removed the Views control outright. Keep restoring the collection
  // so its org-scoped data is preserved, but do not automatically apply its
  // active arrangement: that would strand the table behind filters and layout
  // that nothing on screen names or lets the reader clear.

  // Push an arrangement (a switched view's, or the default) onto BOTH live-state
  // hooks together — sort/window/columns via `applyArrangement`, facet filters
  // via `applyFilters` — so a switch lands as one coherent transition.
  //
  // `restatePageSize` marks applications the READER performed. Only those
  // replace the size this visit stated (a `?pageSize=` link, or the footer); a
  // passive application must preserve that statement so a shared link does not
  // page differently for whoever opens it (ISS-9692).
  const applyArrangementAndFilters = useCallback(
    (arrangement: BranchViewArrangement, restatePageSize: boolean) => {
      const normalized = normalizeArrangement(arrangement, approved);
      applyArrangement(normalized);
      if (restatePageSize) {
        // RAW here too, for the reason `useBranchViewState` gives: `undefined`
        // is "this view says nothing about rows-per-page", and
        // `handleFiltersChange` leaves the stated size and the URL param alone
        // when it gets one. Resolving it to the surface default made applying a
        // pre-M5 view overwrite the reader's `?pageSize=` with a 25 that view
        // never captured.
        applyFilters(normalized.filters, normalized.pageSize);
        return;
      }
      applyFilters(normalized.filters);
    },
    [applyArrangement, applyFilters, approved]
  );

  // Settle each restored collection key once without applying its active view.
  // The read gate still waits for identity-specific storage to restore, so an
  // org switch cannot issue a request while the old collection is in memory;
  // ISS-10209's removed control means the restored collection is storage-only.
  const settledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!restored) {
      return;
    }
    if (settledKeyRef.current === restoredKey) {
      return;
    }
    settledKeyRef.current = restoredKey;
    // A restored collection is settled whether or not it has an active view;
    // neither case changes the visible table while the control is absent.
    markArrangementSettled(restoredKey);
  }, [restored, restoredKey, markArrangementSettled]);

  // A cross-tab adoption briefly closes `isArrangementSettled`. Acknowledge it
  // without applying the adopted named view, for the same ISS-10209 reason as
  // mount restoration: the collection stays current and org-isolated while the
  // visible live table remains the only arrangement the reader can control.
  useEffect(() => {
    if (adoptionCount === appliedAdoptionCount) {
      return;
    }
    markAdoptionApplied(adoptionCount);
  }, [adoptionCount, appliedAdoptionCount, markAdoptionApplied]);
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
      applyArrangementAndFilters(
        arrangement ?? DEFAULT_BRANCH_ARRANGEMENT,
        true
      );
    },
    [selectView, applyArrangementAndFilters]
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
        applyArrangementAndFilters(DEFAULT_BRANCH_ARRANGEMENT, true);
      }
    },
    [deleteView, activeViewId, applyArrangementAndFilters]
  );

  // Fold the CURRENT live arrangement back into the active view (the "Update
  // <name>" action). Overwriting the existing view — rather than only ever
  // creating a new one — is what stops the Mine / Mine 2 / Mine 3 pileup the
  // reviewer flagged. Snapshot is captured verbatim, matching create.
  const handleUpdateView = useCallback(
    (id: string) => {
      const live = normalizeArrangement(snapshot, approved);
      const stored = views.find((view) => view.id === id);
      // Laid over what the view already held, so a key only a NEWER build names
      // survives the edit. `updateSavedView` replaces the arrangement whole — its
      // documented contract — so anything this build does not own has to be
      // carried in by the caller or it is deleted on the reader's first Update.
      updateView(
        id,
        stored ? mergeBranchArrangement(stored.arrangement, live) : live
      );
    },
    [updateView, views, snapshot, approved]
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
    /**
     * Re-exported from the store so a consumer holding this hook's result (the
     * cohort gate on both hosts) reads the same answer the list read gate
     * already took from {@link useBranchSavedViewsStore}.
     */
    isArrangementSettled,
    onSelectView: handleSelectView,
    onCreateView: handleCreateView,
    onUpdateView: handleUpdateView,
    onRenameView: renameView,
    onDeleteView: handleDeleteView,
  };
}

/**
 * The persisted saved-view COLLECTION plus the two flags that say whether the
 * restored active view has actually reached the live table — the half of
 * {@link useBranchSavedViews} a host can call before it has anything else.
 *
 * WHY IT IS SEPARATE. `isArrangementSettled` is a read gate: a list read issued
 * before the active view's arrangement lands goes out under the pre-application
 * sort, window and rows-per-page and is immediately replaced (ISS-8127, and
 * ISS-9447 M5 again once rows-per-page became a view axis). But
 * {@link useBranchSavedViews} needs the resolved `filters` and
 * `handleFiltersChange`, which on both hosts are derived FROM the list response
 * — so the whole hook can only be called after the read it is supposed to gate.
 * Splitting the store off is what puts the flag in the host's hands one hook
 * earlier, where `useUrlSyncedBranchServerState` folds it into `isReadReady`
 * beside the two facts ISS-9692 already composed there. One answer, both shells.
 *
 * It fails OPEN, which is the property that keeps the gate from being able to
 * hang the table: an unresolved identity yields no scoped key
 * ({@link scopeSavedViewsKey}), a keyless collection is memory-only, and
 * `usePersistedSavedViews` reports such a collection restored on its first
 * commit — with `restoredKey` and `settledKey` both `null`. So a stalled auth
 * hydration degrades to the pre-gate double read, never to a permanent skeleton.
 */
export function useBranchSavedViewsStore(
  persistKey: string | undefined,
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
  const collection = usePersistedSavedViews<BranchViewArrangement>({
    persistKey: scopedKey,
    keyPrefix: "branches:saved-views:",
    parse,
    onPersistError: notifySavedViewPersistFailed,
  });
  // ISS-8127 (davetho review): the key the reapply has FINISHED for, in state
  // so settling re-renders. `restored` alone is not that signal — it says the
  // collection is loaded, and the arrangement is pushed onto the live hooks one
  // commit later, so a consumer gating on `restored` opens while `dateRange` is
  // still the pre-application one.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  // ISS-9568: an adoption commits the new `views`/`activeViewId` one commit
  // BEFORE the arrangement reaches the live hooks, so a flag that ignored the
  // count would stay true across that commit.
  const [appliedAdoptionCount, setAppliedAdoptionCount] = useState(0);
  return {
    ...collection,
    appliedAdoptionCount,
    approved,
    isArrangementSettled:
      collection.restored &&
      settledKey === collection.restoredKey &&
      appliedAdoptionCount === collection.adoptionCount,
    markAdoptionApplied: setAppliedAdoptionCount,
    markArrangementSettled: setSettledKey,
  };
}

/** What {@link useBranchSavedViewsStore} hands {@link useBranchSavedViews}. */
export type BranchSavedViewsStore = ReturnType<typeof useBranchSavedViewsStore>;

function normalizeArrangement(
  arrangement: BranchViewArrangement | BranchViewSnapshot,
  approved: boolean
): BranchViewArrangement {
  if (!approved) {
    return { ...arrangement };
  }
  return {
    ...arrangement,
    filters: { ...arrangement.filters, sessionPresence: [] },
  };
}

/**
 * Build the org+user-scoped `localStorage` key for a surface's saved views, or
 * `undefined` when the surface is memory-only (`baseKey` omitted). Returns
 * `undefined` until auth has hydrated so the empty default is never persisted
 * under an unscoped/`anon` key that a later-resolved identity would then read.
 * A signed-out session (loaded, null identity) falls back to stable `anon`/
 * `no-org` segments rather than persisting to a shared unscoped key.
 *
 * This remains org-scoped even while the live table key rolls out org scoping
 * separately. Named views contain org-specific owner and repository filters,
 * so reading them through a user-only key would expose one org's arrangement in
 * another. Since ISS-10209 removed the saved-views control and its automatic
 * application, this deliberate mismatch does not create a pre-restore list
 * read; the store settles without applying an invisible named arrangement.
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
