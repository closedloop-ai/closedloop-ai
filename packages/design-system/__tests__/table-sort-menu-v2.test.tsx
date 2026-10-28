import { TableSortMenu } from "@closedloop-ai/design-system/components/ui/table-sort-menu-v2";
import type { TableSortRule } from "@closedloop-ai/design-system/components/ui/table-toolbar-model";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

const APPLIED_STATUS_ASCENDING = /1\.\s*Status\s*Ascending/;

const OPTIONS = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
  { id: "updated", label: "Updated" },
];

function SortMenuHarness({ maxSortRules }: { maxSortRules?: number }) {
  const [sorts, setSorts] = useState<readonly TableSortRule[]>([]);
  return (
    <TableSortMenu
      maxSortRules={maxSortRules}
      onClear={() => setSorts([])}
      // The capped path routes through `onSort`, exactly as a host's
      // `applySort` does: it REPLACES the primary rather than appending.
      onSort={(fieldId, direction) => setSorts([{ direction, fieldId }])}
      onSortsChange={setSorts}
      options={OPTIONS}
      sortBy={sorts[0]?.fieldId ?? null}
      sorts={sorts}
    />
  );
}

function openSortMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

describe("TableSortMenu ordered sorts", () => {
  it("keeps the trigger icon while all sort field and applied-action items omit icons", () => {
    render(<SortMenuHarness />);

    const trigger = screen.getByRole("button", { name: "Sort" });
    expect(trigger.querySelector("svg")).not.toBeNull();
    openSortMenu("Sort");
    expect(
      screen
        .getAllByRole("menuitem")
        .every((item) => item.querySelector("svg") === null)
    ).toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Status" }));

    openSortMenu("Sorted by Status");
    const applied = screen.getByRole("menuitem", {
      name: APPLIED_STATUS_ASCENDING,
    });
    fireEvent.keyDown(applied, { key: "ArrowRight" });
    for (const name of ["Ascending", "Descending", "Remove sort"]) {
      expect(
        screen.getByRole("menuitem", { name }).querySelector("svg")
      ).toBeNull();
    }
  });

  it("adds more than one field without replacing the earlier clause", () => {
    render(<SortMenuHarness />);

    openSortMenu("Sort");
    fireEvent.click(screen.getByRole("menuitem", { name: "Status" }));
    openSortMenu("Sorted by Status");
    fireEvent.click(screen.getByRole("menuitem", { name: "Owner" }));

    expect(
      screen.getByRole("button", { name: "Sorted by Status, then Owner" })
    ).toHaveTextContent("Sorts: 2");
  });

  /**
   * ISS-9107 (whitlockk review): a host whose query resolves ONE ordering rule —
   * the desktop shell sends its SQLite source only `sortBy`/`sortDir` — must
   * not be offered a second. Stacking here would persist and display an order
   * the rows underneath were never put in.
   */
  it("replaces the rule instead of stacking one past the caller's cap", () => {
    render(<SortMenuHarness maxSortRules={1} />);

    openSortMenu("Sort");
    fireEvent.click(screen.getByRole("menuitem", { name: "Status" }));
    openSortMenu("Sorted by Status");
    // The section must not invite an addition it will not make.
    expect(screen.getByText("Sort by")).toBeInTheDocument();
    expect(screen.queryByText("Add another sort")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Owner" }));

    expect(
      screen.getByRole("button", { name: "Sorted by Owner" })
    ).toHaveTextContent("Sorts: 1");
  });

  it("keeps the direction control live at the cap", () => {
    render(<SortMenuHarness maxSortRules={1} />);

    openSortMenu("Sort");
    fireEvent.click(screen.getByRole("menuitem", { name: "Status" }));
    openSortMenu("Sorted by Status");

    // The applied rule keeps its direction/Remove submenu at the cap — capping
    // narrows what can be ADDED, and a rule the reader cannot re-point or drop
    // would be the dead control this change exists to avoid.
    expect(
      screen.getByRole("menuitem", { name: APPLIED_STATUS_ASCENDING })
    ).toBeInTheDocument();
  });
});
