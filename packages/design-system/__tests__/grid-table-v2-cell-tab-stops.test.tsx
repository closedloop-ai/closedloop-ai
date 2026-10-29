/**
 * ISS-8726 — `GridTableV2` as ONE tab stop, and the entry path that has to keep
 * every suppressed control reachable.
 *
 * Suppressing a tab stop is the change that can strand a control, so these
 * cases are written in pairs: whatever the gate takes out of the tab order, a
 * sibling case proves is still reachable through the cell-entry model. The
 * whole-tab-order proof (real `Tab` presses through the rendered grid) lives in
 * `packages/app/agents/components/sessions/__tests__/sessions-list-grid-v2-tab-stops.test.tsx`,
 * where `@testing-library/user-event` is available; this file owns the DOM
 * contract underneath it.
 *
 * The flag-OFF arm is asserted on the same fixture in every case, not as a
 * separate smoke test, so a case that would pass with the gate closed cannot
 * masquerade as proof of the gate.
 */

import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE } from "@closedloop-ai/design-system/lib/grid-cell-tab-stops";
import { gridCellOf as cellOf } from "@closedloop-ai/design-system/test/grid-roving-tab-stop";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "row-0", name: "Alpha" },
  { id: "row-1", name: "Bravo" },
];

const COLUMNS = [{ id: "actions", label: "Actions" }];

/**
 * One control in each of the three cell kinds the grid renders through
 * different code paths — the leading utility cell and the lead cell are inline
 * in `GridTableV2`, a data cell goes through `GridTableV2Cell`. A gate applied
 * to only one of them leaves the others leaking, so the fixture has to be able
 * to tell them apart.
 */
function renderGrid(suppressCellTabStops: boolean) {
  return render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns="36px 200px 120px"
      items={ROWS}
      leadingLabel="Name"
      renderCell={(_columnId, row) => (
        <button type="button">{`Run ${row.name}`}</button>
      )}
      renderLead={(row) => <a href={`/sessions/${row.id}`}>{row.name}</a>}
      renderLeadingUtility={(row) => (
        <button type="button">{`Favorite ${row.name}`}</button>
      )}
      suppressCellTabStops={suppressCellTabStops}
    />
  );
}

/** The three controls of the first row, in visible order. */
function firstRowControls(): HTMLElement[] {
  return [
    screen.getByRole("button", { name: "Favorite Alpha" }),
    screen.getByRole("link", { name: "Alpha" }),
    screen.getByRole("button", { name: "Run Alpha" }),
  ];
}

/** Real DOM focus — `fireEvent.focus` dispatches without moving focus. */
function focusElement(element: HTMLElement): void {
  act(() => element.focus());
}

describe("GridTableV2 cell tab-stop suppression", () => {
  it("takes every cell control out of the tab order, in every cell kind", () => {
    renderGrid(true);

    expect(firstRowControls().map((control) => control.tabIndex)).toEqual([
      -1, -1, -1,
    ]);
  });

  it("leaves every cell control in the tab order when the gate is closed", () => {
    renderGrid(false);

    expect(firstRowControls().map((control) => control.tabIndex)).toEqual([
      0, 0, 0,
    ]);
    expect(
      document.querySelectorAll(`[${GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE}]`)
    ).toHaveLength(0);
  });

  it("keeps the roving cell itself in the tab order", () => {
    renderGrid(true);

    // The cell carries the grid's only tab stop. Suppressing it — it matches
    // the same focusable selector its contents do — would take the whole grid
    // out of the tab order instead of putting one control back into it.
    const [favorite] = firstRowControls();
    expect(cellOf(favorite).tabIndex).toBe(0);
  });

  it("still enters a suppressed cell on Enter, and returns on Escape", () => {
    renderGrid(true);
    const link = screen.getByRole("link", { name: "Alpha" });
    const cell = cellOf(link);
    focusElement(cell);

    fireEvent.keyDown(cell, { key: "Enter" });
    expect(link).toHaveFocus();

    fireEvent.keyDown(link, { key: "Escape" });
    expect(cell).toHaveFocus();
  });

  it("still enters a suppressed cell on F2, and returns on F2", () => {
    renderGrid(true);
    const run = screen.getByRole("button", { name: "Run Alpha" });
    const cell = cellOf(run);
    focusElement(cell);

    fireEvent.keyDown(cell, { key: "F2" });
    expect(run).toHaveFocus();

    fireEvent.keyDown(run, { key: "F2" });
    expect(cell).toHaveFocus();
  });

  it("hands an entered cell's controls their tab stops back, and takes them again on exit", () => {
    renderGrid(true);
    const link = screen.getByRole("link", { name: "Alpha" });
    const cell = cellOf(link);
    focusElement(cell);

    // Entry lands on ONE control; a cell may hold several. Pinning the rest at
    // -1 while the user is inside would leave them with no keyboard route at
    // all, so the cell's content is released for as long as it holds focus.
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(link.tabIndex).toBe(0);

    fireEvent.keyDown(link, { key: "Escape" });
    expect(link.tabIndex).toBe(-1);
  });

  it("still enters a control that was focusable only through tabindex", () => {
    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        renderCell={(_columnId, row) => (
          <div
            aria-label={`Weight ${row.name}`}
            aria-valuemax={10}
            aria-valuemin={0}
            aria-valuenow={5}
            role="slider"
            tabIndex={0}
          />
        )}
        renderLead={(row) => <span>{row.name}</span>}
        suppressCellTabStops
      />
    );
    const slider = screen.getByRole("slider", { name: "Weight Alpha" });
    const cell = cellOf(slider);
    focusElement(cell);

    // A `button` still matches the entry selector's own TAG clause at
    // `tabindex="-1"`; a custom role matched ONLY by `[tabindex]` would vanish
    // from it the instant it was suppressed, and Enter would land on nothing —
    // the WCAG 2.1.1 dead end this gate must not create.
    fireEvent.keyDown(cell, { key: "Enter" });

    expect(slider).toHaveFocus();
  });

  it("suppresses a control that mounts after the grid did", async () => {
    function LateControlGrid() {
      const [revealed, setRevealed] = useState(false);
      return (
        <>
          <button onClick={() => setRevealed(true)} type="button">
            Reveal
          </button>
          <GridTableV2<Row>
            columns={COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns="200px 120px"
            items={ROWS}
            leadingLabel="Name"
            renderCell={(_columnId, row) =>
              revealed ? (
                <button type="button">{`Late ${row.name}`}</button>
              ) : null
            }
            renderLead={(row) => <span>{row.name}</span>}
            suppressCellTabStops
          />
        </>
      );
    }
    render(<LateControlGrid />);

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));

    // An inline editor swapping its trigger for a field, a create row appending
    // a row, a page replacing another: without the observer the first paint is
    // one tab stop and every later one leaks again. Awaited because a
    // `MutationObserver` delivers its records in a microtask, not synchronously.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Late Alpha" }).tabIndex).toBe(
        -1
      )
    );
  });

  it("suppresses a control that becomes focusable in place", async () => {
    function EnablingControlGrid() {
      const [enabled, setEnabled] = useState(false);
      return (
        <>
          <button onClick={() => setEnabled(true)} type="button">
            Enable
          </button>
          <GridTableV2<Row>
            columns={COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns="200px 120px"
            items={ROWS}
            leadingLabel="Name"
            renderCell={(_columnId, row) => (
              <button
                disabled={!enabled}
                type="button"
              >{`Star ${row.name}`}</button>
            )}
            renderLead={(row) => <span>{row.name}</span>}
            suppressCellTabStops
          />
        </>
      );
    }
    render(<EnablingControlGrid />);
    // Disabled at first paint, so the entry selector deliberately did not match
    // it and nothing was suppressed.
    expect(screen.getByRole("button", { name: "Star Alpha" }).tabIndex).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));

    // React clears `disabled` on the SAME node, so no child is inserted and a
    // childList-only observer never sees the moment this control started being
    // a tab stop — the grid would quietly have two.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Star Alpha" }).tabIndex).toBe(
        -1
      )
    );
  });

  it("hands back the tab stop the caller last rendered, not the one it first replaced", async () => {
    function RetabbingGrid({ suppress }: { suppress: boolean }) {
      const [tabIndex, setTabIndex] = useState<number | undefined>(undefined);
      return (
        <>
          <button onClick={() => setTabIndex(2)} type="button">
            Retab
          </button>
          <GridTableV2<Row>
            columns={COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns="200px 120px"
            items={ROWS}
            leadingLabel="Name"
            renderCell={(_columnId, row) => (
              <button
                tabIndex={tabIndex}
                type="button"
              >{`Star ${row.name}`}</button>
            )}
            renderLead={(row) => <span>{row.name}</span>}
            suppressCellTabStops={suppress}
          />
        </>
      );
    }
    const { rerender } = render(<RetabbingGrid suppress />);

    // The caller re-renders a NEW tabindex over the suppression. Restoring the
    // value recorded on the first pass would hand back the state before that
    // render and silently discard it.
    fireEvent.click(screen.getByRole("button", { name: "Retab" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Star Alpha" }).tabIndex).toBe(
        -1
      )
    );

    rerender(<RetabbingGrid suppress={false} />);

    expect(screen.getByRole("button", { name: "Star Alpha" }).tabIndex).toBe(2);
  });

  it("gives every control its tab stop back when the gate closes", () => {
    const { rerender } = renderGrid(true);
    expect(firstRowControls().map((control) => control.tabIndex)).toEqual([
      -1, -1, -1,
    ]);

    rerender(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="36px 200px 120px"
        items={ROWS}
        leadingLabel="Name"
        renderCell={(_columnId, row) => (
          <button type="button">{`Run ${row.name}`}</button>
        )}
        renderLead={(row) => <a href={`/sessions/${row.id}`}>{row.name}</a>}
        renderLeadingUtility={(row) => (
          <button type="button">{`Favorite ${row.name}`}</button>
        )}
        suppressCellTabStops={false}
      />
    );

    expect(firstRowControls().map((control) => control.tabIndex)).toEqual([
      0, 0, 0,
    ]);
    expect(
      document.querySelectorAll(`[${GRID_SUPPRESSED_TAB_STOP_ATTRIBUTE}]`)
    ).toHaveLength(0);
  });
});
