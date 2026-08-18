import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ComputeTargetSyncRow,
  ComputeTargetSyncTable,
} from "../compute-target-sync-table";

/**
 * ISS-5280 (review): this table had no test of its own — the only case that
 * exercised its column shape lived in `context-cards.test.tsx` as the flag-OFF
 * branch, and retiring the flag took it with it. The table now owns coverage of
 * the contract a caller depends on: a fixed column set, and every row reading
 * its OWN value in each of the three relative-time columns.
 *
 * The three time columns all render the same shape of value ("3m ago"), so a
 * value landing one column off is invisible to a bare text query. Every
 * assertion below therefore resolves a cell BY its column index.
 */

const ROWS: ComputeTargetSyncRow[] = [
  {
    id: "target-online",
    machineName: "Ada's MacBook Pro",
    ownerLabel: "Ada Lovelace",
    online: true,
    // Three distinct labels, so an assertion on one column can never be
    // satisfied by another column's text.
    lastSyncLabel: "3m ago",
    lastDataLabel: "3 days ago",
    lastSeenLabel: "just now",
  },
  {
    id: "target-never",
    machineName: "CI Runner 04",
    ownerLabel: "Design Systems",
    online: false,
    lastSyncLabel: "Never",
    lastDataLabel: "Never",
    lastSeenLabel: "2h ago",
  },
];

const EXPECTED_HEADERS = [
  "Compute Target",
  "Owner",
  "Status",
  "Last Sync",
  "Last New Data",
  "Last Seen",
];

function headers(): string[] {
  const [headerRow] = screen.getAllByRole("row");
  return Array.from(headerRow.querySelectorAll("th")).map(
    (cell) => cell.textContent ?? ""
  );
}

/** The text of one data row's cell under `columnLabel`. */
function cell(rowIndex: number, columnLabel: string): string {
  const columnIndex = headers().indexOf(columnLabel);
  // Index 0 is the header row, so data rows start at 1.
  const dataRow = screen.getAllByRole("row")[rowIndex + 1];
  const cells = Array.from(dataRow.querySelectorAll("td"));
  return cells[columnIndex]?.textContent ?? "";
}

afterEach(cleanup);

describe("ComputeTargetSyncTable", () => {
  it("renders one fixed column set, so no row can be half-labelled", () => {
    render(<ComputeTargetSyncTable rows={ROWS} />);

    expect(headers()).toEqual(EXPECTED_HEADERS);
  });

  it("reads each row's own watermark into each time column", () => {
    render(<ComputeTargetSyncTable rows={ROWS} />);

    expect(cell(0, "Last Sync")).toBe("3m ago");
    expect(cell(0, "Last New Data")).toBe("3 days ago");
    expect(cell(0, "Last Seen")).toBe("just now");

    // The second row's values must not be borrowed from the first: a target
    // that has never synced reads "Never" in both watermark columns while still
    // reporting its own heartbeat.
    expect(cell(1, "Last Sync")).toBe("Never");
    expect(cell(1, "Last New Data")).toBe("Never");
    expect(cell(1, "Last Seen")).toBe("2h ago");
  });

  it("renders the empty state instead of a headerless table", () => {
    render(<ComputeTargetSyncTable rows={[]} />);

    expect(screen.getByText("No compute targets yet")).toBeTruthy();
    expect(screen.queryAllByRole("row")).toEqual([]);
  });
});
