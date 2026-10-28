// gardener-support: test and story data, not shipped
"use client";

import type { SourceCollaborators } from "@repo/api/src/types/branch-identity";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { ArtifactListCell } from "@repo/app/artifacts/components/artifact-list-cells";
import { documentToPrototypeListRow } from "@repo/app/artifacts/components/artifact-list-model";
import { branchesRangeReadout } from "@repo/app/branches/lib/branches-range-readout";
import {
  ARTIFACT_COLUMN_REGISTRY,
  artifactColumns,
} from "@repo/app/shared/components/generic-artifact-surface/fixtures";
import { GenericArtifactLead } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-cells";
import { ListSurfacePaginationFooter } from "@repo/app/shared/components/list-surface-pagination-footer";
import { ListSurfaceToolbarV2 } from "@repo/app/shared/components/list-surface-toolbar-v2";
import {
  SUMMARY_CARD_SURFACE_BAND_PROPS,
  SummaryCardRow,
} from "@repo/app/shared/components/summary-card-row";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
  toggleFacetValue,
} from "@repo/app/shared/lib/facet-filter";
import {
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";
import { TABLE_DATE_RANGE_OPTIONS } from "@repo/app/shared/lib/table-date-range-options";
import {
  getUserDisplayName,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { FavoriteButton } from "@repo/design-system/components/ui/favorite-button";
import { GridTableListSurface } from "@repo/design-system/components/ui/grid-table-list-surface";
import {
  GRID_TABLE_V2_FAVORITE_TRACK,
  GridTableV2,
  type GridTableV2Column,
} from "@repo/design-system/components/ui/grid-table-v2";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { FilterMenuGroup } from "@repo/design-system/components/ui/table-filters";
import { type ReactNode, useMemo, useState } from "react";

/**
 * ISS-12586 (DI-16): the Documents List and Issues List design shell, on the
 * Branches list composition: `GridTableListSurface`'s bands with the shared
 * toolbar (`ListSurfaceToolbarV2`), one count card in the shared summary row,
 * `GridTableV2` with the canonical artifact list cells (`ArtifactListCell`,
 * `GenericArtifactLead`, the design-system `FavoriteButton`), and the shared
 * pagination footer. Nothing in production imports it; Storybook renders it.
 *
 * Fixture rows only: no read, no write. The toolbar's date range, column
 * picker and Status/Owner filters and the favorite stars hold local state, so
 * the controls answer when pressed. Sort and grouping are left out: the shell
 * has no ordering to offer, and the shared toolbar omits both menus when
 * `sortGrouping` is absent.
 */

export type ArtifactListDesignRow = Readonly<{
  collaborators: SourceCollaborators<string>;
  commentCount: number;
  document: DocumentWithProject;
  favorite: boolean;
  /**
   * The accountable owner when it is not the assignee (Issues carry both).
   * Absent, Owner is the assignee, as the shipped Documents list reads it.
   */
  owner?: BasicUser | null;
}>;

export type ArtifactListDesignMetric = Readonly<{
  info?: { what: string; how?: string };
  label: string;
}>;

const LEAD_TRACK = "minmax(300px, 1fr)";
const PAGE_SIZE = 25;
const DEFAULT_TRACK_PX = 120;
const NO_EDIT_HANDLERS = {};

/**
 * Issues list Assignee, beside Owner. The shipped artifact column set has one
 * person column (Owner, read from the assignee), so Assignee is declared here
 * and drawn by the same canonical person cell.
 */
const ASSIGNEE_COLUMN_ID = "assignee";
const DESIGN_ONLY_COLUMNS: readonly GridTableV2Column[] = [
  { id: ASSIGNEE_COLUMN_ID, label: "Assignee" },
];
const DESIGN_ONLY_COLUMN_WIDTH_PX: Readonly<Record<string, number>> = {
  [ASSIGNEE_COLUMN_ID]: 130,
};

export function ArtifactListDesignShell({
  columnIds,
  countMetric,
  defaultDateRange = DEFAULT_DATE_RANGE,
  header,
  leadingLabel,
  rows,
  statusLabels,
}: Readonly<{
  /** The data columns, in order; every id is a shipped artifact column. */
  columnIds: readonly string[];
  /** The one summary card: the count of rows in the current view. */
  countMetric: ArtifactListDesignMetric;
  /** The window the date toggle opens on. */
  defaultDateRange?: DateRange;
  /** The page header row; the app's route header in a full page. */
  header?: ReactNode;
  /** The identity column's header. */
  leadingLabel: string;
  rows: readonly ArtifactListDesignRow[];
  /** The status words the Status filter offers, by raw status. */
  statusLabels: Readonly<Record<string, string>>;
}>) {
  const [dateRange, setDateRange] = useState<string>(defaultDateRange);
  const [visibleColumnIds, setVisibleColumnIds] = useState<ReadonlySet<string>>(
    () => new Set(columnIds)
  );
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(rows.filter((row) => row.favorite).map((row) => row.document.id))
  );
  const [page, setPage] = useState(0);

  const allColumns = useMemo(
    () =>
      columnIds.flatMap((id) => {
        const column = [...artifactColumns, ...DESIGN_ONLY_COLUMNS].find(
          (candidate) => candidate.id === id
        );
        return column ? [column] : [];
      }),
    [columnIds]
  );
  const columns = allColumns.filter((column) =>
    visibleColumnIds.has(column.id)
  );
  const visibleRows = rows.filter(
    (row) =>
      (statusFilter.length === 0 ||
        statusFilter.includes(row.document.status)) &&
      (ownerFilter.length === 0 ||
        ownerFilter.includes(ownerKey(rowOwner(row))))
  );
  const rowsById = new Map(rows.map((row) => [row.document.id, row]));
  const now = Date.now();
  const items = visibleRows.map((row) =>
    documentToPrototypeListRow(row.document, now)
  );
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));

  const filterGroups: FilterMenuGroup[] = [
    {
      id: "status",
      label: "Status",
      options: uniqueOptions(
        rows.map((row) => ({
          id: row.document.status,
          label: statusLabels[row.document.status] ?? row.document.status,
        }))
      ),
      selectedValues: statusFilter,
      onToggle: (value) =>
        setStatusFilter((current) => toggleFacetValue(current, value)),
    },
    {
      id: "owner",
      label: "Owner",
      options: uniqueOptions(
        rows.map((row) => ({
          id: ownerKey(rowOwner(row)),
          label: ownerLabel(rowOwner(row)),
        }))
      ),
      selectedValues: ownerFilter,
      onToggle: (value) =>
        setOwnerFilter((current) => toggleFacetValue(current, value)),
    },
  ];

  const renderCell = (columnId: string, item: { id: string }) => {
    const row = rowsById.get(item.id);
    if (!row) {
      return null;
    }
    if (columnId === "updated") {
      return (
        <span className="text-muted-foreground text-xs">
          {formatRelativeTimeOrFallback(row.document.updatedAt)}
        </span>
      );
    }
    if (columnId === ASSIGNEE_COLUMN_ID) {
      return (
        <ArtifactListCell
          columnId="owner"
          document={row.document}
          editHandlers={NO_EDIT_HANDLERS}
        />
      );
    }
    // Owner is drawn from the assignee slot, so a row with its own owner
    // hands that person to the same cell.
    const document =
      columnId === "owner" && row.owner !== undefined
        ? { ...row.document, assignee: row.owner }
        : row.document;
    return (
      <ArtifactListCell
        collaborators={row.collaborators}
        columnId={columnId}
        commentCount={row.commentCount}
        document={document}
        editHandlers={NO_EDIT_HANDLERS}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {header}
      <GridTableListSurface
        className="min-h-0 flex-1"
        metrics={
          <SummaryCardRow
            className={SUMMARY_CARD_SURFACE_BAND_PROPS.className}
            density={CardDensity.Compact}
            wrapBelow={SUMMARY_CARD_SURFACE_BAND_PROPS.wrapBelow}
          >
            <MetricCard
              className={SUMMARY_CARD_SURFACE_BAND_PROPS.cardClassName}
              info={countMetric.info}
              label={countMetric.label}
              value={visibleRows.length}
            />
          </SummaryCardRow>
        }
        pagination={
          <ListSurfacePaginationFooter
            formatRange={branchesRangeReadout}
            isPlaceholderPage={false}
            onPageChange={setPage}
            page={page}
            pageSize={PAGE_SIZE}
            rowsOnPage={Math.min(PAGE_SIZE, items.length - page * PAGE_SIZE)}
            total={items.length}
            totalPages={totalPages}
          />
        }
        table={(mode) => (
          <GridTableV2
            columns={columns satisfies readonly GridTableV2Column[]}
            getRowId={(item) => item.id}
            gridTemplateColumns={[
              GRID_TABLE_V2_FAVORITE_TRACK,
              LEAD_TRACK,
              ...columns.map((column) => `${columnWidthPx(column.id)}px`),
            ].join(" ")}
            items={items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)}
            leadingLabel={leadingLabel}
            leadingUtilityLabel="Favorite"
            mode={mode}
            navigableHeaderCells
            renderCell={renderCell}
            renderLead={(item) => <GenericArtifactLead artifact={item} />}
            renderLeadingUtility={(item) => (
              <FavoriteButton
                isFavorite={favoriteIds.has(item.id)}
                onToggle={(next) =>
                  setFavoriteIds((current) => {
                    const updated = new Set(current);
                    if (next) {
                      updated.add(item.id);
                    } else {
                      updated.delete(item.id);
                    }
                    return updated;
                  })
                }
              />
            )}
            // ISS-12288's row window is ruled for the Sessions list only.
            virtualizeRows={false}
          />
        )}
        toolbar={(mode) => (
          <ListSurfaceToolbarV2
            columns={allColumns.map((column) => ({
              key: column.id,
              label: column.label,
            }))}
            dateRange={dateRange}
            dateRangeOptions={TABLE_DATE_RANGE_OPTIONS}
            filterController={NOOP_TABLE_FILTERS_CONTROLLER}
            filterViewModel={buildFacetOnlyFiltersViewModel(filterGroups)}
            mode={mode}
            onClearFilters={() => {
              setStatusFilter([]);
              setOwnerFilter([]);
            }}
            onDateRangeChange={setDateRange}
            onToggleColumn={(columnId) =>
              setVisibleColumnIds((current) => {
                const next = new Set(current);
                if (next.has(columnId)) {
                  next.delete(columnId);
                } else {
                  next.add(columnId);
                }
                return next;
              })
            }
            visibleColumnIds={visibleColumnIds}
          />
        )}
      />
    </div>
  );
}

function columnWidthPx(columnId: string): number {
  return (
    ARTIFACT_COLUMN_REGISTRY.get(columnId)?.width?.default ??
    DESIGN_ONLY_COLUMN_WIDTH_PX[columnId] ??
    DEFAULT_TRACK_PX
  );
}

function rowOwner(row: ArtifactListDesignRow): BasicUser | null {
  return row.owner === undefined ? row.document.assignee : row.owner;
}

function ownerKey(owner: BasicUser | null): string {
  return owner?.id ?? "unassigned";
}

function ownerLabel(owner: BasicUser | null): string {
  return owner ? getUserDisplayName(owner) : UNASSIGNED_ASSIGNEE_LABEL;
}

function uniqueOptions(
  options: readonly { id: string; label: string }[]
): { id: string; label: string }[] {
  return [...new Map(options.map((option) => [option.id, option])).values()];
}
