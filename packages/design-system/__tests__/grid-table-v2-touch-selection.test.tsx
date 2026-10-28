import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];
const LONG_PRESS_MS = 500;

afterEach(() => {
  vi.useRealTimers();
});

function renderTouchGrid({
  isRowSelected = () => false,
  items = ROWS,
  mode = "compact",
  onControlClick,
  onRowClick = vi.fn(),
  onToggle = vi.fn(),
}: {
  isRowSelected?: (row: Row) => boolean;
  items?: Row[];
  mode?: "compact" | "expanded";
  onControlClick?: () => void;
  onRowClick?: (row: Row) => void;
  onToggle?: (row: Row) => void;
} = {}) {
  const grid = (nextItems: Row[], nextMode: "compact" | "expanded") => (
    <GridTableV2<Row>
      columns={[]}
      getRowId={(row) => row.id}
      gridTemplateColumns="minmax(12rem, 1fr)"
      isRowSelected={isRowSelected}
      items={nextItems}
      leadingLabel="Artifact"
      mode={nextMode}
      onRowClick={onRowClick}
      onRowSelectionToggle={onToggle}
      renderCell={() => null}
      renderLead={(row) => (
        <div>
          <span>{row.name}</span>
          {onControlClick && row.id === ROWS[0]?.id ? (
            <button onClick={onControlClick} type="button">
              Edit Alpha
            </button>
          ) : null}
        </div>
      )}
    />
  );
  const view = render(grid(items, mode));
  return {
    ...view,
    onRowClick,
    onToggle,
    rerenderGrid: (nextItems: Row[], nextMode: "compact" | "expanded" = mode) =>
      view.rerender(grid(nextItems, nextMode)),
  };
}

function row(rowId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"]`
  );
  if (!element) {
    throw new Error(`Missing grid row ${rowId}`);
  }
  return element;
}

function touchDown(target: HTMLElement, pointerId = 1) {
  fireEvent.pointerDown(target, {
    clientX: 4,
    clientY: 4,
    pointerId,
    pointerType: "touch",
  });
}

function touchUp(target: HTMLElement, pointerId = 1) {
  fireEvent.pointerUp(target, { pointerId, pointerType: "touch" });
}

describe("[DT-10][DT-11][DT-12] exactly-once touch selection", () => {
  it("long-press toggles once and suppresses the synthesized click", () => {
    vi.useFakeTimers();
    const { onRowClick, onToggle } = renderTouchGrid();
    const first = row("1");

    touchDown(first);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    touchUp(first);
    fireEvent.click(first);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(ROWS[0]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("a touch tap toggles once after any row is selected", () => {
    const { onRowClick, onToggle } = renderTouchGrid({
      isRowSelected: (item) => item.id === ROWS[0]?.id,
    });
    const second = row("2");

    touchDown(second);
    touchUp(second);
    fireEvent.click(second);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(ROWS[1]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("an ordinary touch tap activates exactly once before selection mode exists", () => {
    const { onRowClick, onToggle } = renderTouchGrid();
    const first = row("1");

    touchDown(first);
    touchUp(first);
    fireEvent.click(first);

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0], expect.anything(), ROWS);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("[DT-13] canceled touch cleanup", () => {
  it("movement beyond the tolerance cancels the timer and its following click", () => {
    vi.useFakeTimers();
    const { onRowClick, onToggle } = renderTouchGrid();
    const first = row("1");

    touchDown(first);
    fireEvent.pointerMove(first, {
      clientX: 20,
      clientY: 4,
      pointerId: 1,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    touchUp(first);
    fireEvent.click(first);

    expect(onToggle).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("pointer cancel clears the timer and suppresses its following click", () => {
    vi.useFakeTimers();
    const { onRowClick, onToggle } = renderTouchGrid();
    const first = row("1");

    touchDown(first);
    fireEvent.pointerCancel(first, {
      pointerId: 1,
      pointerType: "touch",
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.click(first);

    expect(onToggle).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("unmount clears an armed long-press timer", () => {
    vi.useFakeTimers();
    const { onToggle, unmount } = renderTouchGrid();

    touchDown(row("1"));
    unmount();
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("cancels an armed long press when compact selection is disabled", () => {
    vi.useFakeTimers();
    const { onToggle, rerenderGrid } = renderTouchGrid();

    touchDown(row("1"));
    rerenderGrid(ROWS, "expanded");
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("does not toggle a row removed before its long press fires", () => {
    vi.useFakeTimers();
    const { onToggle, rerenderGrid } = renderTouchGrid();

    touchDown(row("1"));
    rerenderGrid(ROWS.slice(1));
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("[DT-14] interactive descendant isolation", () => {
  it("keeps a nested control's own action and never selects or activates its row", () => {
    vi.useFakeTimers();
    const onControlClick = vi.fn();
    const { onRowClick, onToggle } = renderTouchGrid({ onControlClick });
    const control = within(row("1")).getByRole("button", {
      name: "Edit Alpha",
    });

    touchDown(control);
    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    control.dispatchEvent(contextMenu);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    touchUp(control);
    fireEvent.click(control);

    expect(onControlClick).toHaveBeenCalledTimes(1);
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
