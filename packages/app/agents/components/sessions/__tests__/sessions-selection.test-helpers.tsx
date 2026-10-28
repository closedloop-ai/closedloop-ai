import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { TableBulkActionDescriptor } from "@repo/design-system/components/ui/table-bulk-actions";
import {
  type GridSelectionModifiers,
  gridTableV2SelectionProps,
} from "@repo/design-system/lib/grid-table-v2-selection";
import type { GridTableV2SelectionProps } from "@repo/design-system/lib/grid-table-v2-types";
import { ArtifactBulkActionBar } from "../../../../shared/components/generic-artifact-surface/bulk-action-bar";
import { SESSIONS_NOUN } from "../../../lib/sessions-noun";
import { sessionsListBulkActions } from "../sessions-list-bulk-actions";
import type { SessionsFavoriteController } from "../sessions-list-interactions";

/**
 * The Sessions rail as `useListBulkSelection` mounts it, for suites that drive
 * the rail's actions over a fixed selection without a grid.
 */
export function SessionsBulkRail({
  actions,
  favorites,
  getSelectionGeneration,
  onClear,
  onRetainSelection,
  selectedRows,
}: {
  actions?: readonly TableBulkActionDescriptor[];
  favorites?: SessionsFavoriteController;
  getSelectionGeneration?: () => number;
  onClear: () => void;
  onRetainSelection: (rowIds: readonly string[]) => void;
  selectedRows: readonly SessionTableRow[];
}) {
  return (
    <ArtifactBulkActionBar
      actions={sessionsListBulkActions({ actions, favorites, selectedRows })}
      getSelectionGeneration={getSelectionGeneration}
      minimumSelectedRows={2}
      noun={SESSIONS_NOUN}
      onClear={onClear}
      onRetainSelection={onRetainSelection}
      rowIds={selectedRows.map((row) => row.id)}
    />
  );
}

/** A grid selection with nothing selected, for suites that mount the grid alone. */
export function emptySessionsGridSelection(
  onRowSelection: (
    row: SessionTableRow,
    modifiers: GridSelectionModifiers
  ) => void = () => undefined
): GridTableV2SelectionProps<SessionTableRow> {
  return gridTableV2SelectionProps<SessionTableRow>({
    isRowSelected: () => false,
    onRowSelection,
  });
}
