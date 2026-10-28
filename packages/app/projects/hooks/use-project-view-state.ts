"use client";

import type { TableToolbarSavedView } from "@repo/app/shared/components/table-toolbar-controls";
import { MIN_COLUMN_WIDTH_PX } from "@repo/design-system/lib/column-order";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
} from "react";
import { useOptionalPersistedState } from "../../shared/hooks/use-optional-persisted-state";
import { usePersistedSavedViews } from "../../shared/hooks/use-persisted-saved-views";
import {
  PROJECT_SAVED_VIEWS_KEY_PREFIX,
  type ProjectColumnPreferences,
  type ProjectViewState,
  parseProjectColumnPreferences,
  parseProjectSavedViews,
} from "../lib/project-saved-views";
import {
  PROJECT_SUMMARY_COLUMN_IDS,
  PROJECT_SUMMARY_COLUMNS,
  PROJECT_SUMMARY_LEADING_COLUMN_WIDTH_PX,
} from "../lib/project-summary-columns";

/**
 * Durable view state for the portable Projects surface (ISS-10476 review).
 *
 * Both halves take the host's already-namespaced storage key and both accept
 * `null`/`undefined` as "hold this in memory and persist nothing" — the contract
 * `useViewStateKey` and `useOptionalPersistedState` already speak. That is what
 * lets one component serve the product route, where the reader's columns and
 * named views must survive a reload, and the prototype sandbox, which has no
 * identity to key a store on and must not write one.
 */

const DEFAULT_COLUMN_PREFERENCES: ProjectColumnPreferences = {
  columnOrder: [...PROJECT_SUMMARY_COLUMN_IDS],
  columnWidths: Object.fromEntries(
    PROJECT_SUMMARY_COLUMNS.map((column) => [
      column.id,
      column.width.default ?? MIN_COLUMN_WIDTH_PX,
    ])
  ),
  hiddenColumnIds: [],
  leadingColumnWidth: PROJECT_SUMMARY_LEADING_COLUMN_WIDTH_PX,
};

export type ProjectColumnPreferencesController = {
  columnOrder: string[];
  columnWidths: Record<string, number>;
  leadingColumnWidth: number;
  setColumnOrder: (next: (current: string[]) => string[]) => void;
  setColumnWidth: (columnId: string, widthPx: number) => void;
  setLeadingColumnWidth: (widthPx: number) => void;
  setVisibleColumnIds: Dispatch<SetStateAction<Set<string>>>;
  visibleColumnIds: Set<string>;
};

/**
 * Column visibility, order and widths, persisted under the host's key.
 *
 * HIDDEN ids are what is stored, not visible ones: a column added to
 * {@link PROJECT_SUMMARY_COLUMNS} in a later build then arrives VISIBLE for a
 * reader who already has a stored preference, instead of being silently absent
 * because a list written before it existed does not name it.
 */
export function useProjectColumnPreferences(
  viewStateKey?: string | null
): ProjectColumnPreferencesController {
  const [preferences, setPreferences] =
    useOptionalPersistedState<ProjectColumnPreferences>(
      viewStateKey === undefined ? null : viewStateKey,
      DEFAULT_COLUMN_PREFERENCES,
      parseProjectColumnPreferences
    );

  const visibleColumnIds = useMemo(
    () =>
      new Set(
        PROJECT_SUMMARY_COLUMN_IDS.filter(
          (id) => !preferences.hiddenColumnIds.includes(id)
        )
      ),
    [preferences.hiddenColumnIds]
  );

  const setVisibleColumnIds = useCallback<
    Dispatch<SetStateAction<Set<string>>>
  >(
    (action) => {
      setPreferences((current) => {
        const currentVisible = new Set(
          PROJECT_SUMMARY_COLUMN_IDS.filter(
            (id) => !current.hiddenColumnIds.includes(id)
          )
        );
        const next =
          typeof action === "function" ? action(currentVisible) : action;
        return {
          ...current,
          hiddenColumnIds: PROJECT_SUMMARY_COLUMN_IDS.filter(
            (id) => !next.has(id)
          ),
        };
      });
    },
    [setPreferences]
  );

  const setColumnOrder = useCallback(
    (next: (current: string[]) => string[]) => {
      setPreferences((current) => ({
        ...current,
        columnOrder: next(current.columnOrder),
      }));
    },
    [setPreferences]
  );

  const setColumnWidth = useCallback(
    (columnId: string, widthPx: number) => {
      setPreferences((current) => ({
        ...current,
        columnWidths: { ...current.columnWidths, [columnId]: widthPx },
      }));
    },
    [setPreferences]
  );

  const setLeadingColumnWidth = useCallback(
    (widthPx: number) => {
      setPreferences((current) => ({
        ...current,
        leadingColumnWidth: widthPx,
      }));
    },
    [setPreferences]
  );

  return {
    columnOrder: preferences.columnOrder,
    columnWidths: preferences.columnWidths,
    leadingColumnWidth: preferences.leadingColumnWidth,
    setColumnOrder,
    setColumnWidth,
    setLeadingColumnWidth,
    setVisibleColumnIds,
    visibleColumnIds,
  };
}

export type ProjectSavedViewsController = {
  activeViewId: string | null;
  applyView: (viewId: string) => void;
  saveCurrentView: (name: string) => void;
  views: readonly TableToolbarSavedView[];
};

/**
 * The named saved-view collection, persisted under the host's key.
 *
 * Every view here is one THIS reader saved on THIS surface, so the menu's scope
 * section is `personal` as a fact rather than a default: nothing behind the
 * store can share a view, and a seeded arrangement presented beside them would
 * be a record nobody created shown as one they did.
 */
export function useProjectSavedViews(options: {
  captureViewState: () => ProjectViewState;
  restoreViewState: (state: ProjectViewState) => void;
  viewStateKey?: string | null;
}): ProjectSavedViewsController {
  const { captureViewState, restoreViewState, viewStateKey } = options;
  const store = usePersistedSavedViews<ProjectViewState>({
    keyPrefix: PROJECT_SAVED_VIEWS_KEY_PREFIX,
    parse: parseProjectSavedViews,
    persistKey: viewStateKey ?? undefined,
  });
  const { createView, selectView } = store;

  const views = useMemo<readonly TableToolbarSavedView[]>(
    () =>
      store.views.map((view) => ({
        id: view.id,
        name: view.name,
        scope: "personal" as const,
      })),
    [store.views]
  );

  const saveCurrentView = useCallback(
    (name: string) => {
      createView(name, captureViewState());
    },
    [captureViewState, createView]
  );

  const applyView = useCallback(
    (viewId: string) => {
      const arrangement = selectView(viewId);
      if (arrangement) {
        restoreViewState(arrangement);
      }
    },
    [restoreViewState, selectView]
  );

  return {
    activeViewId: store.activeViewId,
    applyView,
    saveCurrentView,
    views,
  };
}
