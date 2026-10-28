import {
  GridTableV2,
  type GridTableV2Column,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import {
  COLUMN_RESIZE_KEYBOARD_STEP_PX,
  MIN_COLUMN_WIDTH_PX,
} from "@closedloop-ai/design-system/lib/column-order";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-8068 — keyboard column resize on the v2 header, and the `preventDefault`
 * that keeps it from doubling as a horizontal scroll.
 *
 * The handler shipped with the v2 promotion candidate but nothing asserted it:
 * the resize coverage that exists targets the v1 `GridTable`, so every part of
 * this path — the step, the floor, the accessible name, and the defaulted-
 * prevented event — could be deleted from `table-grid-header-v2.tsx` with a
 * green suite. Each expected width below is written out as a literal rather
 * than composed from `COLUMN_RESIZE_KEYBOARD_STEP_PX` / `MIN_COLUMN_WIDTH_PX`,
 * so a change to either constant fails here instead of silently agreeing with
 * itself.
 *
 * The clamp case's fixture INPUT is the one place that inverts, and on purpose.
 * A literal start width has to sit less than one step above the floor for the
 * clamp branch to run at all, which silently couples it to the step: seeded at
 * 64, shrinking the step to 4 lands on 60 through the NON-clamping branch and
 * the test keeps passing while covering nothing. Deriving the start width keeps
 * the scenario the test's name claims under any step. That is setup, not the
 * arithmetic re-derivation of an expectation the repo's test rules prohibit —
 * the expected output stays the literal 60.
 */

type Row = { id: string; name: string; owner: string };

const ROWS: Row[] = [{ id: "r1", name: "Alpha", owner: "ana" }];
const COLUMNS: GridTableV2Column[] = [{ id: "owner", label: "Owner" }];
const NAVIGABLE_COLUMNS: GridTableV2Column[] = [
  ...COLUMNS,
  { id: "other", label: "Other" },
];

const SCROLLER_TEST_ID = "grid-scroller";
/** Any resize handle, whatever width its name currently states. */
const ANY_RESIZE_HANDLE = /^Resize Owner column,/;
/** The lead column's resize handle, rendered when the fixture opts in. */
const LEAD_RESIZE_HANDLE = /^Resize Name column,/;
const LEAD_WIDTH_PX = 240;
/** The measurement claim a name must NOT carry when the width is unusable. */
const STATES_A_WIDTH = /pixels wide/;

/**
 * Pixels the emulated browser default action scrolls per unprevented arrow.
 * Arbitrary — only its non-zero-ness is load-bearing.
 */
const EMULATED_ARROW_SCROLL_PX = 40;

type ArrowScrollEmulator = {
  /** Arrow keydowns that REACHED `document`, prevented or not. */
  arrowsSeen: number;
  stop: () => void;
};

/**
 * The one piece of browser behavior jsdom does not implement: an arrow key
 * scrolls its scroll container UNLESS a handler prevented the default. Without
 * this, `expect(scrollLeft).toBe(0)` is vacuous — jsdom never scrolls, so the
 * assertion holds just as well with `preventDefault` deleted, which is the
 * exact regression AC2 exists to catch.
 *
 * Registered on `document`, deliberately. React 19 delegates its listeners to
 * the root container that `render` creates, so a listener on any element INSIDE
 * that container runs BEFORE the component's own handler and would read
 * `defaultPrevented === false` every time. `document` sits above the root
 * container, which is also where the real browser evaluates the default action.
 *
 * `arrowsSeen` closes the hole that placement opens. A resting `scrollLeft`
 * proves only that this listener did not scroll, which is equally true if the
 * event never got here — a `stopPropagation` anywhere between the handle and
 * `document` would read as a pass. Counting arrivals separates "the default was
 * declined" from "the default was never offered".
 */
function emulateBrowserArrowScroll(
  container: HTMLElement
): ArrowScrollEmulator {
  const emulator: ArrowScrollEmulator = {
    arrowsSeen: 0,
    stop: () => undefined,
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    emulator.arrowsSeen += 1;
    if (event.defaultPrevented) {
      return;
    }
    container.scrollLeft +=
      event.key === "ArrowRight"
        ? EMULATED_ARROW_SCROLL_PX
        : -EMULATED_ARROW_SCROLL_PX;
  };
  document.addEventListener("keydown", onKeyDown);
  emulator.stop = () => document.removeEventListener("keydown", onKeyDown);
  return emulator;
}

/**
 * A host that persists the emitted width the way the props contract requires,
 * so the handle re-renders against its NEW width instead of re-reporting the
 * initial one on every keypress.
 */
function ResizableGrid({
  initialWidthPx = 200,
  leadResizable = false,
  navigableHeaderCells = false,
  onResize,
}: {
  initialWidthPx?: number;
  /** Gives the lead column a width, which is what renders its resize handle. */
  leadResizable?: boolean;
  navigableHeaderCells?: boolean;
  onResize?: (columnId: string, widthPx: number) => void;
}) {
  const [widthPx, setWidthPx] = useState(initialWidthPx);
  return (
    <div data-testid={SCROLLER_TEST_ID}>
      <GridTableV2<Row>
        columns={navigableHeaderCells ? NAVIGABLE_COLUMNS : COLUMNS}
        columnWidths={{ owner: widthPx }}
        getRowId={(row) => row.id}
        gridTemplateColumns={`minmax(200px, 1fr) ${widthPx}px${navigableHeaderCells ? " 120px" : ""}`}
        items={ROWS}
        leadingColumnWidth={leadResizable ? LEAD_WIDTH_PX : undefined}
        leadingLabel="Name"
        navigableHeaderCells={navigableHeaderCells}
        onColumnWidthChange={(columnId, nextWidthPx) => {
          onResize?.(columnId, nextWidthPx);
          setWidthPx(nextWidthPx);
        }}
        onLeadingColumnWidthChange={leadResizable ? vi.fn() : undefined}
        renderCell={(_columnId, row) => row.owner}
        renderLead={(row) => <span>{row.name}</span>}
      />
    </div>
  );
}

function resizeHandle(): HTMLElement {
  return screen.getByRole("button", { name: ANY_RESIZE_HANDLE });
}

describe("ISS-8068 AC1 — arrow keys resize the focused column", () => {
  it("grows the column one step on ArrowRight", () => {
    const onResize = vi.fn();
    render(<ResizableGrid onResize={onResize} />);

    fireEvent.keyDown(resizeHandle(), { key: "ArrowRight" });

    expect(onResize).toHaveBeenCalledWith("owner", 216);
  });

  it("shrinks the column one step on ArrowLeft", () => {
    const onResize = vi.fn();
    render(<ResizableGrid onResize={onResize} />);

    fireEvent.keyDown(resizeHandle(), { key: "ArrowLeft" });

    expect(onResize).toHaveBeenCalledWith("owner", 184);
  });

  it("steps again from the width it just committed", () => {
    // A handle that re-reads its start width from a stale prop would report 216
    // twice and the column would never pass one step.
    const onResize = vi.fn();
    render(<ResizableGrid onResize={onResize} />);

    fireEvent.keyDown(resizeHandle(), { key: "ArrowRight" });
    fireEvent.keyDown(resizeHandle(), { key: "ArrowRight" });

    expect(onResize).toHaveBeenLastCalledWith("owner", 232);
  });

  it("lands on the shared floor instead of collapsing the column", () => {
    // One pixel short of a full step above the floor, so the shrink always
    // undershoots it and the clamp always runs — see the file docstring.
    const justAboveFloor =
      MIN_COLUMN_WIDTH_PX + COLUMN_RESIZE_KEYBOARD_STEP_PX - 1;
    const onResize = vi.fn();
    render(
      <ResizableGrid initialWidthPx={justAboveFloor} onResize={onResize} />
    );

    fireEvent.keyDown(resizeHandle(), { key: "ArrowLeft" });

    // Literal, and distinct from the start width, so a handler that merely
    // echoed the current width back would fail this.
    expect(onResize).toHaveBeenCalledWith("owner", 60);
    expect(justAboveFloor).toBeGreaterThan(60);
  });

  it("names the floor once the column is sitting on it", () => {
    // The floor is where this control goes silent: pressing again emits the
    // same width, nothing re-renders, and without this word a screen-reader
    // user cannot tell "at minimum" from "control broken".
    render(<ResizableGrid initialWidthPx={60} />);

    expect(
      screen.getByRole("button", {
        name: "Resize Owner column, 60 pixels wide, minimum, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("does not claim a minimum for a column above the floor", () => {
    // The opposite-state sibling: the word is conditional, not boilerplate
    // every handle carries.
    render(<ResizableGrid initialWidthPx={200} />);

    expect(
      screen.getByRole("button", {
        name: "Resize Owner column, 200 pixels wide, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("ignores a key that is not a horizontal arrow", () => {
    // The positive sibling for the two above: the handler is selective, not a
    // catch-all that would resize on any keystroke reaching a focused handle.
    const onResize = vi.fn();
    render(<ResizableGrid onResize={onResize} />);

    fireEvent.keyDown(resizeHandle(), { key: "ArrowDown" });
    fireEvent.keyDown(resizeHandle(), { key: "a" });

    expect(onResize).not.toHaveBeenCalled();
  });
});

describe("ISS-9452 — a resize key belongs to its focused header control", () => {
  it("keeps the same button focused through both arrows and another resize", () => {
    const onResize = vi.fn();
    render(<ResizableGrid navigableHeaderCells onResize={onResize} />);
    const handle = resizeHandle();
    const scroller = screen.getByTestId(SCROLLER_TEST_ID);
    const emulator = emulateBrowserArrowScroll(scroller);
    handle.focus();

    try {
      expect(fireEvent.keyDown(handle, { key: "ArrowRight" })).toBe(false);
      expect(onResize).toHaveBeenLastCalledWith("owner", 216);
      expect(document.activeElement).toBe(handle);
      expect(handle.getAttribute("aria-label")).toBe(
        "Resize Owner column, 216 pixels wide, use arrow keys"
      );

      expect(fireEvent.keyDown(handle, { key: "ArrowLeft" })).toBe(false);
      expect(onResize).toHaveBeenLastCalledWith("owner", 200);
      expect(document.activeElement).toBe(handle);
      expect(handle.getAttribute("aria-label")).toBe(
        "Resize Owner column, 200 pixels wide, use arrow keys"
      );

      expect(fireEvent.keyDown(handle, { key: "ArrowRight" })).toBe(false);
      expect(onResize).toHaveBeenLastCalledWith("owner", 216);
      expect(document.activeElement).toBe(handle);
      expect(emulator.arrowsSeen).toBe(3);
      expect(scroller.scrollLeft).toBe(0);
    } finally {
      emulator.stop();
    }
  });

  it("still moves an unhandled header arrow to the adjacent header", () => {
    const onResize = vi.fn();
    render(<ResizableGrid navigableHeaderCells onResize={onResize} />);
    const ownerHeader = screen.getByRole("columnheader", { name: "Owner" });
    const nameHeader = screen.getByRole("columnheader", { name: "Name" });
    ownerHeader.focus();

    fireEvent.keyDown(ownerHeader, { key: "ArrowLeft" });

    expect(document.activeElement).toBe(nameHeader);
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe("ISS-8068 AC2 — the resize arrow does not ALSO scroll the table", () => {
  it("marks the event handled, so the emulated default scroll never runs", () => {
    const onResize = vi.fn();
    render(<ResizableGrid onResize={onResize} />);
    const scroller = screen.getByTestId(SCROLLER_TEST_ID);
    const emulator = emulateBrowserArrowScroll(scroller);

    try {
      const notPrevented = fireEvent.keyDown(resizeHandle(), {
        key: "ArrowRight",
      });

      // The event reached the layer that would have scrolled…
      expect(emulator.arrowsSeen).toBe(1);
      // …and that layer declined, so the container did not move.
      expect(scroller.scrollLeft).toBe(0);
      // Then the mechanism. `fireEvent` returns false exactly when a handler
      // called `preventDefault` on the dispatched event.
      expect(notPrevented).toBe(false);
      // …and the resize itself still happened, so this is a prevented default
      // rather than a key that did nothing at all.
      expect(onResize).toHaveBeenCalledWith("owner", 216);
    } finally {
      emulator.stop();
    }
  });

  it("prevents the default on ArrowLeft too", () => {
    render(<ResizableGrid />);
    const scroller = screen.getByTestId(SCROLLER_TEST_ID);
    const emulator = emulateBrowserArrowScroll(scroller);

    try {
      const notPrevented = fireEvent.keyDown(resizeHandle(), {
        key: "ArrowLeft",
      });

      expect(emulator.arrowsSeen).toBe(1);
      expect(scroller.scrollLeft).toBe(0);
      expect(notPrevented).toBe(false);
    } finally {
      emulator.stop();
    }
  });

  it("scrolls that same container for an arrow nothing prevented", () => {
    // The positive sibling the two negatives above need. Without it, a harness
    // that can never move `scrollLeft` would report the same green whether or
    // not `preventDefault` is present.
    render(<ResizableGrid />);
    const scroller = screen.getByTestId(SCROLLER_TEST_ID);
    const emulator = emulateBrowserArrowScroll(scroller);

    try {
      const notPrevented = fireEvent.keyDown(scroller, { key: "ArrowRight" });

      expect(notPrevented).toBe(true);
      expect(scroller.scrollLeft).toBe(EMULATED_ARROW_SCROLL_PX);
    } finally {
      emulator.stop();
    }
  });
});

describe("ISS-8068 AC3 — the handle is focusable and names its current width", () => {
  it("states the column, the current width, and the operating keys", () => {
    render(<ResizableGrid />);

    expect(
      screen.getByRole("button", {
        name: "Resize Owner column, 200 pixels wide, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("restates the NEW width after a keyboard resize", () => {
    render(<ResizableGrid />);

    fireEvent.keyDown(resizeHandle(), { key: "ArrowRight" });

    expect(
      screen.getByRole("button", {
        name: "Resize Owner column, 216 pixels wide, use arrow keys",
      })
    ).toBeInTheDocument();
    // The load-bearing half: a name that states a width but never updates it is
    // a lying label, and would satisfy the assertion above on its own.
    expect(
      screen.queryByRole("button", {
        name: "Resize Owner column, 200 pixels wide, use arrow keys",
      })
    ).toBeNull();
  });

  it("is a real tab stop, not a pointer-only hit target", () => {
    render(<ResizableGrid />);
    const handle = resizeHandle();

    expect(handle.tagName).toBe("BUTTON");
    expect(handle.tabIndex).toBe(0);

    handle.focus();
    expect(document.activeElement).toBe(handle);
  });
});

/**
 * `columnWidths` is caller-owned and typed `number`, and `GridTableV2` hands it
 * to `getColumnWidth` UNCLAMPED (`columnWidths?.[id] ?? MIN_COLUMN_WIDTH_PX` —
 * `??` passes `NaN` straight through). A corrupt persisted width from a restored
 * saved view therefore reaches the accessible name by the production prop path,
 * which is why these render the real grid rather than poking the handle
 * directly.
 *
 * Each case is driven through the whole name, not a substring: with the guard
 * deleted, `NaN` and `Infinity` announce "<value> pixels wide" and
 * `-Infinity` — being `<= MIN_COLUMN_WIDTH_PX` — announces "-Infinity pixels
 * wide, minimum", so all three diverge from the expected string. The second
 * assertion states the contract itself rather than the literal: the name may
 * not claim a measurement it does not have.
 */
describe("ISS-8068 — a non-finite width names no width at all", () => {
  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("states no width rather than a false one for %s", (_label, widthPx) => {
    render(<ResizableGrid initialWidthPx={widthPx} />);

    const name = resizeHandle().getAttribute("aria-label");

    expect(name).toBe("Resize Owner column, use arrow keys");
    expect(name).not.toMatch(STATES_A_WIDTH);
  });

  it("still names the width for a finite one, so the fallback is not blanket", () => {
    render(<ResizableGrid initialWidthPx={200} />);

    expect(resizeHandle().getAttribute("aria-label")).toBe(
      "Resize Owner column, 200 pixels wide, use arrow keys"
    );
  });
});

/**
 * `columnheader` takes its name FROM CONTENT, and the resize handle sits inside
 * the cell, so the width this PR added to the handle's name is one wrong move
 * away from being welded onto the HEADER's name too, leaving a screen-reader
 * user arrowing across the row to hear "Owner Resize Owner column, 200 pixels
 * wide, use arrow keys" instead of "Owner".
 *
 * That is what Chromium does to a content-derived header name: it includes the
 * handle's `aria-label`, so the Sessions lead column was announced as "Resize
 * Session column, N pixels wide, use arrow keys Session". jsdom
 * (dom-accessibility-api) leaves the handle out, so a name assertion here passes
 * either way. ISS-11931 names every header that renders a named control by an
 * `aria-label` equal to its label, extending what ISS-11837 did for the options
 * menu, and these cases pin that attribute. The browser-computed name is proved
 * by the Sessions e2e specs on web and desktop.
 *
 * Asserted on both header kinds, because both can carry a handle: the data
 * column via `resize`, and the fixed leading identity column via
 * `leadingResize`, which the fixture renders when it gives the lead a width.
 */
describe("ISS-8068 — a resize handle's name does not fold into its header's", () => {
  it("names the data column header by its label alone", () => {
    render(<ResizableGrid />);

    expect(screen.getByRole("columnheader", { name: "Owner" })).toHaveAttribute(
      "aria-label",
      "Owner"
    );
    // The other half: the control keeps its own full name, so a clean header
    // name can never be bought by silencing the handle.
    expect(resizeHandle().getAttribute("aria-label")).toBe(
      "Resize Owner column, 200 pixels wide, use arrow keys"
    );
  });

  it("names the leading identity column header by its label alone", () => {
    render(<ResizableGrid leadResizable />);

    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-label",
      "Name"
    );
    expect(
      screen.getByRole("button", { name: LEAD_RESIZE_HANDLE })
    ).toHaveAttribute(
      "aria-label",
      "Resize Name column, 240 pixels wide, use arrow keys"
    );
  });
});
