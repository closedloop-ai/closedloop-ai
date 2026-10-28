"use client";

import type {
  SessionsSeamCellRenderer,
  SessionTableRow,
} from "@repo/app/agents/lib/session-list-row";
import type { ProductGridTableV2CardCompatibility } from "@repo/app/shared/components/product-grid-table-v2-card-compatibility";
import type { GridTableV2Column } from "@repo/design-system/lib/grid-table-v2-types";
import type { ReactNode } from "react";
import { SessionCard } from "./session-detail-table";
import { SessionNameLeadCell } from "./session-name-lead-cell";
import {
  customFieldForColumn,
  renderSessionsCustomFieldCell,
  type SessionsCustomFieldColumn,
  type SessionsCustomFieldsController,
} from "./sessions-list-custom-fields";
import { renderSessionCardCell } from "./sessions-list-surface-rows";

/**
 * Captured-main Sessions cards for the rollout's default-off branch.
 * The flag-on grid receives this opaque compatibility object, never a card-cell
 * renderer or grouping input, and `ProductGridTableV2` ignores it while open.
 */
export function createSessionsListCardCompatibility({
  customFieldColumns,
  customFields,
  getSelectionLabel,
  getSessionHref,
  seamRenderers,
  showStatus,
}: {
  customFieldColumns: SessionsCustomFieldColumn[];
  customFields: SessionsCustomFieldsController | undefined;
  getSelectionLabel?: (row: SessionTableRow, selected: boolean) => string;
  getSessionHref?: (row: SessionTableRow) => string | null;
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>;
  showStatus: boolean;
}): ProductGridTableV2CardCompatibility<SessionTableRow> {
  const renderCell = (columnId: string, row: SessionTableRow): ReactNode => {
    const customField = customFieldForColumn(columnId, customFieldColumns);
    if (customField && customFields) {
      return renderSessionsCustomFieldCell({
        controller: customFields,
        field: customField,
        row,
      });
    }
    return renderSessionCardCell(columnId, row, seamRenderers);
  };
  return {
    getSelectionLabel,
    render: (row, columns: readonly GridTableV2Column[], favoriteAction) => (
      <SessionCard
        columns={columns}
        headerAction={favoriteAction}
        renderCell={renderCell}
        renderName={() => (
          <SessionNameLeadCell getSessionHref={getSessionHref} row={row} />
        )}
        row={row}
        showProvenanceChip={false}
        showStatus={showStatus}
      />
    ),
  };
}
