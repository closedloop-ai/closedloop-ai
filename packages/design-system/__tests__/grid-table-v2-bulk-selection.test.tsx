import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { useGridRowSelection } from "@closedloop-ai/design-system/hooks/use-grid-row-selection";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROWS = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
];
const MODIFIERS = { ctrlKey: false, metaKey: false, shiftKey: false };

afterEach(cleanup);

describe("shared list selection", () => {
  it("uses rendered range order and reconciles against the visible rows", () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useGridRowSelection({ visibleRowIds: ids }),
      { initialProps: { ids: ROWS.map((row) => row.id) } }
    );
    act(() =>
      result.current.onRowSelection(ROWS[1], MODIFIERS, [
        ROWS[1],
        ROWS[0],
        ROWS[2],
      ])
    );
    act(() =>
      result.current.onRowSelection(ROWS[0], { ...MODIFIERS, shiftKey: true }, [
        ROWS[1],
        ROWS[0],
        ROWS[2],
      ])
    );
    expect([...result.current.selectedIds]).toEqual(["b", "a"]);
    act(() => result.current.toggleRowSelection(ROWS[2]));
    expect([...result.current.selectedIds]).toEqual(["b", "a", "c"]);
    rerender({ ids: ["c"] });
    expect([...result.current.selectedIds]).toEqual(["c"]);
  });

  it("routes controlled writes without changing the caller's selected set", () => {
    const onChange = vi.fn();
    const selectedIds = new Set(["a"]);
    const { result } = renderHook(() =>
      useGridRowSelection({
        controller: { selectedIds, onChange },
        visibleRowIds: ["a", "b"],
      })
    );
    act(() => result.current.toggleRowSelection(ROWS[1]));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(new Set(["a", "b"]));
    expect([...selectedIds]).toEqual(["a"]);
  });
});

describe("opt-in selection presentation", () => {
  it("exposes multiselect and routes keyboard toggle/select-all through the production grid", () => {
    const { container } = render(<List />);
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    const cell = container.querySelector<HTMLElement>(
      '[data-grid-row-id="a"] [data-grid-cell]'
    );
    if (!cell) {
      throw new Error("Missing identity cell");
    }
    fireEvent.focus(cell);
    fireEvent.keyDown(cell, { key: " " });
    expect(container.querySelector('[data-grid-row-id="a"]')).toHaveAttribute(
      "aria-selected",
      "true"
    );
    fireEvent.keyDown(cell, { key: "a", ctrlKey: true });
    for (const row of ROWS) {
      expect(
        container.querySelector(`[data-grid-row-id="${row.id}"]`)
      ).toHaveAttribute("aria-selected", "true");
    }
  });

  it("marks opted-in narrow rows, selects only their own activation, and preserves nested controls", () => {
    render(<List compact />);
    const alpha = row("Alpha");
    const identity = alpha.querySelector<HTMLElement>("[data-grid-cell]");
    if (!identity) {
      throw new Error("Missing Alpha identity cell");
    }
    fireEvent.keyDown(identity, { key: " " });
    expect(alpha).toHaveAttribute("aria-selected", "true");
    const button = screen.getByRole("button", { name: "Action Alpha" });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(alpha).toHaveAttribute("aria-selected", "true");
    fireEvent.click(alpha, { ctrlKey: true });
    expect(alpha).toHaveAttribute("aria-selected", "false");
  });

  it.each([false, true])(
    "leaves consumers without selection controls nonselectable (compact=%s)",
    (compact) => {
      const { container } = render(
        <List compact={compact} selectable={false} />
      );
      expect(container.querySelector("[aria-multiselectable]")).toBeNull();
      expect(container.querySelector("[aria-selected]")).toBeNull();
      if (compact) {
        for (const item of ROWS) {
          const renderedRow = container.querySelector(
            `[data-grid-row-id="${item.id}"]`
          );
          expect(renderedRow).not.toBeNull();
          expect(renderedRow).not.toHaveAttribute("aria-selected");
          expect(renderedRow).not.toHaveAttribute("tabindex");
        }
      }
    }
  );
});

describe("touch narrow-row selection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the row's ordinary selection action from a touch tap on an empty selection", () => {
    render(<List compact />);
    tap("Alpha");
    expect(selectedRows()).toEqual(["a"]);
  });

  it("toggles rows with touch taps once a selection exists, and empties on the last deselect", () => {
    render(<List compact />);
    tap("Alpha");
    tap("Beta");
    expect(selectedRows()).toEqual(["a", "b"]);
    tap("Alpha");
    expect(selectedRows()).toEqual(["b"]);
    tap("Beta");
    expect(selectedRows()).toEqual([]);
  });

  it("toggles on a tap whose click reports a mouse pointer, as iOS Safari's does", () => {
    render(<List compact />);
    for (const name of ["Alpha", "Beta"]) {
      const target = row(name);
      fireEvent.pointerDown(target, { pointerType: "touch" });
      fireEvent.pointerUp(target, { pointerType: "touch" });
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(click, "pointerType", { value: "mouse" });
      fireEvent(target, click);
    }
    expect(selectedRows()).toEqual(["a", "b"]);
  });

  it("toggles a row on a touch long-press and ignores the click that ends it", () => {
    vi.useFakeTimers();
    render(<List compact />);
    tap("Alpha");
    const beta = row("Beta");
    fireEvent.pointerDown(beta, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(selectedRows()).toEqual(["a", "b"]);
    fireEvent.click(beta);
    expect(selectedRows()).toEqual(["a", "b"]);
  });

  it("cancels a long-press that travels like a scroll", () => {
    vi.useFakeTimers();
    render(<List compact />);
    const alpha = row("Alpha");
    fireEvent.pointerDown(alpha, {
      clientX: 0,
      clientY: 0,
      pointerType: "touch",
    });
    fireEvent.pointerMove(alpha, { clientX: 0, clientY: 40 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(selectedRows()).toEqual([]);
  });

  it("keeps the browser menu off a touch long-press", () => {
    render(<List compact />);
    const alpha = row("Alpha");
    fireEvent.pointerDown(alpha, { pointerType: "touch" });
    expect(fireEvent.contextMenu(alpha)).toBe(false);
  });

  it.each(["mouse", "pen"])(
    "keeps %s clicks on replace, Ctrl toggle and Shift range",
    (pointerType) => {
      render(<List compact />);
      press("Alpha", pointerType);
      press("Beta", pointerType);
      expect(selectedRows()).toEqual(["b"]);
      press("Alpha", pointerType, { ctrlKey: true });
      expect(selectedRows()).toEqual(["a", "b"]);
      press("Gamma", pointerType, { shiftKey: true });
      expect(selectedRows()).toEqual(["a", "b", "c"]);
      fireEvent.pointerDown(row("Alpha"), { pointerType });
      expect(fireEvent.contextMenu(row("Alpha"))).toBe(true);
    }
  );

  it("leaves a nested control's own tap and long-press alone", () => {
    vi.useFakeTimers();
    render(<List compact />);
    const button = screen.getByRole("button", { name: "Action Alpha" });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    fireEvent.click(button);
    expect(selectedRows()).toEqual([]);
  });
});

/** Mirrors the narrow row's own long-press threshold. */
const LONG_PRESS_MS = 500;

function row(name: string): HTMLElement {
  const item = ROWS.find((candidate) => candidate.name === name);
  const element = item
    ? document.querySelector<HTMLElement>(`[data-grid-row-id="${item.id}"]`)
    : null;
  if (!element) {
    throw new Error(`Missing narrow row ${name}`);
  }
  return element;
}

function tap(name: string) {
  press(name, "touch");
}

function press(
  name: string,
  pointerType: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}
) {
  const target = row(name);
  fireEvent.pointerDown(target, { pointerType, ...modifiers });
  fireEvent.pointerUp(target, { pointerType, ...modifiers });
  fireEvent.click(target, modifiers);
}

function selectedRows(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-grid-row-id]")]
    .filter((element) => element.getAttribute("aria-selected") === "true")
    .map((element) => element.dataset.gridRowId ?? "");
}

function List({
  compact = false,
  selectable = true,
}: {
  compact?: boolean;
  selectable?: boolean;
}) {
  const selection = useGridRowSelection<(typeof ROWS)[number]>({
    visibleRowIds: ROWS.map((row) => row.id),
  });
  return (
    <GridTableV2
      columns={[]}
      getRowId={(row) => row.id}
      gridTemplateColumns="minmax(200px, 1fr)"
      isRowSelected={
        selectable ? (row) => selection.selectedIds.has(row.id) : undefined
      }
      items={ROWS}
      leadingLabel="Name"
      mode={compact ? "compact" : "expanded"}
      onRowClick={
        selectable
          ? (row, event, rows) => selection.onRowSelection(row, event, rows)
          : undefined
      }
      onRowKeyboardNavigate={
        selectable
          ? (row, event, rows) => selection.onRowSelection(row, event, rows)
          : undefined
      }
      onRowSelectionToggle={
        selectable ? selection.toggleRowSelection : undefined
      }
      onSelectAllRows={selectable ? selection.selectAllRows : undefined}
      renderCell={() => null}
      renderLead={(row) => (
        <div>
          <span>{row.name}</span>
          <button aria-label={`Action ${row.name}`} type="button" />
        </div>
      )}
    />
  );
}
