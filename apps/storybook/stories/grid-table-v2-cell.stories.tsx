// biome-ignore-all lint/a11y/useFocusableInteractive: in the APG grid pattern the roving tab stop is on the CELL, never the row — giving each `row` a tabindex would add a second tab stop and break the model this story exists to exercise.
// biome-ignore-all lint/a11y/useSemanticElements: a CSS-grid table cannot be a real <table>; `role="grid"` is the mapping `GridTableV2` itself renders.
/**
 * The champion grid's data cell — ISS-9290.
 *
 * The harness is a real `grid` / `data-grid-body` / `data-grid-row` ancestry
 * rather than a bare mount, because every contract this cell carries is
 * resolved by walking UP from the focused cell: `handleGridCellKeyDown` finds
 * the row through `[data-grid-row]` and the row set through `[data-grid-body]`.
 * Mounted alone the cell swallows nothing and moves nothing, so a story without
 * that ancestry would picture an inert div rather than the cell.
 *
 * Applicable states: default, focus-visible (the focus half; the ring itself is
 * Chromatic's), keyboard interaction, read-only (the no-selection-keys
 * variant), and overflow. Not applicable: selected, editing, dragging,
 * drag-over, loading, empty, partial, error, disabled, permission and narrow
 * all belong to layers above this one — selection is published on the ROW, the
 * editors are a separate cell-content layer, and the narrow projection is
 * demonstrated on the composed Grid Table Grouped Sections entry.
 */
import { GridTableV2Cell } from "@repo/design-system/components/ui/grid-table-v2-cell";
import {
  TableChoiceCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fireEvent, within } from "storybook/test";
import { rowCell, selectedRowIds } from "./grid-table-v2-play-helpers";

const meta = {
  title: "Primitives v1.0/Data Display/Tables/Grid Table V2 Cell",
  component: GridTableV2Cell,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableV2Cell>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Columns addressed by name, so a track reorder cannot silently repoint an assertion. */
const STATUS_COLUMN = "status";
const OWNER_COLUMN = "owner";

/** Generated rather than a named fixture, so no assertion depends on a row's content. */
const ROW_IDS = ["row-1", "row-2", "row-3"];

/**
 * One owner per row. Present so the `owner` column renders a PERSON through the
 * canonical person cell rather than echoing the row id — a story is what a
 * builder copies from, so a column must render the shape its name claims.
 */
const ROW_OWNERS: Record<string, string> = {
  "row-1": "Pascoe Birchall",
  "row-2": "Ottilie Eastwick",
  "row-3": "Dana Wu",
};

const GRID_LABEL = "Artifacts";

/**
 * Long enough to clip at any viewport the grid renders at. Built rather than
 * written out so the story states the LENGTH it needs, instead of a sentence a
 * later edit could quietly shorten past the point of overflowing.
 */
const OVERFLOWING_VALUE = "Reconciliation candidate ".repeat(8).trim();

export const Default: Story = {
  args: { columnId: STATUS_COLUMN },
  render: () => <CellGridStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = canvas.getByRole("grid", { name: GRID_LABEL });

    // The cell publishes the track it sits in, which is what pairs a body cell
    // with its column header for a screen reader.
    const status = rowCell(canvasElement, ROW_IDS[0], STATUS_COLUMN);
    await expect(status).toHaveAttribute("aria-colindex", "1");
    await expect(within(grid).getAllByRole("gridcell")).toHaveLength(
      ROW_IDS.length * 2
    );

    status.focus();
    await expect(status).toHaveFocus();

    // ArrowRight walks the row and reports the row it landed in.
    fireEvent.keyDown(status, { key: "ArrowRight" });
    await expect(
      rowCell(canvasElement, ROW_IDS[0], OWNER_COLUMN)
    ).toHaveFocus();
    await expect(lastNavigatedRowId(canvasElement)).toBe(ROW_IDS[0]);

    // ArrowDown crosses into the next row, so the walk is two-dimensional.
    fireEvent.keyDown(rowCell(canvasElement, ROW_IDS[0], OWNER_COLUMN), {
      key: "ArrowDown",
    });
    await expect(
      rowCell(canvasElement, ROW_IDS[1], OWNER_COLUMN)
    ).toHaveFocus();
    await expect(lastNavigatedRowId(canvasElement)).toBe(ROW_IDS[1]);

    // Space flips the focused ROW's selection and is claimed, so the page does
    // not scroll out from under a grid the user is selecting in.
    const owner = rowCell(canvasElement, ROW_IDS[1], OWNER_COLUMN);
    await expect(fireEvent.keyDown(owner, { key: " " })).toBe(false);
    await expect(selectedRowIds(canvasElement)).toEqual([ROW_IDS[1]]);

    // Ctrl+A is the grid pattern's own select-all, not the browser's.
    await expect(fireEvent.keyDown(owner, { key: "a", ctrlKey: true })).toBe(
      false
    );
    await expect(selectedRowIds(canvasElement)).toEqual(ROW_IDS);
  },
};

/**
 * The read-only half of the same cell. A caller rendering it OUTSIDE a
 * selectable grid passes no `selectionKeys`, and the documented contract is
 * that `Space` and `Ctrl/Cmd+A` keep their native meaning rather than being
 * silently swallowed.
 *
 * The negative sibling of `Default`'s two selection assertions: same keys, same
 * locator, opposite state. A cell that claimed those keys unconditionally would
 * pass `Default` and fail only here.
 */
export const WithoutSelectionKeys: Story = {
  args: { columnId: STATUS_COLUMN },
  render: () => <CellGridStory selectable={false} />,
  play: async ({ canvasElement }) => {
    const status = rowCell(canvasElement, ROW_IDS[0], STATUS_COLUMN);
    status.focus();

    // Neither key is claimed, so both reach the browser.
    await expect(fireEvent.keyDown(status, { key: " " })).toBe(true);
    await expect(fireEvent.keyDown(status, { key: "a", ctrlKey: true })).toBe(
      true
    );
    await expect(selectedRowIds(canvasElement)).toEqual([]);

    // Navigation is independent of selection: dropping the selection keys must
    // not cost the user the arrow walk as well.
    fireEvent.keyDown(status, { key: "ArrowRight" });
    await expect(
      rowCell(canvasElement, ROW_IDS[0], OWNER_COLUMN)
    ).toHaveFocus();
  },
};

/**
 * A value wider than its track. The cell clips it visually, and the assertion
 * is that it clips VISUALLY ONLY — the whole value stays in the DOM, so
 * assistive tech announces it and a copy reaches the clipboard intact.
 *
 * A behaviour rather than a class check, because the failure it guards is a
 * plausible fix: truncating the string in JS leaves the cell looking identical
 * and silently destroys the value.
 */
export const Overflow: Story = {
  args: { columnId: STATUS_COLUMN },
  render: () => <CellGridStory value={OVERFLOWING_VALUE} />,
  play: async ({ canvasElement }) => {
    await expect(
      rowCell(canvasElement, ROW_IDS[0], STATUS_COLUMN)
    ).toHaveTextContent(OVERFLOWING_VALUE);
  },
};

/** The row the last keyboard move reported, surfaced by the harness for the play. */
function lastNavigatedRowId(canvasElement: HTMLElement): string {
  return (
    canvasElement.querySelector<HTMLElement>("[data-navigated-row-id]")?.dataset
      .navigatedRowId ?? ""
  );
}

function CellGridStory({
  selectable = true,
  value = "Active",
}: {
  selectable?: boolean;
  value?: string;
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [navigatedRowId, setNavigatedRowId] = useState("");

  const selectionKeys = selectable
    ? {
        onSelectAllRows: () => setSelected(ROW_IDS),
        onToggleRowSelection: (rowId: string) =>
          setSelected((previous) =>
            previous.includes(rowId)
              ? previous.filter((id) => id !== rowId)
              : [...previous, rowId]
          ),
      }
    : undefined;

  return (
    <main className="min-h-screen bg-background p-8">
      <div
        className="w-full max-w-2xl overflow-hidden rounded-md border"
        data-navigated-row-id={navigatedRowId}
      >
        <div
          aria-colcount={2}
          aria-label={GRID_LABEL}
          data-grid-body
          role="grid"
        >
          {ROW_IDS.map((rowId) => (
            <div
              aria-selected={selected.includes(rowId)}
              className="grid grid-cols-2 border-b last:border-b-0"
              data-grid-row
              data-grid-row-id={rowId}
              key={rowId}
              role="row"
            >
              <GridTableV2Cell
                cellRole="gridcell"
                colIndex={1}
                columnId={STATUS_COLUMN}
                data-grid-cell
                onKeyboardNavigate={setNavigatedRowId}
                selectionKeys={selectionKeys}
                tabIndex={-1}
              >
                <TableChoiceCell label={value} />
              </GridTableV2Cell>
              <GridTableV2Cell
                cellRole="gridcell"
                colIndex={2}
                columnId={OWNER_COLUMN}
                data-grid-cell
                onKeyboardNavigate={setNavigatedRowId}
                selectionKeys={selectionKeys}
                tabIndex={-1}
              >
                <TablePersonCell person={{ name: ROW_OWNERS[rowId] }} />
              </GridTableV2Cell>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
