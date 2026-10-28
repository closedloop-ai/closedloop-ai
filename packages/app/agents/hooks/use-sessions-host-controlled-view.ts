"use client";

import { useCallback, useMemo, useState } from "react";
import type { SessionsCustomFieldsController } from "../components/sessions/sessions-list-custom-fields";
import { buildSessionsCustomFieldColumns } from "../components/sessions/sessions-list-custom-fields";
import {
  EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  type SessionsListViewController,
  type SessionsListViewState,
} from "../components/sessions/sessions-list-view-state";
import {
  isSessionsListReadTotalKnown,
  type SessionsListReadState,
} from "../lib/sessions-list-read-state";
import {
  DEFAULT_SESSIONS_HOST_LOCAL_VIEW,
  reconcileSessionsGrouping,
  reconcileSessionsVisibleColumns,
  type SessionsHostLocalView,
  type SessionsHostViewState,
  toHiddenCustomFieldColumnIds,
  toSessionsHostViewState,
  toSessionsListViewState,
} from "../lib/sessions-list-view-adapter";

/**
 * ISS-12455: the whole `SessionsListViewController` a Sessions host hands
 * `SessionsListSurfaceV2`, composed once for every shell that mounts it.
 *
 * A host's persisted vocabulary is strictly narrower than the surface's view
 * state, and `SESSIONS_VIEW_STATE_AXIS_OWNERS` already records which axes it
 * cannot carry. Holding those axes and rejoining them each render is therefore
 * not shell-specific work — it is the other half of that adapter, and a shell
 * that writes its own copy gets the direction right for whichever axis its
 * author happened to be thinking about. The desktop host held `grouping` and
 * not the custom-field halves, so `toSessionsListViewState` fed the surface a
 * built-in-only `visibleColumnIds`, the headers filtered every custom-field
 * column out against it, and `toSessionsHostViewState` stripped the id again on
 * each View-menu toggle: the columns could not be shown and could not be turned
 * on.
 *
 * `customFieldColumnIds` is derived here from the same
 * `buildSessionsCustomFieldColumns` the surface builds its headers from, so a
 * host cannot come to a different answer than the headers do about which
 * columns are on offer — the `showInTable` filter lives in that helper.
 */
export function useSessionsHostControlledView({
  customFields,
  hostView,
  listReadState,
  onHostViewChange,
  total,
}: {
  customFields: SessionsCustomFieldsController | undefined;
  hostView: SessionsHostViewState;
  listReadState: SessionsListReadState;
  onHostViewChange: (next: SessionsHostViewState) => void;
  total: number;
}): {
  controlledView: SessionsListViewController;
  /**
   * What "Reset view" has to call BEFORE the host restores its own half.
   *
   * The reconcilers drop this store's copy only when the host's persisted
   * dimension MOVES, and a reset from `groupBy: None` back to `groupBy: None`
   * moves nothing — so a reset that did not clear this would leave the
   * sub-group banding the table and every hidden custom column still hidden.
   */
  resetLocalView: () => void;
} {
  const [localView, setLocalView] = useState<SessionsHostLocalView>(
    () => DEFAULT_SESSIONS_HOST_LOCAL_VIEW
  );

  const customFieldColumnIds = useMemo(
    () =>
      buildSessionsCustomFieldColumns(customFields).map((column) => column.id),
    [customFields]
  );

  const resetLocalView = useCallback(() => {
    setLocalView(DEFAULT_SESSIONS_HOST_LOCAL_VIEW);
  }, []);

  const controlledView = useMemo(() => {
    const persisted = toSessionsListViewState(hostView);
    const totalRowsKnown = isSessionsListReadTotalKnown({
      state: listReadState,
      totalRows: total,
    });
    return {
      onChange: (next: SessionsListViewState) => {
        const nextLocalView: SessionsHostLocalView = {
          customFieldFilters:
            next.customFieldFilters ?? EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
          grouping: next.grouping,
          hiddenCustomFieldColumnIds: toHiddenCustomFieldColumnIds(
            next.visibleColumnIds,
            customFieldColumnIds
          ),
        };
        // `toHiddenCustomFieldColumnIds` builds a new Set on every call, so an
        // unconditional write re-renders even when nothing changed. The surface
        // reports during render-driven repairs (the stale-page clamp), and that
        // re-render reports again: "Maximum update depth exceeded".
        setLocalView((current) =>
          isSameLocalView(current, nextLocalView) ? current : nextLocalView
        );
        onHostViewChange(toSessionsHostViewState(next));
      },
      readState: listReadState,
      ...(totalRowsKnown ? { totalRows: total } : {}),
      value: {
        ...persisted,
        // ISS-8216: a `custom-field:*` id has no slot in a host's closed facet
        // vocabulary, so this store's copy is the only one there is.
        customFieldFilters: localView.customFieldFilters,
        // Each reconciler keeps this store's richer copy only while it still
        // agrees with what the host persisted, so a saved view or a Reset that
        // moves the primary dimension wins instead of leaving a stale
        // sub-level banding the table.
        grouping: reconcileSessionsGrouping(
          hostView.groupBy,
          localView.grouping
        ),
        // FEA-4222: the host's persisted columns REJOINED with the custom half
        // it cannot store.
        visibleColumnIds: reconcileSessionsVisibleColumns(
          persisted.visibleColumnIds,
          customFieldColumnIds,
          localView.hiddenCustomFieldColumnIds
        ),
      },
    };
  }, [
    customFieldColumnIds,
    hostView,
    listReadState,
    localView,
    onHostViewChange,
    total,
  ]);

  return { controlledView, resetLocalView };
}

function isSameLocalView(
  current: SessionsHostLocalView,
  next: SessionsHostLocalView
): boolean {
  return (
    current.customFieldFilters === next.customFieldFilters &&
    current.grouping === next.grouping &&
    current.hiddenCustomFieldColumnIds.size ===
      next.hiddenCustomFieldColumnIds.size &&
    [...next.hiddenCustomFieldColumnIds].every((columnId) =>
      current.hiddenCustomFieldColumnIds.has(columnId)
    )
  );
}
