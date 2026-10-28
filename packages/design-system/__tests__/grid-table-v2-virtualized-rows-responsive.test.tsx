import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import { GRID_TABLE_V2_NARROW_TEMPLATE } from "@closedloop-ai/design-system/lib/grid-table-v2-responsive";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string };

const ROW_COUNT = 500;
const VIEWPORT_HEIGHT_PX = 440;
const ROWS: Row[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
  id: `row-${index}`,
  name: `Row ${index}`,
}));
const COLUMNS = [{ id: "status", label: "Status" }];
const WIDE_TEMPLATE = "200px 120px";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mountScroller(): HTMLDivElement {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: VIEWPORT_HEIGHT_PX,
  });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    value: 0,
    writable: true,
  });
  document.body.append(scroller);
  return scroller;
}

function renderResponsiveGrid() {
  const viewport = stubNarrowViewport(false);
  const scroller = mountScroller();
  const view = render(
    <GridTableV2<Row>
      columns={COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={WIDE_TEMPLATE}
      items={ROWS}
      leadingLabel="Artifact"
      mode="auto"
      renderCell={() => "Active"}
      renderLead={(row) => <span>{row.name}</span>}
      virtualizeRows
    />,
    { container: scroller }
  );
  return { scroller, view, viewport };
}

function gridBody(scroller: HTMLElement): HTMLElement {
  const body = scroller.querySelector<HTMLElement>("[data-grid-body]");
  if (!body) {
    throw new Error("Expected the shared grid body to remain mounted");
  }
  return body;
}

function paintedRowCount(scroller: HTMLElement): number {
  return scroller.querySelectorAll("[data-grid-row][data-grid-row-id]").length;
}

describe("[DT-03][DT-05] GridTableV2 virtualization across responsive projection", () => {
  it("keeps the same windowed body while narrowing and widening", () => {
    const { scroller, viewport } = renderResponsiveGrid();
    const initialBody = gridBody(scroller);
    const focusedCell = scroller.querySelector<HTMLElement>(
      '[data-grid-row-id="row-0"] [role="gridcell"]'
    );
    if (!focusedCell) {
      throw new Error("Missing first row cell");
    }
    act(() => {
      focusedCell.focus();
    });
    expect(document.activeElement).toBe(focusedCell);
    expect(paintedRowCount(scroller)).toBeGreaterThan(0);
    expect(paintedRowCount(scroller)).toBeLessThan(ROW_COUNT);
    expect(initialBody).toHaveClass("min-w-fit");

    viewport.setNarrow(true);

    expect(gridBody(scroller)).toBe(initialBody);
    expect(gridBody(scroller)).toHaveClass("min-w-0");
    expect(scroller.querySelector("[data-grid-row-id]")).toHaveStyle({
      gridTemplateColumns: GRID_TABLE_V2_NARROW_TEMPLATE,
    });
    expect(paintedRowCount(scroller)).toBeLessThan(ROW_COUNT);
    expect(document.activeElement).toBe(focusedCell);

    viewport.setNarrow(false);

    expect(gridBody(scroller)).toBe(initialBody);
    expect(gridBody(scroller)).toHaveClass("min-w-fit");
    expect(paintedRowCount(scroller)).toBeLessThan(ROW_COUNT);
    expect(document.activeElement).toBe(focusedCell);
  });

  it("windows the narrow list on its first paint", () => {
    const scroller = mountScroller();
    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={WIDE_TEMPLATE}
        items={ROWS}
        leadingLabel="Artifact"
        mode="compact"
        renderCell={() => "Active"}
        renderLead={(row) => <span>{row.name}</span>}
        virtualizeRows
      />,
      { container: scroller }
    );

    expect(gridBody(scroller)).toHaveClass("min-w-0");
    expect(paintedRowCount(scroller)).toBeGreaterThan(0);
    expect(paintedRowCount(scroller)).toBeLessThan(ROW_COUNT);
  });
});

function stubNarrowViewport(initialMatches: boolean) {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let matches = initialMatches;
  const media: MediaQueryList = {
    addEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject
    ) => {
      listeners.add(listener);
    },
    addListener: () => undefined,
    dispatchEvent: (event) => {
      for (const listener of listeners) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
      return !event.defaultPrevented;
    },
    get matches() {
      return matches;
    },
    media: "(max-width: 767px)",
    onchange: null,
    removeEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject
    ) => {
      listeners.delete(listener);
    },
    removeListener: () => undefined,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media)
  );
  return {
    setNarrow(next: boolean) {
      matches = next;
      act(() => {
        media.dispatchEvent(new Event("change"));
      });
    },
  };
}
