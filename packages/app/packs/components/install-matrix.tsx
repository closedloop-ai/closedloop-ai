"use client";

import {
  buildInstallMatrixView,
  countMatrixStates,
  EMPTY_INSTALL_MATRIX_FILTER,
  filterInstallMatrixView,
  INSTALL_MATRIX_FILTER_ALL,
  type InstallMatrixFilter,
  type MatrixGridCell,
  type MatrixRow,
  pageMatrixRows,
  pruneStaleFilterSelections,
} from "@repo/app/packs/lib/install-matrix-view";
import {
  INSTALL_STATE_LABEL,
  PackInstallState,
} from "@repo/app/packs/lib/install-state";
import type { PackComponentInstallMatrix } from "@repo/app/packs/lib/pack-install-matrix";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import {
  type TableFilterGroup,
  TableFilterMenu,
} from "@repo/design-system/components/ui/table-filter-menu";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import { LayoutGridIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InstallMatrixRollupCard } from "./install-matrix-rollup";
import { InstallStateStatus } from "./install-state-status";
import { harnessLabel } from "./pack-meta";

// FEA-4081 — the admin org-wide install matrix. One place to see and manage what
// is installed across every org compute target × harness for a component. Rows =
// compute targets, columns = harnesses (derived from the FEA-4072a cells, not
// hardcoded). Each data cell renders exactly ONE canonical `PackInstallState`
// through the shared `InstallStateStatus` (say-it-once icon + label, non-color-
// only). The rollup card above reconciles with the grid because both derive from
// the same flat cell set (`countMatrixStates(view.cells)` — see
// `install-matrix-view`). Reuses `GridTable` + `table-filter-menu` +
// `table-pagination`; no hand-rolled table.

const ROWS_PER_PAGE = 8;

type InstallMatrixProps = {
  /**
   * The per-(target × harness) install matrix for the component (FEA-4072a). A
   * pack carries one `PackComponentInstallMatrix` per component; the caller
   * passes the one whose matrix to show. Null/absent renders the empty state.
   */
  readonly matrix: PackComponentInstallMatrix | null | undefined;
  /** The component name, for the empty-state copy. */
  readonly componentName?: string;
};

// The lead names the machine. Reachability is not a separate dot here: an
// offline target reads its honest state per (target × harness) cell (an Offline
// cell for every column), so the row never claims a status the cells don't back.
// Offline and failed targets stay visible; the matrix shows every target.
const TargetLead = ({ row }: { row: MatrixRow }) => (
  <div className="flex min-w-0 items-center gap-2">
    <MonitorIcon
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground"
    />
    <span className="truncate font-medium text-sm">
      {row.computeTargetName}
    </span>
  </div>
);

// One data cell: the single canonical install state for that (target × harness)
// coordinate, plus the honest per-target detail (installed version / failure
// reason) the FEA-4072a cell supplied so the admin sees what and why without a
// second lookup.
const MatrixCell = ({ cell }: { cell: MatrixGridCell }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <InstallStateStatus state={cell.state} />
    {cell.state === PackInstallState.Installed && cell.installedVersion ? (
      <span className="truncate pl-6 text-muted-foreground text-xs tabular-nums">
        v{cell.installedVersion}
      </span>
    ) : null}
    {cell.state === PackInstallState.Failed && cell.failureReason ? (
      <span className="truncate pl-6 text-destructive text-xs">
        {cell.failureReason}
      </span>
    ) : null}
  </div>
);

const MATRIX_EMPTY = (componentName: string | undefined) => (
  <EmptyState
    description={
      componentName
        ? `${componentName} isn't distributed to any compute target yet, so there's nothing to show across harnesses.`
        : "This component isn't distributed to any compute target yet, so there's nothing to show across harnesses."
    }
    icon={LayoutGridIcon}
    title="No install targets yet"
  />
);

// The status filter options are the canonical install states, so the admin can
// narrow to any honest state (including offline / failed) — never a hardcoded
// subset that hides a state.
const STATUS_FILTER_OPTIONS = [
  { value: INSTALL_MATRIX_FILTER_ALL, label: "All statuses" },
  ...Object.values(PackInstallState).map((state) => ({
    value: state,
    label: INSTALL_STATE_LABEL[state],
  })),
];

export const InstallMatrix = ({
  matrix,
  componentName,
}: InstallMatrixProps) => {
  const [filter, setFilter] = useState<InstallMatrixFilter>(
    EMPTY_INSTALL_MATRIX_FILTER
  );
  const [page, setPage] = useState(0);

  // The full pivoted view — the single source of truth. The card rollup and the
  // grid both derive from `filtered.cells`, so the aggregate always reconciles
  // with the rows the grid renders (Parker: card counts == matrix).
  const view = useMemo(() => buildInstallMatrixView(matrix), [matrix]);

  // Keep the active selection honest as the shown matrix changes:
  //  - a NEW component (different pack selected) fully resets the filter + page,
  //    so a machine/harness/status choice from the previous pack never carries
  //    over to a different pack's grid;
  //  - a SAME-component refresh (same id, new data) keeps the active filter but
  //    prunes any machine/harness selection whose value has disappeared from the
  //    refreshed view — a stale selection is no longer offered in the menu, so
  //    left in place it would silently drive the grid to zero rows with no way to
  //    clear it (`pruneStaleFilterSelections`).
  const componentId = matrix?.componentId ?? null;
  const previousComponentId = useRef<string | null>(componentId);
  useEffect(() => {
    if (previousComponentId.current !== componentId) {
      previousComponentId.current = componentId;
      setFilter(EMPTY_INSTALL_MATRIX_FILTER);
      setPage(0);
      return;
    }
    setFilter((prev) => pruneStaleFilterSelections(prev, view));
  }, [componentId, view]);
  const filtered = useMemo(
    () => filterInstallMatrixView(view, filter),
    [view, filter]
  );
  const rollup = useMemo(
    () => countMatrixStates(filtered.cells),
    [filtered.cells]
  );

  const columns: readonly GridTableColumn[] = useMemo(
    () =>
      filtered.harnesses.map((harness) => ({
        id: harness,
        label: harnessLabel(harness),
      })),
    [filtered.harnesses]
  );
  const gridTemplate = useMemo(
    () =>
      `minmax(12rem,1.4fr) repeat(${Math.max(1, filtered.harnesses.length)}, minmax(11rem,1fr))`,
    [filtered.harnesses.length]
  );

  const paged = useMemo(
    () => pageMatrixRows(filtered.rows, page, ROWS_PER_PAGE),
    [filtered.rows, page]
  );

  const handleFilterChange = useCallback(
    (next: Partial<InstallMatrixFilter>) => {
      setFilter((prev) => ({ ...prev, ...next }));
      setPage(0);
    },
    []
  );

  const filterGroups: TableFilterGroup[] = useMemo(
    () => [
      {
        id: "machine",
        label: "Machine",
        icon: <MonitorIcon className="size-4" />,
        value: filter.computeTargetId,
        onValueChange: (value) =>
          handleFilterChange({ computeTargetId: value }),
        options: [
          { value: INSTALL_MATRIX_FILTER_ALL, label: "All machines" },
          ...view.rows.map((row) => ({
            value: row.computeTargetId,
            label: row.computeTargetName,
          })),
        ],
      },
      {
        id: "harness",
        label: "Harness",
        icon: <TerminalIcon className="size-4" />,
        value: filter.harness,
        onValueChange: (value) => handleFilterChange({ harness: value }),
        options: [
          { value: INSTALL_MATRIX_FILTER_ALL, label: "All harnesses" },
          ...view.harnesses.map((harness) => ({
            value: harness,
            label: harnessLabel(harness),
          })),
        ],
      },
      {
        id: "status",
        label: "Status",
        icon: <LayoutGridIcon className="size-4" />,
        value: filter.state,
        onValueChange: (value) => handleFilterChange({ state: value }),
        options: STATUS_FILTER_OPTIONS,
      },
    ],
    [filter, view.rows, view.harnesses, handleFilterChange]
  );

  if (view.rows.length === 0) {
    return MATRIX_EMPTY(componentName);
  }

  return (
    <div className="space-y-5">
      <InstallMatrixRollupCard rollup={rollup} />

      <div className="flex items-center justify-between gap-4">
        <TableFilterMenu groups={filterGroups} />
        <span className="text-muted-foreground text-sm tabular-nums">
          {filtered.rows.length} of {view.rows.length}{" "}
          {view.rows.length === 1 ? "target" : "targets"}
        </span>
      </div>

      {filtered.rows.length === 0 ? (
        <EmptyState
          description="No targets match the current filters. Clear a filter to see more."
          icon={LayoutGridIcon}
          title="Nothing matches"
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <GridTable
              columns={columns}
              getRowId={(row) => row.computeTargetId}
              gridTemplateColumns={gridTemplate}
              items={paged.rows}
              leadingLabel="Target"
              renderCell={(columnId, row) => {
                const cell = row.cellsByHarness[columnId];
                return cell ? <MatrixCell cell={cell} /> : null;
              }}
              renderLead={(row) => <TargetLead row={row} />}
            />
          </div>
          <TablePagination
            className="justify-end"
            onPageChange={setPage}
            page={paged.page}
            totalPages={paged.totalPages}
          />
        </>
      )}
    </div>
  );
};
