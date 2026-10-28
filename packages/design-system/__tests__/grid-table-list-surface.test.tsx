import {
  GRID_TABLE_PAGINATION_BAND_TEST_ID,
  GridTableListSurface,
  type GridTableListSurfaceMode,
} from "@closedloop-ai/design-system/components/ui/grid-table-list-surface";
import { GridTableToolbar } from "@closedloop-ai/design-system/components/ui/grid-table-toolbar";
import { TableBulkActionBar } from "@closedloop-ai/design-system/components/ui/table-bulk-action-bar";
import { TablePagination } from "@closedloop-ai/design-system/components/ui/table-pagination-v2";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let viewportStub: ReturnType<typeof stubNarrowViewport> | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  viewportStub = undefined;
});

describe("GridTableListSurface viewport mode", () => {
  it("does not re-render slots for repeated viewport answers within one mode", () => {
    viewportStub = stubNarrowViewport(true);
    const toolbar = vi.fn((mode: GridTableListSurfaceMode) => (
      <span>{mode} toolbar</span>
    ));
    const table = vi.fn((mode: GridTableListSurfaceMode) => (
      <span>{mode} table</span>
    ));
    render(<GridTableListSurface table={table} toolbar={toolbar} />);

    const compactCalls = toolbar.mock.calls.length;
    expect(compactCalls).toBeGreaterThan(0);
    expect(table).toHaveBeenCalledTimes(compactCalls);
    viewportStub.setNarrow(true);
    expect(toolbar).toHaveBeenCalledTimes(compactCalls);
    expect(table).toHaveBeenCalledTimes(compactCalls);

    viewportStub.setNarrow(false);
    expect(toolbar).toHaveBeenCalledTimes(compactCalls + 1);
    expect(table).toHaveBeenCalledTimes(compactCalls + 1);
    viewportStub.setNarrow(false);
    expect(toolbar).toHaveBeenCalledTimes(compactCalls + 1);
    expect(table).toHaveBeenCalledTimes(compactCalls + 1);
  });

  it("gives toolbar and rows one narrow/wide viewport answer", () => {
    viewportStub = stubNarrowViewport(true);
    render(<ModeSurface />);

    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "compact rows" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();

    viewportStub.setNarrow(false);
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "expanded rows" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();

    viewportStub.setNarrow(true);
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "compact rows" })
    ).toBeInTheDocument();
  });

  it("keeps measured mode while the body is absent and restores rows in that mode", () => {
    viewportStub = stubNarrowViewport(true);
    const { rerender } = render(<ModeSurface showRows={false} />);
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "compact rows" })).toBeNull();

    viewportStub.setNarrow(false);
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
    rerender(<ModeSurface showRows />);
    expect(
      screen.getByRole("button", { name: "expanded rows" })
    ).toBeInTheDocument();
  });

  it("hands row focus to a host region, or to its root without a region", () => {
    viewportStub = stubNarrowViewport(true);
    const { rerender } = render(<ModeSurface />);
    screen.getByRole("button", { name: "compact rows" }).focus();
    viewportStub.setNarrow(false);
    expect(screen.getByRole("region", { name: "Rows" })).toHaveFocus();

    rerender(<ModeSurface focusableRegion={false} />);
    screen.getByRole("button", { name: "expanded rows" }).focus();
    viewportStub.setNarrow(true);
    expect(screen.getByTestId("surface-root").firstElementChild).toHaveFocus();
  });

  it("does not reclaim focus after a row genuinely blurs before the mode changes", async () => {
    viewportStub = stubNarrowViewport(true);
    render(<ModeSurface />);
    const row = screen.getByRole("button", { name: "compact rows" });
    row.focus();
    row.blur();
    fireEvent.blur(row, { relatedTarget: null });
    await act(async () => Promise.resolve());

    viewportStub.setNarrow(false);
    expect(screen.getByRole("region", { name: "Rows" })).not.toHaveFocus();
    expect(globalThis.document.body).toHaveFocus();
  });

  it("gives row focus precedence after the reader leaves the compact toolbar", () => {
    viewportStub = stubNarrowViewport(true);
    render(<ModeSurface />);
    screen.getByRole("button", { name: "View" }).focus();
    screen.getByRole("button", { name: "compact rows" }).focus();

    viewportStub.setNarrow(false);
    expect(screen.getByRole("region", { name: "Rows" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Options" })).not.toHaveFocus();
  });

  it("retains the ordinary ReactNode slot contract", () => {
    render(
      <GridTableListSurface
        table={<span>Static rows</span>}
        toolbar={<span>Static toolbar</span>}
      />
    );
    expect(screen.getByText("Static toolbar")).toBeInTheDocument();
    expect(screen.getByText("Static rows")).toBeInTheDocument();
  });
});

describe("GridTableListSurface selection rail layout", () => {
  it("floats the compact rail below md, reserves its band from md, and floats it at 768 wide", () => {
    viewportStub = stubNarrowViewport(true);
    const onPageChange = vi.fn();
    const onAddTag = vi.fn();
    render(
      <GridTableListSurface
        bulkActions={
          <TableBulkActionBar
            actionLabel="2 artifacts selected"
            actions={
              <button onClick={onAddTag} type="button">
                Add Tag
              </button>
            }
          />
        }
        pagination={
          <TablePagination
            onPageChange={onPageChange}
            page={0}
            totalPages={2}
          />
        }
        table={<span>Rows</span>}
        toolbar={<span>Toolbar</span>}
      />
    );

    const rail = screen.getByRole("toolbar", { name: "2 artifacts selected" });
    const footer = screen.getByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID);
    const railBand = rail.parentElement;
    // Operator ruling on the ISS-12305 iPhone retest: below `md` the compact
    // rail floats, so the band is `contents` there and a band only from `md`.
    expect(rail).toHaveClass("fixed", "bottom-16", "md:relative");
    expect(railBand).toHaveClass("contents", "md:flex", "md:px-4", "md:py-3");
    expect(railBand?.nextElementSibling).toBe(footer);
    fireEvent.click(screen.getByLabelText("Go to next page"));
    expect(onPageChange).toHaveBeenCalledExactlyOnceWith(1);
    expect(onAddTag).not.toHaveBeenCalled();

    viewportStub.setNarrow(false);
    expect(rail).toHaveClass("fixed", "md:bottom-8");
    expect(rail).not.toHaveClass("md:relative");
    expect(railBand).toHaveClass("contents");
    expect(railBand).not.toHaveClass("md:flex");
    viewportStub.setNarrow(true);
    expect(rail).toHaveClass("md:relative");
    expect(railBand).toHaveClass("md:flex");
  });

  it("adds no empty rail band when the opaque selection slot renders null", () => {
    viewportStub = stubNarrowViewport(true);
    render(
      <GridTableListSurface
        bulkActions={<AbsentSelection />}
        pagination={<span>Pagination</span>}
        table={<span>Rows</span>}
        toolbar={<span>Toolbar</span>}
      />
    );
    const footer = screen.getByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID);
    expect(footer.parentElement?.children).toHaveLength(3);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("GridTableToolbar explicit mode", () => {
  it("mounts one active slot and moves focus to the incoming trigger", () => {
    const { rerender } = render(<Toolbar mode="compact" />);
    screen.getByRole("button", { name: "View" }).focus();
    rerender(<Toolbar mode="expanded" />);
    expect(screen.getByRole("button", { name: "Options" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();

    screen.getByRole("button", { name: "Options" }).focus();
    rerender(<Toolbar mode="compact" />);
    expect(screen.getByRole("button", { name: "View" })).toHaveFocus();
  });

  it("does not steal focus back from a different control on resize", () => {
    const { rerender } = render(
      <>
        <Toolbar mode="compact" />
        <button type="button">External</button>
      </>
    );
    screen.getByRole("button", { name: "View" }).focus();
    screen.getByRole("button", { name: "External" }).focus();
    rerender(
      <>
        <Toolbar mode="expanded" />
        <button type="button">External</button>
      </>
    );
    expect(screen.getByRole("button", { name: "External" })).toHaveFocus();
  });

  it("preserves both responsive slots for existing callers without mode", () => {
    render(<Toolbar />);
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
  });
});

function ModeSurface({
  focusableRegion = true,
  showRows = true,
}: {
  focusableRegion?: boolean;
  showRows?: boolean;
}) {
  return (
    <div data-testid="surface-root">
      <GridTableListSurface
        table={(mode) =>
          showRows ? (
            <button key={mode} type="button">
              {mode} rows
            </button>
          ) : null
        }
        tableScrollAttributes={
          focusableRegion
            ? { "aria-label": "Rows", role: "region", tabIndex: 0 }
            : undefined
        }
        toolbar={(mode) => <Toolbar mode={mode} />}
      />
    </div>
  );
}

function Toolbar({ mode }: { mode?: GridTableListSurfaceMode }) {
  return (
    <GridTableToolbar
      compact={<button type="button">View</button>}
      expanded={<button type="button">Options</button>}
      mode={mode}
    />
  );
}

function AbsentSelection() {
  return null;
}

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
