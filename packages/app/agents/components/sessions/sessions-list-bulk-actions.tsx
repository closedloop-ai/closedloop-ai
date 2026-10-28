"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import type { GridRowSelectionController } from "@repo/design-system/hooks/use-grid-row-selection";
import { useListBulkSelection } from "../../../shared/components/generic-artifact-surface/use-list-bulk-selection";
import { SESSIONS_NOUN } from "../../lib/sessions-noun";
import { sessionsFavoriteBulkActions } from "./sessions-bulk-favorite-action";
import type { SessionsFavoriteController } from "./sessions-list-interactions";

/**
 * The Sessions rail's operations over selected rows. A registry builder owns
 * its full composition; legacy descriptor arrays still prepend favouriting.
 */
export function sessionsListBulkActions({
  actions,
  favorites,
  selectedRows,
}: {
  /** Legacy descriptors or the registry's selected-row action builder. */
  actions?:
    | readonly TableBulkActionDescriptor[]
    | ((
        selectedRows: readonly SessionTableRow[]
      ) => readonly TableBulkActionDescriptor[]);
  favorites?: SessionsFavoriteController;
  selectedRows: readonly SessionTableRow[];
}): readonly TableBulkActionDescriptor[] {
  if (typeof actions === "function") {
    return actions(selectedRows);
  }
  return [
    ...sessionsFavoriteBulkActions({ favorites, rows: selectedRows }),
    ...(actions ?? []),
  ];
}

/**
 * The Sessions list on the shared selection owner. ISS-9107: selection exists
 * to feed a bulk OPERATION, so a host with neither favourites nor a bulk action
 * gets none, and no rail whose only control undoes itself.
 */
export function useSessionsListBulkSelection({
  bulkActions,
  controller,
  favorites,
  reconcileVisibleRows,
  rows,
}: {
  bulkActions?:
    | readonly TableBulkActionDescriptor[]
    | ((
        selectedRows: readonly SessionTableRow[]
      ) => readonly TableBulkActionDescriptor[]);
  controller?: GridRowSelectionController;
  favorites?: SessionsFavoriteController;
  reconcileVisibleRows: boolean;
  rows: readonly SessionTableRow[];
}) {
  return useListBulkSelection({
    actions: (selectedRows) =>
      sessionsListBulkActions({
        actions: bulkActions,
        favorites,
        selectedRows,
      }),
    controller,
    enabled:
      Boolean(favorites) ||
      typeof bulkActions === "function" ||
      (bulkActions?.length ?? 0) > 0,
    getRowLabel: (row) => row.name,
    noun: SESSIONS_NOUN,
    reconcileVisibleRows,
    rows,
  });
}
