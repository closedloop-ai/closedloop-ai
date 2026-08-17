import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  BranchRowStatus,
  shortRepoName,
} from "../../lib/branch-row";
import {
  BranchSortDir,
  type BranchSortKey,
  sortBranchRows,
} from "../../lib/branch-sort-group";
import { BranchesTable } from "../branches-table";

// FEA-4273 (shafty023 review): sorting a Branches saved view must never shift a
// cell out from under its declared header (the production report showed Status
// values — "Open"/"Merged"/"Draft" — rendering under the visible "Repository"
// header). The earlier version of this suite pre-sorted the props and wired
// `onSort` to a no-op, so it never exercised sorting: clicking a header did
// nothing, and it compared `data-column-id`s that `GridTable` derives from the
// SAME ordered-column array for both header and body (true by construction).
//
// These tests instead drive REAL header clicks through a stateful, page-equivalent
// harness that owns `sortBy`/`sortDir` and re-sorts via the production
// `sortBranchRows` on every `onSort` — the exact contract the Branches page wires.
// We then assert the observable outcome: the RENDERED rows reorder by the sorted
// column's real values, and each row's rendered Repository/Status text stays under
// its own header, for both directions, across the sortable keys, and under a saved
// view that hides + reorders columns.

const baseRow: BranchRow = {
  id: "base",
  branchName: "feature/base",
  baseBranch: "main",
  repo: "acme/base",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "Add feature",
  prUrl: "https://gh/acme/base/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: ChecksStatus.Passing,
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

// Three rows whose Changes total, Status, Repository, Linked Sessions, and
// last-active instant all DIFFER, so a sort on any of those keys produces a
// distinct, checkable row order and the categorical columns never collapse
// (FEA-3968 collapses a Status/Repository/Owner column that is constant).
const rowHighLoc: BranchRow = {
  ...baseRow,
  id: "high-loc",
  branchName: "feature/high-loc",
  owner: "Sam Lee",
  repo: "acme/api",
  status: BranchRowStatus.Merged,
  additions: 400,
  deletions: 41, // total 441
  sessionCount: 1,
  lastActivityAt: "2026-07-20T10:00:00Z",
};
const rowLowLoc: BranchRow = {
  ...baseRow,
  id: "low-loc",
  branchName: "feature/low-loc",
  owner: "Alex Rivera",
  repo: "acme/web",
  status: BranchRowStatus.Open,
  additions: 3,
  deletions: 1, // total 4
  sessionCount: 9,
  lastActivityAt: "2026-07-24T10:00:00Z",
};
const rowMidLoc: BranchRow = {
  ...baseRow,
  id: "mid-loc",
  branchName: "feature/mid-loc",
  owner: "Jordan Fox",
  repo: "acme/cli",
  status: BranchRowStatus.Draft,
  additions: 50,
  deletions: 10, // total 60
  sessionCount: 5,
  lastActivityAt: "2026-07-22T10:00:00Z",
};

const UNSORTED_ROWS = [rowLowLoc, rowHighLoc, rowMidLoc];

// A page-equivalent controller: owns the sort state and re-sorts the rows through
// the SAME `sortBranchRows` the Branches page uses, so a header click actually
// reorders what the table renders. This is what makes the sort real instead of a
// no-op onSort over pre-sorted props.
function StatefulBranchesTable({
  rows,
  columnOrder,
  visibleColumns,
}: {
  rows: BranchRow[];
  columnOrder?: readonly string[];
  visibleColumns?: Set<string>;
}) {
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<BranchSortDir>(BranchSortDir.Desc);
  const ordered =
    sortBy == null
      ? rows
      : sortBranchRows(rows, sortBy as BranchSortKey, sortDir);
  return (
    <BranchesTable
      columnOrder={columnOrder}
      items={ordered}
      onSort={(column, direction) => {
        setSortBy(column);
        setSortDir(direction as BranchSortDir);
      }}
      sortBy={sortBy}
      sortDir={sortDir}
      visibleColumns={visibleColumns}
    />
  );
}

// A DATA row is a `div.grid` whose FIRST child (the lead cell — the only cell with
// no `data-column-id`) renders the branch name in a `span.font-mono`. Scoping to
// the lead cell avoids matching the font-mono `+adds−dels` text the Changes cell
// also renders, and excludes the header row (also a `div.grid`) which has no such
// lead span. We read the rows in DOM order.
function dataRowGrids(): { grid: Element; branchName: string }[] {
  const grids = [...document.querySelectorAll("div.grid")];
  const rows: { grid: Element; branchName: string }[] = [];
  for (const grid of grids) {
    const leadName = grid.querySelector(
      ":scope > div:first-child span.font-mono"
    );
    const branchName = leadName?.textContent?.trim() ?? "";
    if (branchName.length > 0) {
      rows.push({ grid, branchName });
    }
  }
  return rows;
}

function renderedBranchOrder(): string[] {
  return dataRowGrids().map((row) => row.branchName);
}

// The rendered Repository / Status text inside a given row's grid, read from the
// cell that carries that column's own `data-column-id`. Independently sourced from
// the header-id comparison: this is the text a user actually reads in the cell.
function cellTextInRow(rowName: string, columnId: string): string | null {
  const match = dataRowGrids().find((row) => row.branchName === rowName);
  if (!match) {
    return null;
  }
  const cell = match.grid.querySelector(`[data-column-id="${columnId}"]`);
  return cell?.textContent?.trim() ?? null;
}

function repoLabel(row: BranchRow): string {
  return shortRepoName(row.repo);
}
function statusLabel(row: BranchRow): string {
  return BRANCH_STATUS_CONFIG[row.status].label;
}

function clickSortHeader(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

describe("BranchesTable sort behavior (FEA-4273)", () => {
  it("reorders the rendered rows by real Changes totals when the Changes header is clicked (desc then asc)", () => {
    render(<StatefulBranchesTable rows={UNSORTED_ROWS} />);

    // Before any sort: the rows render in input order, NOT sorted by Changes.
    expect(renderedBranchOrder()).toEqual([
      rowLowLoc.branchName,
      rowHighLoc.branchName,
      rowMidLoc.branchName,
    ]);

    // First click on an inactive column emits desc (getNextSortDirection):
    // rows reorder by descending change total 441 > 60 > 4.
    clickSortHeader("Changes");
    expect(renderedBranchOrder()).toEqual([
      rowHighLoc.branchName,
      rowMidLoc.branchName,
      rowLowLoc.branchName,
    ]);

    // Second click toggles to asc: ascending change total 4 < 60 < 441.
    clickSortHeader("Changes");
    expect(renderedBranchOrder()).toEqual([
      rowLowLoc.branchName,
      rowMidLoc.branchName,
      rowHighLoc.branchName,
    ]);
  });

  it("keeps each row's rendered Repository and Status text under its OWN header after a real Changes sort", () => {
    render(<StatefulBranchesTable rows={UNSORTED_ROWS} />);
    clickSortHeader("Changes"); // desc

    // The row order changed; assert each row still shows its own Repository and
    // Status value — a swapped cell (the reported bug) would fail here because we
    // read the value from the cell carrying that column's data-column-id.
    for (const row of UNSORTED_ROWS) {
      expect(cellTextInRow(row.branchName, "repo")).toBe(repoLabel(row));
      expect(cellTextInRow(row.branchName, "status")).toBe(statusLabel(row));
    }
  });

  it("sorts by every sortable column when its header is clicked", () => {
    render(<StatefulBranchesTable rows={UNSORTED_ROWS} />);

    // Repository (string, desc): acme/web > acme/cli > acme/api by short name.
    clickSortHeader("Repository");
    expect(renderedBranchOrder()).toEqual([
      rowLowLoc.branchName, // web
      rowMidLoc.branchName, // cli
      rowHighLoc.branchName, // api
    ]);

    // Status (string label, desc): "Open" > "Merged" > "Draft".
    clickSortHeader("Status");
    expect(renderedBranchOrder()).toEqual([
      rowLowLoc.branchName, // Open
      rowHighLoc.branchName, // Merged
      rowMidLoc.branchName, // Draft
    ]);

    // Linked Sessions (numeric, desc): 9 > 5 > 1.
    clickSortHeader("Linked Sessions");
    expect(renderedBranchOrder()).toEqual([
      rowLowLoc.branchName, // 9
      rowMidLoc.branchName, // 5
      rowHighLoc.branchName, // 1
    ]);

    // Last active (instant, desc = newest first): 07-24 > 07-22 > 07-20.
    clickSortHeader("Last active");
    expect(renderedBranchOrder()).toEqual([
      rowLowLoc.branchName, // 07-24
      rowMidLoc.branchName, // 07-22
      rowHighLoc.branchName, // 07-20
    ]);
  });

  it("drives a real Changes sort under a saved view that hides Owner and reorders Repository after Status", () => {
    render(
      <StatefulBranchesTable
        columnOrder={["status", "repo", "changes", "sessions", "lastActivity"]}
        rows={UNSORTED_ROWS}
        visibleColumns={
          new Set(["repo", "status", "changes", "sessions", "lastActivity"])
        }
      />
    );

    clickSortHeader("Changes"); // desc under the saved-view arrangement

    // The rows reorder by real change totals even with a saved view active.
    expect(renderedBranchOrder()).toEqual([
      rowHighLoc.branchName,
      rowMidLoc.branchName,
      rowLowLoc.branchName,
    ]);

    // Owner is hidden; Status precedes Repository in the persisted order. Each
    // row's Repository/Status text still reads from its own column cell, so a
    // Status value never renders under the Repository header.
    const header = screen.getByText("Branch").closest("div.grid");
    expect(header).not.toBeNull();
    const headerText = header?.textContent ?? "";
    expect(headerText).not.toContain("Owner");
    for (const row of UNSORTED_ROWS) {
      expect(cellTextInRow(row.branchName, "owner")).toBeNull();
      expect(cellTextInRow(row.branchName, "repo")).toBe(repoLabel(row));
      expect(cellTextInRow(row.branchName, "status")).toBe(statusLabel(row));
    }
  });

  it("keeps the header column order and the body column order identical after a sort (structural alignment)", () => {
    render(<StatefulBranchesTable rows={UNSORTED_ROWS} />);
    clickSortHeader("Changes");

    const columnIdsOf = (grid: Element) =>
      [...grid.querySelectorAll("[data-column-id]")].map(
        (cell) => cell.getAttribute("data-column-id") ?? ""
      );
    const header = screen.getByText("Branch").closest("div.grid");
    expect(header).not.toBeNull();
    const headerIds = columnIdsOf(header as Element);
    expect(headerIds).toContain("repo");
    expect(headerIds).toContain("status");
    // Every DATA row's cell id order matches the header id order after the sort.
    const dataGrids = dataRowGrids();
    expect(dataGrids.length).toBe(UNSORTED_ROWS.length);
    for (const { grid } of dataGrids) {
      expect(columnIdsOf(grid)).toEqual(headerIds);
    }
  });
});
