/**
 * ISS-8930, ISS-8747 and ISS-9821 — the production wiring the design-system
 * suites cannot reach.
 *
 * `packages/design-system/__tests__/grid-table-v2-chrome-roving.test.tsx` and
 * `…-row-range-drag.test.tsx` prove what `GridTableV2` DOES when each prop is
 * set. Only this file proves the thing that actually ships: that
 * `SessionsListGridV2` — the one production component rendering that grid —
 * forwards each capability. Delete the forwarding and every design-system case
 * stays green while the shipped surface never changes.
 *
 * ISS-10245 retired ISS-8930's and ISS-8747's keys ENABLED, so those two are now
 * asserted as UNCONDITIONAL wiring. ISS-9821's key is the only one left with a
 * flag to read, and it keeps both arms on the same fixture so a mode that leaked
 * on by default cannot pass as the gate working.
 */

import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import type {
  GridTableV2Column,
  GridTableV2Group,
  GridTableV2Mode,
} from "@repo/design-system/components/ui/grid-table-v2";
import { TableNumberCell } from "@repo/design-system/components/ui/table-cell-primitives";
import { ColumnAlignment } from "@repo/design-system/lib/column-registry";
import { queryGridDataRows } from "@repo/design-system/lib/grid-table-v2-row-drag";
import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  GRID_TABLE_V2_NUMBER_CELL_ALIGN_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "../../../../shared/lib/feature-flags";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListGridV2 } from "../sessions-list-grid-v2";
import { emptySessionsGridSelection } from "./sessions-selection.test-helpers";
import { renderWithFlags } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({ id: "ses-1", name: "agent/one" }),
  createSessionTableRowFixture({ id: "ses-2", name: "agent/two" }),
  createSessionTableRowFixture({ id: "ses-3", name: "agent/three" }),
];

const COLUMNS: readonly GridTableV2Column[] = [
  { id: "actions", label: "Actions" },
];

const ROW_HEIGHT_PX = 44;

/**
 * ISS-9821's fixture: ONE numeric column asking for the leading edge, rendered
 * through the canonical primitive. A hand-built array like every production v2
 * host's, so an absent `align` on the sibling columns stays the untouched case.
 */
const START_ALIGNED_NUMBER_COLUMNS: readonly GridTableV2Column[] = [
  { id: "actions", label: "Actions", align: ColumnAlignment.Start },
];
const NUMBER_CELL_TEXT = "12";
/** The margin `TableNumberCell` pushes itself right with. Written out, not imported. */
const AUTO_MARGIN_CLASS = "ml-auto";

function renderGrid({
  columns = COLUMNS,
  enabledFlags,
  hasSelectionModel = true,
  groups,
  mode = "expanded",
  onRowSelection = () => undefined,
  renderCell = () => null,
}: {
  columns?: readonly GridTableV2Column[];
  enabledFlags: readonly string[];
  hasSelectionModel?: boolean;
  groups?: readonly GridTableV2Group<SessionTableRow>[];
  mode?: GridTableV2Mode;
  onRowSelection?: (row: SessionTableRow, event: unknown) => void;
  renderCell?: (columnId: string, row: SessionTableRow) => ReactNode;
}) {
  stubContainerWidthPx(1400);
  return renderWithFlags(
    <SessionsListGridV2
      cardCompatibility={{ render: (row) => <span>{row.name}</span> }}
      columnOrder={columns.map((column) => column.id)}
      columns={columns}
      columnWidths={{ actions: 160 }}
      gridTemplateColumns="240px 160px"
      groups={groups}
      headerActions={{
        getFilterContent: () => null,
        onGroup: () => undefined,
      }}
      items={ROWS}
      leadingColumnWidth={240}
      mode={mode}
      onColumnWidthChange={() => undefined}
      onLeadingColumnWidthChange={() => undefined}
      onSort={() => undefined}
      renderCell={renderCell}
      renderLead={(row) => <span>{row.name}</span>}
      selection={
        hasSelectionModel
          ? {
              ...emptySessionsGridSelection(onRowSelection),
            }
          : undefined
      }
      showGroupCounts={false}
      sortBy={null}
      sortDir="asc"
    />,
    [...enabledFlags]
  );
}

function columnHeaders(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[role='columnheader']")
  );
}

function selectableRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-grid-selectable-row]")
  );
}

/** The grid's DATA rows — the same chrome filter {@link stubRowGeometry} uses. */
function dataRows(): HTMLElement[] {
  return queryGridDataRows(document);
}

/**
 * jsdom lays nothing out, and the drag resolves the row under the pointer.
 *
 * DATA rows only. ISS-10245 made `navigableHeaderCells` unconditional, so the
 * chrome header row matches `[data-grid-row][data-grid-row-id]` too — and as
 * `rows[0]` it swallowed the press, leaving the drag with no range to report.
 */
function stubRowGeometry(): HTMLElement[] {
  const rows = queryGridDataRows(document);
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () =>
      ({
        bottom: (index + 1) * ROW_HEIGHT_PX,
        height: ROW_HEIGHT_PX,
        left: 0,
        right: 400,
        top: index * ROW_HEIGHT_PX,
        width: 400,
        x: 0,
        y: index * ROW_HEIGHT_PX,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return rows;
}

/** The one `TableNumberCell` figure the alignment fixture paints. */
function numberFigure(): HTMLElement {
  const figure = document.querySelector<HTMLElement>(
    "[role='gridcell'][data-column-id='actions'] span"
  );
  if (!figure) {
    throw new Error("no number cell rendered");
  }
  return figure;
}

function gridBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>("[data-grid-body]");
  if (!body) {
    throw new Error("no grid body rendered");
  }
  body.setPointerCapture = () => undefined;
  body.releasePointerCapture = () => undefined;
  body.hasPointerCapture = () => false;
  return body;
}

describe("SessionsListGridV2 forwards the grid gates", () => {
  it.each(["expanded", "compact"] as const)(
    "omits header select-all in %s mode while row selection is live",
    (mode) => {
      renderGrid({
        enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        mode,
      });
      expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
    }
  );

  it("keeps the captured-main Session cards while the responsive rollout is off", () => {
    renderGrid({ enabledFlags: [], mode: "compact" });

    expect(document.querySelector("[data-grid-card-id]")).not.toBeNull();
    expect(document.querySelector("[role='grid']")).toBeNull();
  });

  it("omits the unavailable Tags dash from the adopted narrow identity row", () => {
    renderGrid({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      mode: "compact",
    });

    expect(dataRows()).toHaveLength(ROWS.length);
    expect(dataRows()[0]).not.toHaveTextContent("—");
  });

  it("mounts the pointer contract only when its rollout key is on", () => {
    const closed = renderGrid({ enabledFlags: [] });
    expect(
      document.querySelector("[data-grid-interaction-contract]")
    ).toBeNull();
    closed.unmount();

    renderGrid({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });
    expect(
      document.querySelector('[data-grid-interaction-contract="pointer-hover"]')
    ).not.toBeNull();
  });

  // BEHAVIOR CHANGE (ISS-10245): the two gated cases this file opened with —
  // "headers navigable only when ISS-8930's flag is on" and "rows draggable
  // only when ISS-8747's flag is on" — asserted a CHOICE that no longer exists.
  // Both keys were retired ENABLED by operator ruling, so the surface now wires
  // both unconditionally and each case is re-stated here as that unconditional
  // contract rather than deleted: the forwarding is still what could break.
  it("makes the column headers navigable unconditionally", () => {
    renderGrid({ enabledFlags: [] });
    expect(columnHeaders().length).toBeGreaterThan(0);
    expect(
      columnHeaders().every((header) => header.hasAttribute("data-grid-cell"))
    ).toBe(true);
  });

  describe("selection capability (ISS-10528)", () => {
    /**
     * ISS-10528. The drag is the one of the three that resolves into a SELECTION,
     * so unlike the two above it is not unconditional: a host with no selection
     * model must not arm it. Both arms read the same locator, so neither can pass
     * on a selector that matches nothing.
     */
    it("marks rows draggable only where the host has a selection model", () => {
      const withModel = renderGrid({ enabledFlags: [] });
      expect(selectableRows()).toHaveLength(ROWS.length);
      withModel.unmount();

      renderGrid({ enabledFlags: [], hasSelectionModel: false });
      expect(selectableRows()).toHaveLength(0);
      // Anti-vacuity: EVERY data row was still painted, so the count above is the
      // gesture being withheld rather than nothing having rendered. Chrome-row
      // filtered, because the header carries `[data-grid-row]` too since ISS-8930
      // and an unfiltered count is true of a body with no rows at all.
      expect(dataRows()).toHaveLength(ROWS.length);
    });
  });

  /**
   * ISS-9821. The design-system cases drive `alignValuesToColumn` as a literal
   * prop, so they prove what `GridTableV2` does and never that this host reads
   * the key and forwards it — replace `useGridValueAlignment()` with `false`
   * and every one of them stays green. The ledger row is a static source scan
   * and only asks whether the prop NAME is written, not what steers it.
   */
  it("lets a column's leading alignment move the figure only when ISS-9821's flag is on", () => {
    const closed = renderGrid({
      columns: START_ALIGNED_NUMBER_COLUMNS,
      enabledFlags: [],
      renderCell: () => <TableNumberCell value={NUMBER_CELL_TEXT} />,
    });
    expect(numberFigure().classList.contains(AUTO_MARGIN_CLASS)).toBe(true);
    closed.unmount();

    renderGrid({
      columns: START_ALIGNED_NUMBER_COLUMNS,
      enabledFlags: [GRID_TABLE_V2_NUMBER_CELL_ALIGN_FEATURE_FLAG_KEY],
      renderCell: () => <TableNumberCell value={NUMBER_CELL_TEXT} />,
    });
    expect(numberFigure().classList.contains(AUTO_MARGIN_CLASS)).toBe(false);
  });

  it("keeps grouped compatibility cards under both status flag states", () => {
    const closed = renderGrid({
      enabledFlags: [],
      groups: [{ items: [ROWS[0]], key: "active", label: "Active" }],
      mode: "compact",
    });
    expect(screen.getByText("Active")).toBeVisible();
    expect(document.querySelector("[data-grid-card-id]")).not.toBeNull();
    closed.unmount();

    renderGrid({
      enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      groups: [{ items: [ROWS[0]], key: "running", label: "Running" }],
      mode: "compact",
    });
    expect(screen.getAllByText("Running")).toHaveLength(1);
    expect(document.querySelector("[data-grid-card-id]")).not.toBeNull();
  });

  describe("drag routing (ISS-8747)", () => {
    it("routes a drag's extend through the host's own selection handler", () => {
      const activations: { id: string; shiftKey: boolean }[] = [];
      renderGrid({
        enabledFlags: [],
        onRowSelection: (row, event) => {
          activations.push({
            id: row.id,
            shiftKey: (event as { shiftKey: boolean }).shiftKey,
          });
        },
      });
      const rows = stubRowGeometry();
      const body = gridBody();

      fireEvent.pointerDown(rows[0] as HTMLElement, {
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerMove(body, {
        clientY: 2 * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2,
        pointerId: 1,
      });
      fireEvent.pointerUp(body, { pointerId: 1 });

      // The press row unmodified (the anchor), then the crossed row carrying
      // `shiftKey` — the same chord a Shift-click sends, which is what puts both
      // through one `resolveGridRowSelection`.
      expect(activations).toEqual([
        { id: "ses-1", shiftKey: false },
        { id: "ses-3", shiftKey: true },
      ]);
    });
  });
});

/**
 * ISS-12288 — the windowed body, which only this file can prove ships.
 *
 * `packages/design-system/__tests__/grid-table-v2-virtualized-rows.test.tsx`
 * proves what the primitive DOES with the window open; delete the one prop here
 * and every one of those cases stays green while the Sessions list goes back to
 * committing all 500 rows.
 *
 * Both arms run on the SAME fixture and the same stubbed scroller, because a
 * case that only counted rows would pass equally against a grid that had simply
 * rendered fewer: the grouped arm is the control, and it is also the shape the
 * primitive is documented to decline.
 */
describe("SessionsListGridV2 windowed body", () => {
  const WINDOWED_ROWS: readonly SessionTableRow[] = Array.from(
    { length: 120 },
    (_, index) =>
      createSessionTableRowFixture({
        id: `ses-win-${index}`,
        name: `agent/win-${index}`,
      })
  );
  const SCROLLER_HEIGHT_PX = 440;

  /**
   * A scroll container with the geometry jsdom does not lay out. The grid finds
   * its own scroller, so this element being the nearest one with a scrolling
   * `overflow-y` is what puts the production path under test.
   */
  function renderInScroller(
    groups?: readonly GridTableV2Group<SessionTableRow>[]
  ): HTMLElement {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: SCROLLER_HEIGHT_PX,
    });
    document.body.append(scroller);
    stubContainerWidthPx(1400);
    renderWithFlags(
      <SessionsListGridV2
        columnOrder={COLUMNS.map((column) => column.id)}
        columns={COLUMNS}
        columnWidths={{ actions: 160 }}
        gridTemplateColumns="240px 160px"
        groups={groups}
        headerActions={{
          getFilterContent: () => null,
          onGroup: () => undefined,
        }}
        items={groups ? [] : WINDOWED_ROWS}
        leadingColumnWidth={240}
        mode="expanded"
        onColumnWidthChange={() => undefined}
        onLeadingColumnWidthChange={() => undefined}
        onSort={() => undefined}
        renderCell={() => null}
        renderLead={(row) => <span>{row.name}</span>}
        selection={emptySessionsGridSelection()}
        showGroupCounts={false}
        sortBy={null}
        sortDir="asc"
      />,
      [],
      scroller
    );
    return scroller;
  }

  it("commits only the rows the scroller can show", () => {
    renderInScroller();

    expect(dataRows().length).toBeGreaterThan(0);
    expect(dataRows().length).toBeLessThan(WINDOWED_ROWS.length);
  });

  it("commits every row of a grouped body, which the window declines", () => {
    renderInScroller([
      { items: [...WINDOWED_ROWS], key: "band", label: "Band" },
    ]);

    expect(dataRows()).toHaveLength(WINDOWED_ROWS.length);
  });
});
