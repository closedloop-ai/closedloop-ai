"use client";

import type { SessionsSeamCellRenderer } from "@repo/app/agents/lib/session-list-row";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  GRID_TABLE_V2_ADD_FIELD_TRACK,
  GRID_TABLE_V2_FAVORITE_TRACK,
  type GridTableV2Column,
} from "@repo/design-system/components/ui/grid-table-v2";
import type { TableToggleOption } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  ColumnMoveDirection,
  mergeColumnOrder,
  moveColumnByDirection,
  orderColumns,
  withMissingColumnsAtCanonicalSlots,
} from "@repo/design-system/lib/column-order";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX,
  SESSIONS_STATUS_COLUMN_ID,
} from "../../lib/sessions-table-columns";
import {
  SESSIONS_COLUMN_LABELS,
  TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS,
  TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX,
} from "../../lib/sessions-total-estimated-cost-columns";
import {
  isSessionsCustomFieldGroupable,
  SESSION_CUSTOM_FIELD_WIDTH_PX,
  type SessionsCustomFieldColumn,
} from "./sessions-list-custom-fields";
import {
  FILTERABLE_COLUMN_IDS,
  GROUPABLE_COLUMN_IDS,
  isSortableSpec,
  offerableColumnSpecs,
} from "./sessions-list-surface-rows";

export function useSessionsListColumns({
  columnOrder,
  columnWidths: persistedColumnWidths,
  customFieldColumns,
  favoritesEnabled,
  isServerDriven,
  onColumnOrderChange,
  onColumnWidthChange,
  onCustomColumnsAdded,
  seamRenderers,
  showAddField,
  statusColumnWidth = 0,
  visibleColumnIds,
}: {
  columnOrder?: readonly string[];
  columnWidths?: Readonly<Record<string, number>>;
  customFieldColumns: readonly SessionsCustomFieldColumn[];
  favoritesEnabled: boolean;
  isServerDriven: boolean;
  onColumnOrderChange?: (columnIds: string[]) => void;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  onCustomColumnsAdded?: (columnIds: readonly string[]) => void;
  seamRenderers: ReadonlyMap<string, SessionsSeamCellRenderer>;
  showAddField: boolean;
  statusColumnWidth?: number;
  visibleColumnIds: ReadonlySet<string>;
}) {
  // ISS-8712 / ISS-9550: the gate is read where the column surface is chosen,
  // and both the menu toggles and grid specs derive from the same offerable set.
  const artifactTagsEnabled = useFeatureFlagEnabledOptional(
    SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY
  );
  // The HEADER takes the one dollar phrase; the MENU keeps the spec's own word.
  // They differ for exactly one column, and deliberately: the Options menu also
  // carries a SUMMARY-CARD row under the dollar phrase, so resolving the column
  // toggle to it too would put two rows under one accessible name. Which of the
  // two should be renamed is a product question (raised on ISS-10636), and this
  // split is what the legacy toolbar already ships via `sessionsToggleableColumns`.
  const columnLabels = TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_LABELS;
  const menuLabels = SESSIONS_COLUMN_LABELS;
  const seedColumnWidths = TOTAL_ESTIMATED_COST_SESSIONS_COLUMN_WIDTH_PX;
  const hostGates = useMemo(
    () => ({
      [SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY]: Boolean(artifactTagsEnabled),
    }),
    [artifactTagsEnabled]
  );
  const customColumnIds = useMemo(
    () => customFieldColumns.map((column) => column.id),
    [customFieldColumns]
  );
  const baseColumnSpecs = useMemo(
    () => offerableColumnSpecs(seamRenderers, hostGates),
    [seamRenderers, hostGates]
  );
  const toggleableColumns: readonly TableToggleOption[] = useMemo(
    () => [
      ...baseColumnSpecs.map((spec) => ({
        key: spec.id,
        label: menuLabels[spec.id] ?? spec.label,
      })),
      ...customFieldColumns.map((column) => ({
        key: column.id,
        label: column.label,
      })),
    ],
    [baseColumnSpecs, customFieldColumns]
  );
  const canonicalColumnOrder = useMemo(
    () => [...SESSIONS_DATA_COLUMN_ORDER, ...customColumnIds],
    [customColumnIds]
  );
  const [uncontrolledColumnOrder, setUncontrolledColumnOrder] = useState<
    string[]
  >(() => [...canonicalColumnOrder]);
  const [seededColumnWidths, setSeededColumnWidths] = useState<
    Record<string, number>
  >(() => ({
    ...seedColumnWidths,
    ...Object.fromEntries(
      customColumnIds.map((columnId) => [
        columnId,
        SESSION_CUSTOM_FIELD_WIDTH_PX,
      ])
    ),
  }));
  const [leadingColumnWidth, setLeadingColumnWidth] = useState(
    SESSIONS_LEAD_COLUMN_MIN_WIDTH_PX
  );
  const knownCustomColumnIds = useRef(new Set(customColumnIds));

  useEffect(() => {
    const nextIds = customColumnIds.filter(
      (columnId) => !knownCustomColumnIds.current.has(columnId)
    );
    knownCustomColumnIds.current = new Set(customColumnIds);
    if (nextIds.length === 0) {
      return;
    }
    onCustomColumnsAdded?.(nextIds);
    setSeededColumnWidths((current) => ({
      ...current,
      ...Object.fromEntries(
        nextIds.map((columnId) => [columnId, SESSION_CUSTOM_FIELD_WIDTH_PX])
      ),
    }));
    setUncontrolledColumnOrder((current) => [...current, ...nextIds]);
  }, [customColumnIds, onCustomColumnsAdded]);

  // ISS-9567. The seed carries a declared width for EVERY column; the persisted
  // record carries only the ones a reader actually dragged, so it lays OVER the
  // seed rather than replacing it — a column the reader never touched keeps its
  // declared track instead of losing one. That order is the point: the reader's
  // choice wins the collision, and a custom field added mid-session still gets
  // its default from the seed underneath.
  const columnWidths = useMemo(() => {
    const resolved = { ...seededColumnWidths, ...persistedColumnWidths };
    resolved[SESSIONS_STATUS_COLUMN_ID] = Math.max(
      resolved[SESSIONS_STATUS_COLUMN_ID],
      statusColumnWidth
    );
    return resolved;
  }, [persistedColumnWidths, seededColumnWidths, statusColumnWidth]);
  const handleColumnWidthChange = useCallback(
    (columnId: string, widthPx: number) => {
      // ISS-10356: EVERY id, `custom-field:*` included. A host that supplies the
      // setter owns the whole axis — `useSessionsViewState` holds custom-field
      // widths as width-only ids — and with it supplied this branch is the only
      // one, so a setter that dropped an id would stop that column resizing at
      // all (whitlockk, PR #7320).
      if (onColumnWidthChange) {
        onColumnWidthChange(columnId, widthPx);
        return;
      }
      setSeededColumnWidths((current) => ({ ...current, [columnId]: widthPx }));
    },
    [onColumnWidthChange]
  );

  const activeColumnOrder = columnOrder ?? uncontrolledColumnOrder;
  const resolvedColumnOrder = withMissingColumnsAtCanonicalSlots(
    canonicalColumnOrder,
    activeColumnOrder
  );
  const renderedSpecs = orderColumns(
    [...baseColumnSpecs, ...customFieldColumns].filter((spec) =>
      visibleColumnIds.has(spec.id)
    ),
    resolvedColumnOrder
  );
  const canChangeColumnOrder =
    columnOrder === undefined || onColumnOrderChange !== undefined;
  const handleColumnOrderChange = useCallback(
    (visibleOrder: string[]) => {
      const completeOrder = mergeColumnOrder(resolvedColumnOrder, visibleOrder);
      if (onColumnOrderChange) {
        onColumnOrderChange(completeOrder);
      } else {
        setUncontrolledColumnOrder(completeOrder);
      }
    },
    [onColumnOrderChange, resolvedColumnOrder]
  );
  const moveColumnFromHeader = useCallback(
    (columnId: string, direction: "start" | "left" | "right" | "end") => {
      const current = renderedSpecs.map((spec) => spec.id);
      if (direction === "left" || direction === "right") {
        handleColumnOrderChange(
          moveColumnByDirection(
            current,
            columnId,
            direction === "left"
              ? ColumnMoveDirection.Left
              : ColumnMoveDirection.Right
          )
        );
        return;
      }
      const withoutColumn = current.filter((id) => id !== columnId);
      handleColumnOrderChange(
        direction === "start"
          ? [columnId, ...withoutColumn]
          : [...withoutColumn, columnId]
      );
    },
    [handleColumnOrderChange, renderedSpecs]
  );
  const columns: GridTableV2Column[] = renderedSpecs.map((spec) => ({
    id: spec.id,
    label: columnLabels[spec.id] ?? spec.label,
    ...("className" in spec ? { className: spec.className } : {}),
    filterable:
      "customField" in spec
        ? !isServerDriven && spec.customField.isSearchable
        : FILTERABLE_COLUMN_IDS.has(spec.id),
    groupable:
      "customField" in spec
        ? !isServerDriven && isSessionsCustomFieldGroupable(spec.customField)
        : GROUPABLE_COLUMN_IDS.has(spec.id),
    sortable:
      "customField" in spec
        ? !isServerDriven && spec.customField.isSortable
        : isSortableSpec(spec),
    ...("tooltip" in spec ? { tooltip: spec.tooltip } : {}),
  }));
  const gridTemplateColumns = [
    ...(favoritesEnabled ? [GRID_TABLE_V2_FAVORITE_TRACK] : []),
    `${leadingColumnWidth}px`,
    ...renderedSpecs.map((spec) => `${columnWidths[spec.id]}px`),
    ...(showAddField ? [GRID_TABLE_V2_ADD_FIELD_TRACK] : []),
  ].join(" ");

  return {
    canChangeColumnOrder,
    columns,
    columnWidths,
    gridTemplateColumns,
    handleColumnOrderChange,
    handleColumnWidthChange,
    leadingColumnWidth,
    moveColumnFromHeader,
    renderedSpecs,
    setLeadingColumnWidth,
    toggleableColumns,
  } as const;
}
