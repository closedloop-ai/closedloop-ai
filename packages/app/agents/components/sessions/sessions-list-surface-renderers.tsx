import type {
  SessionsSeamCellRenderer,
  SessionTableRow,
} from "@repo/app/agents/lib/session-list-row";
import type { GridTableV2LeadContext } from "@repo/design-system/lib/grid-table-v2-types";
import type { ReactNode } from "react";
import { SessionNameLeadCell } from "./session-name-lead-cell";
import {
  customFieldForColumn,
  renderSessionsCustomFieldCell,
  type SessionsCustomFieldColumn,
  type SessionsCustomFieldsController,
} from "./sessions-list-custom-fields";
import { renderSessionGridCell } from "./sessions-list-surface-rows";

export function createSessionsListSurfaceRenderers({
  customFieldColumns,
  customFields,
  getSessionHref,
  seamRenderers,
}: {
  customFieldColumns: SessionsCustomFieldColumn[];
  customFields: SessionsCustomFieldsController | undefined;
  getSessionHref?: (row: SessionTableRow) => string | null;
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>;
}) {
  const renderSessionsCell = (
    columnId: string,
    row: SessionTableRow,
    render: (
      id: string,
      target: SessionTableRow,
      seams: ReadonlyMap<string, SessionsSeamCellRenderer>
    ) => ReactNode
  ) => {
    const customField = customFieldForColumn(columnId, customFieldColumns);
    if (customField && customFields) {
      return renderSessionsCustomFieldCell({
        controller: customFields,
        field: customField,
        row,
      });
    }
    return render(columnId, row, seamRenderers);
  };
  return {
    renderGridCell: (columnId: string, row: SessionTableRow) =>
      renderSessionsCell(columnId, row, renderSessionGridCell),
    // ISS-8718: the lead cell plus the owner's inline rename. The editor is
    // mounted HERE and not inside the presentational rows module, for the
    // reason the Priority cell is a seam: it writes through the data source.
    renderGridLead: (row: SessionTableRow, context: GridTableV2LeadContext) => (
      <SessionNameLeadCell
        getSessionHref={getSessionHref}
        row={row}
        showStatusIcon={context.isNarrowList}
      />
    ),
  };
}
