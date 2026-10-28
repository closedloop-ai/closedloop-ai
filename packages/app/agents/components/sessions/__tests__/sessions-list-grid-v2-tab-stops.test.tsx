/**
 * ISS-8726 — the WHOLE tab order of a rendered Sessions grid, driven with real
 * `Tab` presses, plus the production wiring that decides it.
 *
 * The DOM contract underneath lives in
 * `packages/design-system/__tests__/grid-table-v2-cell-tab-stops.test.tsx`.
 * What only this file can prove is that the resulting DOM produces the tab
 * SEQUENCE the ticket asks for, rather than just the tabindex values it is
 * built from. ISS-10245 retired `grid-table-v2-single-tab-stop` ENABLED, so this
 * file no longer reads any flag: `SessionsListGridV2` wires the suppression
 * unconditionally and what is pinned here is the shipped sequence.
 *
 * Every case asserts the full captured sequence, not one control. A row whose
 * favourite button lost its tab stop while the identity link kept its own would
 * pass a single-control assertion and still walk the grid.
 */

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import type { GridTableV2Column } from "@repo/design-system/components/ui/grid-table-v2";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListGridV2 } from "../sessions-list-grid-v2";
import { emptySessionsGridSelection } from "./sessions-selection.test-helpers";
import { renderWithFlags } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({ id: "ses-1", name: "agent/first-row" }),
];

const COLUMNS: readonly GridTableV2Column[] = [
  { id: "actions", label: "Actions" },
];

/**
 * Two controls in the one data cell, because a cell with several is the case
 * the release-on-entry half of the gate exists for — entry lands on the first,
 * and without it the second would have no keyboard route at all.
 */
const OPEN_LABEL = "Open first-row";
const RERUN_LABEL = "Rerun first-row";
const BEFORE_LABEL = "Before the grid";
const AFTER_LABEL = "After the grid";

function renderGrid() {
  stubContainerWidthPx(1400);
  return renderWithFlags(
    <>
      <button type="button">{BEFORE_LABEL}</button>
      <SessionsListGridV2
        columnOrder={COLUMNS.map((column) => column.id)}
        columns={COLUMNS}
        columnWidths={{ actions: 160 }}
        gridTemplateColumns="240px 160px"
        headerActions={{
          getFilterContent: () => null,
          onGroup: () => undefined,
        }}
        items={ROWS}
        leadingColumnWidth={240}
        mode="expanded"
        onColumnWidthChange={() => undefined}
        onLeadingColumnWidthChange={() => undefined}
        onSort={() => undefined}
        renderCell={() => (
          <>
            <button type="button">{OPEN_LABEL}</button>
            <button type="button">{RERUN_LABEL}</button>
          </>
        )}
        renderLead={(row) => <a href={`/sessions/${row.id}`}>{row.name}</a>}
        selection={emptySessionsGridSelection()}
        showGroupCounts={false}
        sortBy={null}
        sortDir="asc"
      />
      <button type="button">{AFTER_LABEL}</button>
    </>,
    []
  );
}

/**
 * What the grid contributes to the document's tab order, as stable names.
 * Header chrome (the sort controls each `columnheader` renders) is a separate
 * concern from a cell's contents and is reported as `header:` so a case can say
 * so out loud rather than silently absorbing it.
 */
function describeTabStop(element: Element | null): string {
  if (!(element instanceof HTMLElement)) {
    return "none";
  }
  const cell = element.closest<HTMLElement>("[data-grid-cell]");
  if (cell === element) {
    return `gridcell:${cell.closest<HTMLElement>("[data-grid-row]")?.dataset.gridRowId}`;
  }
  const label =
    element.textContent?.trim() || element.getAttribute("aria-label");
  if (cell) {
    return `incell:${label}`;
  }
  // Named by the COLUMN, not by the control: the header's chrome is a resize
  // handle whose accessible name carries the live pixel width, and a case about
  // tab order should not go red because a column got wider.
  const header = element.closest<HTMLElement>("[role='columnheader']");
  return header ? `header:${header.textContent?.trim()}` : `outside:${label}`;
}

/** Tab forward from the leading sentinel until the trailing one takes focus. */
async function tabSequenceThroughGrid(): Promise<string[]> {
  const user = userEvent.setup();
  screen.getByRole("button", { name: BEFORE_LABEL }).focus();
  const sequence: string[] = [];
  // Bounded so a gate that removed the trailing sentinel from the tab order
  // fails the assertion instead of hanging the suite.
  for (let step = 0; step < 20; step += 1) {
    await user.tab();
    const stop = describeTabStop(document.activeElement);
    sequence.push(stop);
    if (stop === `outside:${AFTER_LABEL}`) {
      return sequence;
    }
  }
  return sequence;
}

describe("SessionsListGridV2 tab order", () => {
  // BEHAVIOR CHANGE (ISS-10245): the "walks every control when the flag is off"
  // case asserted the PRE-GATE tab order, which no longer exists — ISS-8726's
  // `grid-table-v2-single-tab-stop` was retired ENABLED by operator ruling, so
  // the grid always suppresses in-cell tab stops. That case is gone rather than
  // weakened; the two below still pin the whole captured sequence, which is what
  // would catch the suppression being dropped.
  it("enters the grid once", async () => {
    renderGrid();

    // ONE stop for the whole grid, and not one control inside a cell.
    // BEHAVIOR CHANGE (ISS-10245): the two `header:` stops this used to expect
    // are gone. `grid-table-v2-navigable-header-cells` was retired ENABLED
    // alongside the single tab stop, so the column headers are now roving CELLS
    // inside the grid's one tab stop rather than native tab stops of their own.
    // That is the ISS-8930 contract arriving unconditionally, not a lost stop:
    // the headers stay keyboard-reachable by arrow key.
    expect(await tabSequenceThroughGrid()).toEqual([
      "gridcell:ses-1",
      `outside:${AFTER_LABEL}`,
    ]);
  });

  it("keeps a cell's second control reachable once the cell is entered", async () => {
    renderGrid();
    const user = userEvent.setup();
    const cell = screen
      .getByRole("button", { name: OPEN_LABEL })
      .closest<HTMLElement>("[data-grid-cell]");
    if (!cell) {
      throw new Error("the data cell did not render");
    }

    cell.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: OPEN_LABEL })).toHaveFocus();

    // Entry lands on the FIRST control only. If the gate held every descendant
    // at -1 for the life of the grid, this second control would be reachable by
    // pointer and by nothing else — a capability the gate must not take.
    await user.tab();
    expect(screen.getByRole("button", { name: RERUN_LABEL })).toHaveFocus();
  });
});
