/**
 * Org-wide install-matrix view-model (FEA-4081).
 *
 * The admin needs one place to see and manage what is installed across every org
 * compute target × harness for a component. This module pivots the already-built
 * per-(target × harness) `PackComponentInstallMatrix` cells (FEA-4072a,
 * `./pack-install-matrix`) into the row/column grid the admin matrix renders, and
 * computes the aggregate rollup the detail card shows.
 *
 * The Parker reconciliation principle (FEA-4074 prototype): the aggregate MUST
 * reconcile with the rows. The card's per-state counts are computed from the
 * exact same cell set the grid renders (`countMatrixStates` over `matrixCells`),
 * so the card can never claim a number the matrix doesn't show. There is one
 * source of truth — the flat cell list — and both the card and the grid derive
 * from it.
 *
 * No new schema and no new vocabulary: cells carry the canonical FEA-4083
 * `PackInstallState`, targets/harnesses come straight off the FEA-4072a cells,
 * and an absent (target × harness) coordinate is filled as `Unsupported` (the
 * harness has no cell for this target, so there is nothing to install) so the
 * grid is complete and honest — offline/failed rows stay present and filterable,
 * never dropped.
 *
 * `@repo/app` is consumed by both the web app and the desktop renderer, so this
 * view-model stays surface-agnostic (pure functions over the FEA-4072a model).
 */

import { PackInstallState } from "./install-state";
import type {
  PackComponentInstallMatrix,
  PackInstallCell,
} from "./pack-install-matrix";

/**
 * The special filter value meaning "no filter on this dimension" — every
 * machine, every harness, every status. A const so no surface hand-rolls the
 * bare string.
 */
export const INSTALL_MATRIX_FILTER_ALL = "all" as const;

/**
 * One (target × harness) grid cell as the matrix renders it. Carries the single
 * canonical `PackInstallState` plus the honest per-target detail the FEA-4072a
 * cell supplied, so the grid shows what/why without re-deriving it. `harness` is
 * the column; the enclosing row supplies the target.
 */
export type MatrixGridCell = {
  harness: string;
  state: PackInstallState;
  installedVersion: string | null;
  failureReason: string | null;
};

/**
 * One matrix row: a compute target and its cell for every harness column, keyed
 * by harness id. A harness the target has no FEA-4072a cell for is filled with an
 * `Unsupported` cell so every row is rectangular and the grid never has a hole.
 */
export type MatrixRow = {
  computeTargetId: string;
  computeTargetName: string;
  cellsByHarness: Record<string, MatrixGridCell>;
};

/**
 * The pivoted matrix view-model: the harness columns (stable order), the target
 * rows, and the flat cell list the rollup is computed from. `cells` is the single
 * source of truth the card and the grid both derive from — reconciliation is
 * structural, not a re-count.
 */
export type InstallMatrixView = {
  harnesses: string[];
  rows: MatrixRow[];
  /** Every (target × harness) cell, flattened — the reconciliation source. */
  cells: MatrixGridCell[];
};

/**
 * Per-state tally over a set of matrix cells. Exhaustive over the
 * `PackInstallState` union so a card built from this covers every state the grid
 * can show; a new state fails typecheck at the builder below until it is counted.
 */
export type InstallMatrixRollup = Record<PackInstallState, number> & {
  /** Total cells counted — equals the sum of the per-state counts. */
  total: number;
};

/**
 * The active filter selection for the matrix. Each dimension is either
 * `INSTALL_MATRIX_FILTER_ALL` or a concrete value (a compute target id, a harness
 * id, or a `PackInstallState`). Offline/failed rows are never special-cased out —
 * they are ordinary status values a filter can narrow to, not hide.
 */
export type InstallMatrixFilter = {
  computeTargetId: string;
  harness: string;
  state: string;
};

/** The no-op filter: every machine, harness, and status. */
export const EMPTY_INSTALL_MATRIX_FILTER: InstallMatrixFilter = {
  computeTargetId: INSTALL_MATRIX_FILTER_ALL,
  harness: INSTALL_MATRIX_FILTER_ALL,
  state: INSTALL_MATRIX_FILTER_ALL,
};

/**
 * Collect the harness columns present across a component's cells, in first-seen
 * order. Columns are derived from the data, not hardcoded, so a component
 * distributed to Claude + Codex shows exactly those two columns and a future
 * harness needs no code change here.
 */
function collectHarnesses(cells: readonly PackInstallCell[]): string[] {
  const seen: string[] = [];
  const present = new Set<string>();
  for (const cell of cells) {
    if (!present.has(cell.harness)) {
      present.add(cell.harness);
      seen.push(cell.harness);
    }
  }
  return seen;
}

/**
 * Collect the target rows present across a component's cells, in first-seen
 * order, deduping by compute target id. A target that appears on several harness
 * cells contributes one row.
 */
function collectTargets(
  cells: readonly PackInstallCell[]
): { computeTargetId: string; computeTargetName: string }[] {
  const seen: { computeTargetId: string; computeTargetName: string }[] = [];
  const present = new Set<string>();
  for (const cell of cells) {
    if (!present.has(cell.computeTargetId)) {
      present.add(cell.computeTargetId);
      seen.push({
        computeTargetId: cell.computeTargetId,
        computeTargetName: cell.computeTargetName,
      });
    }
  }
  return seen;
}

/** Build the (target id, harness) → cell lookup for the pivot. */
function indexCells(
  cells: readonly PackInstallCell[]
): Map<string, PackInstallCell> {
  const byKey = new Map<string, PackInstallCell>();
  for (const cell of cells) {
    byKey.set(cellKey(cell.computeTargetId, cell.harness), cell);
  }
  return byKey;
}

// Join with a NUL delimiter, written as the `\u0000` source escape and never
// a literal NUL byte — a raw NUL makes git treat the whole file as binary and
// undiffable. NUL cannot appear in a compute-target id or harness, so the two
// segments can never be forged into a colliding key.
function cellKey(computeTargetId: string, harness: string): string {
  return `${computeTargetId}\u0000${harness}`;
}

/**
 * The cell for a (target × harness) coordinate: the stored FEA-4072a cell
 * projected to `MatrixGridCell`, or an `Unsupported` fill when the target has no
 * cell for that harness (the harness has no install for this target, so there is
 * nothing to act on — never an optimistic blank).
 */
function gridCellFor(
  byKey: ReadonlyMap<string, PackInstallCell>,
  computeTargetId: string,
  harness: string
): MatrixGridCell {
  const cell = byKey.get(cellKey(computeTargetId, harness));
  if (cell) {
    return {
      harness,
      state: cell.state,
      installedVersion: cell.installedVersion ?? null,
      failureReason: cell.failureReason ?? null,
    };
  }
  return {
    harness,
    state: PackInstallState.Unsupported,
    installedVersion: null,
    failureReason: null,
  };
}

/**
 * Pivot a component's flat FEA-4072a cells into the rectangular row/column grid
 * the admin matrix renders. Every (target × harness) coordinate gets a cell —
 * missing coordinates are `Unsupported` — so the grid is complete and the flat
 * `cells` list is the reconciliation source both the card rollup and the grid
 * derive from.
 */
export function buildInstallMatrixView(
  matrix: PackComponentInstallMatrix | null | undefined
): InstallMatrixView {
  const cells = matrix?.cells ?? [];
  const harnesses = collectHarnesses(cells);
  const targets = collectTargets(cells);
  const byKey = indexCells(cells);

  const rows: MatrixRow[] = [];
  const flatCells: MatrixGridCell[] = [];
  for (const target of targets) {
    const cellsByHarness: Record<string, MatrixGridCell> = {};
    for (const harness of harnesses) {
      const gridCell = gridCellFor(byKey, target.computeTargetId, harness);
      cellsByHarness[harness] = gridCell;
      flatCells.push(gridCell);
    }
    rows.push({
      computeTargetId: target.computeTargetId,
      computeTargetName: target.computeTargetName,
      cellsByHarness,
    });
  }

  return { harnesses, rows, cells: flatCells };
}

/**
 * Tally a set of matrix cells by state. Seeded with a zero for every
 * `PackInstallState` member so the returned rollup is exhaustive (every state
 * present as a key), then incremented per cell. `total` equals the sum of the
 * per-state counts, so the card built from this reconciles with the exact cell
 * set passed in.
 */
export function countMatrixStates(
  cells: readonly MatrixGridCell[]
): InstallMatrixRollup {
  const rollup = { total: 0 } as InstallMatrixRollup;
  for (const state of Object.values(PackInstallState)) {
    rollup[state] = 0;
  }
  for (const cell of cells) {
    rollup[cell.state] += 1;
    rollup.total += 1;
  }
  return rollup;
}

/**
 * Whether a row survives the machine filter. A machine filter narrows to one
 * compute target id; `all` keeps every target (including offline/failed ones).
 */
function rowMatchesTarget(
  row: MatrixRow,
  filter: InstallMatrixFilter
): boolean {
  return (
    filter.computeTargetId === INSTALL_MATRIX_FILTER_ALL ||
    row.computeTargetId === filter.computeTargetId
  );
}

/**
 * Whether a cell survives the harness + status filters. A harness filter narrows
 * to one column; a status filter narrows to one `PackInstallState`. Offline and
 * failed are ordinary status values here — filtering TO them is supported, and
 * an unrelated status filter never silently hides them.
 */
function cellMatches(
  cell: MatrixGridCell,
  filter: InstallMatrixFilter
): boolean {
  const harnessOk =
    filter.harness === INSTALL_MATRIX_FILTER_ALL ||
    cell.harness === filter.harness;
  const stateOk =
    filter.state === INSTALL_MATRIX_FILTER_ALL || cell.state === filter.state;
  return harnessOk && stateOk;
}

/**
 * Apply a filter to the matrix view. A row is kept when it matches the machine
 * filter AND has at least one cell surviving the harness + status filters; the
 * kept row's cells are narrowed to the surviving harness columns so the grid and
 * the rollup stay in lockstep. The returned view's `cells` is the filtered flat
 * list, so `countMatrixStates(filtered.cells)` reconciles with the filtered grid
 * exactly as the unfiltered pair does.
 *
 * A row filtered down to zero surviving cells is dropped (it would render as an
 * all-blank row); an offline/failed target is only ever dropped by an explicit
 * filter that excludes it, never as a side effect.
 */
export function filterInstallMatrixView(
  view: InstallMatrixView,
  filter: InstallMatrixFilter
): InstallMatrixView {
  const harnesses =
    filter.harness === INSTALL_MATRIX_FILTER_ALL
      ? view.harnesses
      : view.harnesses.filter((harness) => harness === filter.harness);

  const rows: MatrixRow[] = [];
  const flatCells: MatrixGridCell[] = [];
  for (const row of view.rows) {
    if (!rowMatchesTarget(row, filter)) {
      continue;
    }
    const cellsByHarness: Record<string, MatrixGridCell> = {};
    for (const harness of harnesses) {
      const cell = row.cellsByHarness[harness];
      if (cell && cellMatches(cell, filter)) {
        cellsByHarness[harness] = cell;
      }
    }
    const kept = Object.values(cellsByHarness);
    if (kept.length === 0) {
      continue;
    }
    rows.push({
      computeTargetId: row.computeTargetId,
      computeTargetName: row.computeTargetName,
      cellsByHarness,
    });
    flatCells.push(...kept);
  }

  return { harnesses, rows, cells: flatCells };
}

/**
 * Paginate the matrix rows. Clamps the page into range (floor 0) and returns the
 * page slice plus the total page count. The rollup card is always computed over
 * the FULL filtered cell set (not the page), so the aggregate reflects every
 * matching cell, not just the visible page — the card counts the whole matrix,
 * the grid shows a page of it.
 */
export function pageMatrixRows(
  rows: readonly MatrixRow[],
  page: number,
  pageSize: number
): { rows: MatrixRow[]; totalPages: number; page: number } {
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const clamped = Math.min(Math.max(0, page), totalPages - 1);
  const start = clamped * size;
  return {
    rows: rows.slice(start, start + size),
    totalPages,
    page: clamped,
  };
}

/**
 * Drop any machine/harness selection whose value no longer exists in the given
 * view, resetting it to `INSTALL_MATRIX_FILTER_ALL`. Used when a matrix is
 * refreshed in place (same component, new data): a stale selection is no longer
 * offered in the filter menu, so left in place it would silently drive the grid
 * to zero rows with no way to clear it. Status is a fixed vocabulary, so it is
 * never stale and is passed through untouched. Returns the same reference when
 * nothing changed so callers can skip a no-op state update.
 */
export function pruneStaleFilterSelections(
  filter: InstallMatrixFilter,
  view: InstallMatrixView
): InstallMatrixFilter {
  const targetIds = new Set(view.rows.map((row) => row.computeTargetId));
  const harnesses = new Set<string>(view.harnesses);
  const nextTarget =
    filter.computeTargetId === INSTALL_MATRIX_FILTER_ALL ||
    targetIds.has(filter.computeTargetId)
      ? filter.computeTargetId
      : INSTALL_MATRIX_FILTER_ALL;
  const nextHarness =
    filter.harness === INSTALL_MATRIX_FILTER_ALL ||
    harnesses.has(filter.harness)
      ? filter.harness
      : INSTALL_MATRIX_FILTER_ALL;
  if (nextTarget === filter.computeTargetId && nextHarness === filter.harness) {
    return filter;
  }
  return { ...filter, computeTargetId: nextTarget, harness: nextHarness };
}
