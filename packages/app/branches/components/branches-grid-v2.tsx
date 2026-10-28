"use client";

import { useApiAdapterOptional } from "@repo/app/shared/api/provider";
import {
  type ProductGridFavoriteController,
  ProductGridTableV2,
  type ProductGridTableV2SelectionProps,
} from "@repo/app/shared/components/product-grid-table-v2";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useGridValueAlignment } from "@repo/app/shared/feature-flags/use-grid-value-alignment";
import {
  BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY,
  BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { GridInteractionContract } from "@repo/design-system/components/ui/grid-interaction-contract";
import {
  ROW_ACTIONS_COLUMN,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import type { GridTableV2Column } from "@repo/design-system/components/ui/grid-table-v2";
import {
  buildGridTableV2CardFields,
  GridTableV2Card,
} from "@repo/design-system/components/ui/grid-table-v2-card";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { withMissingColumnsAtCanonicalSlots } from "@repo/design-system/lib/column-order";
import type { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { resolveGridColumnTracks } from "@repo/design-system/lib/grid-table-aria";
import type { GridChromeCellProps } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import type {
  GridTableV2Group,
  GridTableV2Mode,
  GridTableV2Props,
} from "@repo/design-system/lib/grid-table-v2-types";
import type { ReactNode } from "react";
import { AddFieldHeaderButton } from "../../custom-fields/components/list-custom-field-controls";
import type { ListCustomFieldColumn } from "../../custom-fields/lib/list-custom-field-columns";
import { useBranchesDataSourceOptional } from "../data-source/provider";
import { useBranchFavoritesController } from "../hooks/use-branch-favorites-controller";
import {
  BRANCH_NAME_COLUMN_ID,
  branchColumnLabel,
  branchSortKeyForColumn,
} from "../lib/branch-column-view-model";
import type { BranchRow, BranchRowSession } from "../lib/branch-row";
import {
  APPROVED_BRANCH_COLUMN_SPECS,
  type ApprovedBranchColumnSpec,
  type ApprovedBranchLeadRenderInput,
  approvedBranchRepositoryLabels,
  renderApprovedBranchCell,
  renderApprovedBranchLead,
} from "./approved-branches-grid-adapter";
import {
  handBuiltBranchColumnLayout,
  registryBranchColumnLayout,
} from "./branch-column-layout";
import { withBranchCustomFieldColumns } from "./branch-custom-field-columns";
import { BranchRowActionsMenu } from "./branch-row-actions-menu";

/**
 * The ordering the lead header asks for, or absent when the view model stops
 * declaring the name column sortable — which makes the header inert rather than
 * asking the producer for a key it no longer accepts.
 */
const LEADING_SORT_KEY =
  branchSortKeyForColumn(BRANCH_NAME_COLUMN_ID) ?? undefined;

/**
 * The Branches GridTableV2 body. `columnSpecs` carries the header spelling the
 * surface picked. The sessions cell reads its own feature gate at the swap and
 * uses canonical membership identities already carried by each row.
 */
export function BranchesGridV2(props: BranchesGridV2Props) {
  return <BranchesGridV2Layout {...props} />;
}

/** Rollout-only Branches grid with the PRD-729 enhanced row-action column. */
export function BranchesGridV2WithRowActions(props: BranchesGridV2Props) {
  const { getBranchHref, getSessionsHref, tagsReadOnly } = props;
  const source = useBranchesDataSourceOptional();
  return (
    <GridInteractionContract state={props.interactionState}>
      <BranchesGridV2Layout
        {...props}
        renderRowActions={(item) => (
          <BranchRowActionsMenu
            actionPolicyInput={{
              hasArtifactIdentity: Boolean(item.artifactId),
              hasDetailRoute: Boolean(getBranchHref),
              hasSessionsRoute: Boolean(getSessionsHref),
              hostCanMutate: !tagsReadOnly,
              prNumber: item.prNumber,
              prUrl: item.prUrl,
              sessionCount: item.sessionCount,
              supportsTags: source?.supportsTags === true,
              tagAvailability: item.tagAvailability,
              tagPermissions: item.tagPermissions,
            }}
            getBranchHref={getBranchHref}
            getSessionsHref={getSessionsHref}
            item={item}
          />
        )}
      />
    </GridInteractionContract>
  );
}

type BranchesGridV2Props = {
  allRows: BranchRow[];
  favorites?: ProductGridFavoriteController<BranchRow>;
  columnOrder?: readonly string[];
  columnSpecs: readonly ApprovedBranchColumnSpec[];
  columnWidths?: Readonly<Record<string, number>>;
  customFieldColumns?: readonly ListCustomFieldColumn[];
  getBranchHref?: (item: BranchRow) => string;
  getSessionsHref?: (item: BranchRow) => string;
  getSessionHref?: (session: BranchRowSession) => string;
  groupCollapse?: GridTableV2Props<BranchRow>["groupCollapse"];
  groups?: GridTableV2Group<BranchRow>[];
  interactionState?: GridInteractionState;
  items: BranchRow[];
  /** Explicit card/grid mode from the stable outer list surface. */
  mode?: GridTableV2Mode;
  onAddField?: () => void;
  onSort: (column: string, direction: SortDirection) => void;
  onColumnOrderChange?: (nextOrder: string[]) => void;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  renderBranchLink?: (input: ApprovedBranchLeadRenderInput) => ReactNode;
  renderBranchStatus?: (item: BranchRow) => ReactNode;
  renderCustomFieldCell?: (
    columnId: string,
    item: BranchRow
  ) => ReactNode | undefined;
  /** Absent, the list is not selectable. */
  selection?: ProductGridTableV2SelectionProps<BranchRow> &
    Pick<GridTableV2Props<BranchRow>, "onRenderedItemsChange">;
  sortBy: string;
  sortDir: SortDirection;
  tagsReadOnly: boolean;
  visibleColumns: Set<string>;
};

function BranchesGridV2Layout(
  props: BranchesGridV2Props & {
    renderRowActions?: (item: BranchRow) => ReactNode;
  }
) {
  const adapter = useApiAdapterOptional();
  if (props.favorites || !adapter) {
    return <BranchesGridV2LayoutBody {...props} />;
  }
  return <BranchesGridV2Connected {...props} />;
}

function BranchesGridV2Connected(
  props: BranchesGridV2Props & {
    renderRowActions?: (item: BranchRow) => ReactNode;
  }
) {
  // The track is reserved whenever the host has favourites at all, so paging
  // to rows without an artifact id leaves an empty cell rather than dropping a
  // column (marisolashgrove review on #9116).
  const favorites = useBranchFavoritesController();
  return <BranchesGridV2LayoutBody {...props} favorites={favorites} />;
}

function BranchesGridV2LayoutBody({
  allRows,
  favorites,
  columnOrder,
  columnSpecs,
  columnWidths,
  customFieldColumns = EMPTY_CUSTOM_FIELD_COLUMNS,
  getBranchHref,
  getSessionsHref,
  getSessionHref,
  groupCollapse,
  groups,
  items,
  mode = "auto",
  onAddField,
  onSort,
  onColumnOrderChange,
  onColumnWidthChange,
  renderBranchLink,
  renderRowActions,
  renderBranchStatus,
  renderCustomFieldCell,
  selection,
  sortBy,
  sortDir,
  tagsReadOnly,
  visibleColumns,
}: BranchesGridV2Props & {
  renderRowActions?: (item: BranchRow) => ReactNode;
}) {
  const pinNameColumn = useFeatureFlagEnabledOptional(
    BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY
  );
  /**
   * ISS-9316 / PRD-716 phase 06. The single read site: it picks between two
   * WHOLE derivations of the same four facts, so nothing below it — and nothing
   * in the mount — knows a gate exists.
   */
  const registryColumnsEnabled = useFeatureFlagEnabledOptional(
    BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY
  );
  const alignValuesToColumn = useGridValueAlignment();
  const activeColumnOrder =
    columnOrder && columnOrder.length > 0
      ? columnOrder
      : APPROVED_BRANCH_DATA_COLUMN_IDS;
  const resolvedColumnOrder = withMissingColumnsAtCanonicalSlots(
    APPROVED_BRANCH_DATA_COLUMN_IDS,
    activeColumnOrder
  );
  const layoutInput = {
    columnSpecs,
    columnWidths,
    resolvedColumnOrder,
    visibleColumns,
  };
  const builtInLayout = registryColumnsEnabled
    ? registryBranchColumnLayout(layoutInput)
    : handBuiltBranchColumnLayout(layoutInput);
  const layout = withBranchCustomFieldColumns(builtInLayout, {
    columns: customFieldColumns,
    columnWidths,
    showAddField: onAddField !== undefined,
  });
  const handleColumnOrderChange = onColumnOrderChange
    ? (visibleOrder: string[]) =>
        onColumnOrderChange(layout.toPersistedColumnOrder(visibleOrder))
    : undefined;
  const labels = approvedBranchRepositoryLabels(allRows);
  const renderCell = (columnId: string, item: BranchRow) => {
    if (columnId === ROW_ACTIONS_COLUMN_ID) {
      return renderRowActions?.(item) ?? null;
    }
    if (columnId === BRANCH_STATUS_COLUMN_ID) {
      const status = renderBranchStatus?.(item);
      if (status !== undefined) {
        return status;
      }
    }
    return (
      renderCustomFieldCell?.(columnId, item) ??
      renderApprovedBranchCell(
        columnId,
        item,
        labels,
        getSessionsHref,
        tagsReadOnly,
        { chipsSupportedBySurface: true, getSessionHref }
      )
    );
  };
  const renderLead: GridTableV2Props<BranchRow>["renderLead"] = (
    item,
    context
  ) =>
    renderApprovedBranchLead(item, getBranchHref, renderBranchLink, {
      showStatusIcon: context.isNarrowList,
    });
  const renderedColumnOrder = renderRowActions
    ? [...layout.columnOrder, ROW_ACTIONS_COLUMN_ID]
    : layout.columnOrder;
  const renderedColumns = renderRowActions
    ? [...layout.columns, ROW_ACTIONS_COLUMN]
    : layout.columns;
  const renderedGridTemplateColumns = [
    layout.gridTemplateColumns,
    ...(renderRowActions ? ["52px"] : []),
  ].join(" ");
  const gridProps = {
    alignValuesToColumn,
    favorite: favorites,
    cardCompatibility: {
      getSelectionLabel: selection?.getCompatibilityCardSelectionLabel,
      render: (
        item: BranchRow,
        cardColumns: readonly GridTableV2Column[],
        favoriteAction?: ReactNode
      ) => (
        <BranchCard
          columns={cardColumns}
          favoriteAction={favoriteAction}
          item={item}
          renderCell={renderCell}
          renderLead={(row) =>
            renderApprovedBranchLead(row, getBranchHref, renderBranchLink)
          }
        />
      ),
    },
    columnOrder: renderedColumnOrder,
    columns: renderedColumns,
    // Custom-field positions are not persisted, so only built-ins move.
    movableColumnIds:
      customFieldColumns.length > 0 ? builtInLayout.columnOrder : undefined,
    columnWidths: onColumnWidthChange ? layout.columnWidths : undefined,
    enableRowRangeDrag: selection?.enableRowRangeDrag,
    getRowId: (item: BranchRow) => item.id,
    groupCollapse,
    // Absent, not empty: `GridTableV2` reads `undefined` as "flat list" and an
    // empty array as "grouped, with no bands", which paints nothing at all.
    groups: groups && groups.length > 0 ? groups : undefined,
    gridTemplateColumns: renderedGridTemplateColumns,
    items,
    isRowSelected: selection?.isRowSelected,
    // ISS-9676 (davetho review): the lead column is in the view model like any
    // other, so its header wording and its ordering come from the same entry the
    // Sort menu reads. Hard-coded, a later edit to that entry's label or its
    // `isSortable` left the header and the menu spelling one column two ways.
    leadingLabel: branchColumnLabel(BRANCH_NAME_COLUMN_ID),
    leadingSortKey: LEADING_SORT_KEY,
    mode,
    // ISS-10245: unconditional. `grid-table-v2-navigable-header-cells` was
    // retired ENABLED by operator ruling (2026-09-14). Retiring it also closes
    // the split read the gate had — Sessions and Branches each read the key at
    // their own site, so the two grids could settle on different answers.
    navigableHeaderCells: true,
    onColumnOrderChange: handleColumnOrderChange,
    onColumnWidthChange,
    onRenderedItemsChange: selection?.onRenderedItemsChange,
    onRowClick: selection?.onRowClick,
    onRowKeyboardNavigate: selection?.onRowKeyboardNavigate,
    onRowRangeDrag: selection?.onRowRangeDrag,
    onRowSelectionToggle: selection?.onRowSelectionToggle,
    // ISS-13007: header select-all is intentionally absent; this preserves Cmd/Ctrl+A.
    onSelectAllRows: selection?.onSelectAllRows,
    onSort,
    renderCell,
    renderLead,
    renderLeadingUtilityInWide: false,
    renderNarrowTrailingAction: renderRowActions,
    // ISS-9676: a per-band count would be over the rows on THIS PAGE while the
    // footer beside it states a corpus total, so "Alex Rivera 2" under a
    // "1–25 of 400" pager reads as a population it never counted. The band is
    // an arrangement of what is on screen; the number is the claim, and this
    // list has no producer for it.
    showGroupCounts: false,
    sortBy,
    sortDir,
    // ISS-12663: the same trailing Add field header the Sessions list carries,
    // in its function form so it joins the header's roving walk.
    trailingHeader: onAddField
      ? (cellProps?: GridChromeCellProps) => (
          <AddFieldHeaderButton
            columnIndex={
              resolveGridColumnTracks({
                dataColumnCount: renderedColumns.length,
                hasLeadingUtility: favorites !== undefined,
                hasTrailingTrack: true,
              }).trailingColumnIndex
            }
            navigationProps={cellProps}
            onClick={onAddField}
          />
        )
      : undefined,
  };
  return pinNameColumn ? (
    <ProductGridTableV2<BranchRow> {...gridProps} pinLeadColumn />
  ) : (
    <ProductGridTableV2<BranchRow> {...gridProps} />
  );
}

/**
 * The canonical slot order, read off the DEFAULT specs: ids only, so the header
 * spelling `columnSpecs` carries cannot change which slot a column falls into.
 */
const APPROVED_BRANCH_DATA_COLUMN_IDS = APPROVED_BRANCH_COLUMN_SPECS.map(
  (spec) => spec.id
);

const BRANCH_STATUS_COLUMN_ID = "status";
const CARD_HEADER_COLUMN_IDS = new Set([
  BRANCH_STATUS_COLUMN_ID,
  ROW_ACTIONS_COLUMN_ID,
]);

/** Captured-main Branches card, retained only behind the closed rollout flag. */
function BranchCard({
  columns,
  favoriteAction,
  item,
  renderCell,
  renderLead,
}: {
  columns: readonly GridTableV2Column[];
  favoriteAction?: ReactNode;
  item: BranchRow;
  renderCell: (columnId: string, item: BranchRow) => ReactNode;
  renderLead: (item: BranchRow) => ReactNode;
}) {
  const statusVisible = columns.some(
    (column) => column.id === BRANCH_STATUS_COLUMN_ID
  );
  const rowActionsVisible = columns.some(
    (column) => column.id === ROW_ACTIONS_COLUMN_ID
  );
  const lead = favoriteAction ? (
    <div className="flex min-w-0 items-start gap-1">
      {favoriteAction}
      <div className="min-w-0">{renderLead(item)}</div>
    </div>
  ) : (
    <div className="min-w-0">{renderLead(item)}</div>
  );
  return (
    <GridTableV2Card
      fields={buildGridTableV2CardFields(
        columns,
        CARD_HEADER_COLUMN_IDS,
        renderCell,
        item
      )}
      header={
        rowActionsVisible ? (
          <div className="flex items-start justify-between gap-2">
            {lead}
            <div className="flex shrink-0 items-start gap-1">
              {statusVisible ? renderCell(BRANCH_STATUS_COLUMN_ID, item) : null}
              {renderCell(ROW_ACTIONS_COLUMN_ID, item)}
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            {lead}
            {statusVisible ? (
              <div className="shrink-0">
                {renderCell(BRANCH_STATUS_COLUMN_ID, item)}
              </div>
            ) : null}
          </div>
        )
      }
      preserveEmptyFields
    />
  );
}

const EMPTY_CUSTOM_FIELD_COLUMNS: readonly ListCustomFieldColumn[] = [];
