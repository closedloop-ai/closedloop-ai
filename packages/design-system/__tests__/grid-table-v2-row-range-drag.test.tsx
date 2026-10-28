/**
 * ISS-8747 — click-and-drag row range selection, and the keyboard path it must
 * not disturb.
 *
 * The host is the real one: a small component holding `GridRowSelection` and
 * resolving EVERY path — click, `Shift`-click and drag — through
 * `resolveGridRowSelection`. Asserting the resulting selection rather than the
 * callback's arguments is what makes these cases about the range the user gets
 * instead of about the plumbing, and it is the only shape in which "the pointer
 * and the keyboard agree" is even expressible.
 *
 * jsdom lays nothing out, so every row's box is stubbed from its index. That is
 * the drag's whole input — `resolveDragRowIdAtPoint` reads `clientY` against
 * those boxes — so the stub IS the fixture, not a workaround.
 */

import { GridTableV2 } from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import {
  EMPTY_GRID_ROW_SELECTION,
  type GridRowSelection,
  resolveGridRowSelection,
} from "@closedloop-ai/design-system/lib/grid-table-v2-selection";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; name: string };

const ROWS: Row[] = [
  { id: "row-0", name: "Alpha" },
  { id: "row-1", name: "Bravo" },
  { id: "row-2", name: "Charlie" },
  { id: "row-3", name: "Delta" },
];

const ROW_HEIGHT = 40;

/** Reported selection, newest last, so a case can assert what the user ended with. */
let selections: string[][] = [];

function Host({
  enableRowRangeDrag,
  withGroupDrop = false,
}: {
  enableRowRangeDrag: boolean;
  /**
   * Wire the rows as a native HTML drag source, which is what the ONE production
   * consumer does — unconditionally (`sessions-list-surface-v2.tsx`). Off by
   * default here so the cases that predate the modifier keep asserting the
   * no-native-drag half of the contract.
   */
  withGroupDrop?: boolean;
}) {
  const [selection, setSelection] = useState<GridRowSelection>(
    EMPTY_GRID_ROW_SELECTION
  );
  const activate = (
    row: Row,
    modifiers: {
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    }
  ) => {
    setSelection((current) => {
      const next = resolveGridRowSelection(
        current,
        row.id,
        modifiers,
        ROWS.map((candidate) => candidate.id)
      );
      selections.push([...next.selectedIds]);
      return next;
    });
  };
  return (
    <GridTableV2<Row>
      columns={[{ id: "status", label: "Status" }]}
      enableRowRangeDrag={enableRowRangeDrag}
      getRowId={(row) => row.id}
      gridTemplateColumns="200px 120px"
      isRowSelected={(row) => selection.selectedIds.has(row.id)}
      items={ROWS}
      leadingLabel="Name"
      onGroupDrop={withGroupDrop ? groupDrop : undefined}
      onRowClick={activate}
      onRowKeyboardNavigate={activate}
      onRowRangeDrag={activate}
      renderCell={(_columnId, row) => (
        <button type="button">
          {`Open ${row.name}`}
          <svg aria-hidden data-testid={`button-glyph-${row.name}`} />
        </button>
      )}
      renderLead={(row) => (
        <span>
          {row.name}
          <svg aria-hidden data-testid={`glyph-${row.name}`} />
        </span>
      )}
    />
  );
}

function rowElement(name: string): HTMLElement {
  const row = screen.getByText(name).closest<HTMLElement>("[data-grid-row]");
  if (!row) {
    throw new Error(`no grid row around ${name}`);
  }
  return row;
}

/** Vertical centre of the row at `index`, in the stubbed layout. */
function centreOf(index: number): number {
  return index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/**
 * Give every selectable row a box, so `clientY` means something. Called after
 * render because the rows do not exist before it.
 */
function stubRowBoxes() {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>("[data-grid-selectable-row]")
  );
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () =>
      ({
        bottom: (index + 1) * ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 300,
        top: index * ROW_HEIGHT,
        width: 300,
        x: 0,
        y: index * ROW_HEIGHT,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return rows;
}

function gridBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>("[data-grid-body]");
  if (!body) {
    throw new Error("no grid body");
  }
  return body;
}

/** jsdom implements neither, and the hook calls both. */
function stubPointerCapture(body: HTMLElement) {
  const held = new Set<number>();
  // Every capture EVER taken, not only the ones still held. A release clears
  // `held`, so an assertion reading only that cannot tell "never captured"
  // from "captured and released" — and the whole point of deferring capture is
  // that a press which never moved must never capture AT ALL.
  const everCaptured: number[] = [];
  body.setPointerCapture = (pointerId: number) => {
    held.add(pointerId);
    everCaptured.push(pointerId);
  };
  body.releasePointerCapture = (pointerId: number) => {
    held.delete(pointerId);
  };
  body.hasPointerCapture = (pointerId: number) => held.has(pointerId);
  return { everCaptured, held };
}

/**
 * Live listeners of one type on `body`, so a leak is directly observable.
 *
 * `EventTarget`, not `HTMLElement`: the drag's pre-capture listeners live on
 * the DOCUMENT (a press that leaves the grid before its first move sends its
 * `pointermove` and `pointerup` nowhere near the body), so the leak this counts
 * has to be counted where the listeners actually are.
 */
function trackLiveListeners(body: EventTarget, type: string) {
  const live = new Set<EventListenerOrEventListenerObject>();
  const add: EventTarget["addEventListener"] = body.addEventListener.bind(body);
  const remove: EventTarget["removeEventListener"] =
    body.removeEventListener.bind(body);
  body.addEventListener = (
    name: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (name === type && listener) {
      live.add(listener);
    }
    add(name, listener, options);
  };
  body.removeEventListener = (
    name: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) => {
    if (name === type && listener) {
      live.delete(listener);
    }
    remove(name, listener, options);
  };
  return { count: () => live.size };
}

function pressRow(row: HTMLElement, init: Record<string, unknown> = {}) {
  // `pointerType` is explicit on EVERY press, so the default cases assert the
  // mouse path rather than jsdom's empty-string default — the touch cases below
  // only mean something against a mouse control that is genuinely a mouse.
  fireEvent.pointerDown(row, {
    button: 0,
    pointerId: 1,
    pointerType: "mouse",
    ...init,
  });
}

function movePointerTo(body: HTMLElement, index: number) {
  fireEvent.pointerMove(body, { clientY: centreOf(index), pointerId: 1 });
}

/**
 * Do what the BROWSER would do at the drag threshold, and report whether it did.
 *
 * jsdom implements no native drag-and-drop at all, so a test that simply fired
 * `dragstart` would prove nothing about `draggable` — it would fire on a row the
 * browser would never have dragged. Reading the attribute first is the only way
 * to model the real race: a native drag beginning is what cancels the pointer
 * stream and kills the range.
 */
function startNativeDragIfAllowed(
  row: HTMLElement,
  body: HTMLElement
): boolean {
  if (!row.draggable) {
    return false;
  }
  // jsdom fires drag events with no `dataTransfer` and the row's own handler
  // writes its payload to one, so a stand-in is mandatory.
  fireEvent.dragStart(row, {
    dataTransfer: { effectAllowed: "", setData: () => undefined },
  });
  // The browser cancels the pointer stream once a native drag owns the gesture.
  fireEvent.pointerCancel(body, { pointerId: 1 });
  return true;
}

function latestSelection(): string[] {
  return selections.at(-1) ?? [];
}

/** Advance past the macrotask boundary a later user interaction sits behind. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("GridTableV2 pointer row range drag (ISS-8747)", () => {
  beforeEach(() => {
    selections = [];
  });

  it("selects the contiguous range the pointer crossed", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Alpha"));
    // A press alone reports nothing: it is not yet a drag.
    expect(selections).toEqual([]);

    movePointerTo(body, 2);
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(latestSelection()).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("re-resolves from the press row when the drag comes back", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Bravo"));
    movePointerTo(body, 3);
    expect(latestSelection()).toEqual(["row-1", "row-2", "row-3"]);

    // Back past the anchor: the range flips to the other side of it rather
    // than growing from wherever the pointer last was.
    movePointerTo(body, 0);
    expect(latestSelection()).toEqual(["row-0", "row-1"]);
    fireEvent.pointerUp(body, { pointerId: 1 });
  });

  it("keeps the anchor after release, so a later Shift-click extends from the press row", async () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Bravo"));
    movePointerTo(body, 2);
    fireEvent.pointerUp(body, { pointerId: 1 });
    expect(latestSelection()).toEqual(["row-1", "row-2"]);

    // A release outside the grid synthesizes no click, so the drag's one-shot
    // click swallow disarms on the next task instead. Every real later
    // interaction is at least that far away; without this the swallow would eat
    // the user's next genuine click rather than the drag's own.
    await nextTask();
    fireEvent.click(rowElement("Delta"), { shiftKey: true });
    // From row-1, the press row — not from row-2, the row the drag ended on.
    expect(latestSelection()).toEqual(["row-1", "row-2", "row-3"]);
  });

  it("does not let the release's own click collapse the range", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Alpha"));
    movePointerTo(body, 2);
    fireEvent.pointerUp(body, { pointerId: 1 });
    // The browser synthesizes this after a drag; unmodified, it would resolve
    // as a plain activation.
    fireEvent.click(rowElement("Alpha"));

    expect(latestSelection()).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("leaves a plain click alone, so only the click path reports it", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    stubPointerCapture(gridBody());

    pressRow(rowElement("Charlie"));
    fireEvent.pointerUp(gridBody(), { pointerId: 1 });
    fireEvent.click(rowElement("Charlie"));

    // Exactly one activation, from the click — a press that never moved is not
    // a drag and must not report a second time.
    expect(selections).toEqual([["row-2"]]);
  });

  it("never starts a drag from a control that owns its own click", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    const control = screen.getByRole("button", { name: "Open Alpha" });
    fireEvent.pointerDown(control, { button: 0, pointerId: 1 });
    movePointerTo(body, 3);

    expect(selections).toEqual([]);
  });

  it("stops cleanly at the last rendered row when the pointer leaves the grid", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Bravo"));
    // Far below the last painted row.
    fireEvent.pointerMove(body, { clientY: 5000, pointerId: 1 });
    fireEvent.pointerUp(body, { pointerId: 1 });

    // Clamped to the boundary rather than silently truncating at whichever row
    // the last sample happened to land on.
    expect(latestSelection()).toEqual(["row-1", "row-2", "row-3"]);
  });

  it("captures only once the press becomes a drag, and releases on commit", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    const capture = stubPointerCapture(body);

    pressRow(rowElement("Alpha"));
    // NOT on the press. A held capture retargets the compatibility mouse events
    // too, so the `click` closing a press would be dispatched at the grid body
    // — an ancestor of the row — and the row's own `onClick` would drop out of
    // its propagation path. Capturing eagerly would break plain click-to-select
    // on every row the moment this gate opened.
    expect(capture.everCaptured).toEqual([]);

    movePointerTo(body, 1);
    expect(capture.held.has(1)).toBe(true);

    fireEvent.pointerUp(body, { pointerId: 1 });
    expect(capture.held.has(1)).toBe(false);
    // A release OUTSIDE the grid still commits, which is what the capture buys.
    expect(latestSelection()).toEqual(["row-0", "row-1"]);
  });

  it("leaves a press that never moved uncaptured, so its click still reaches the row", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    const capture = stubPointerCapture(body);

    pressRow(rowElement("Charlie"));
    fireEvent.pointerUp(body, { pointerId: 1 });

    // Nothing was captured across the WHOLE press, so nothing retargeted the
    // click the browser now synthesizes. Asserted against the history, not the
    // held set: an eager capture released on `pointerup` leaves that set empty
    // too, and would pass an assertion that only read it.
    expect(capture.everCaptured).toEqual([]);
    fireEvent.click(rowElement("Charlie"));
    expect(selections).toEqual([["row-2"]]);
  });

  it("retires a live drag when a second pointer presses, instead of leaking its listeners", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);
    const live = trackLiveListeners(body.ownerDocument, "pointermove");

    pressRow(rowElement("Alpha"));
    movePointerTo(body, 1);
    expect(live.count()).toBe(1);

    // A second finger lands without the first ever releasing.
    fireEvent.pointerDown(rowElement("Charlie"), { button: 0, pointerId: 2 });

    // ONE, not two. Only the CURRENT drag's listeners are torn down in
    // `endDrag`, so a press that merely overwrote `drag.current` would strand
    // the previous drag's `pointermove` on the body for the life of the grid,
    // one more each time. The selection is NOT the assertion here: the stranded
    // handler reads the same shared state and no-ops, so every range still
    // resolves correctly while the listeners pile up invisibly.
    expect(live.count()).toBe(1);

    fireEvent.pointerUp(body, { pointerId: 2 });
    expect(live.count()).toBe(0);
  });

  it("starts a range from a press on a decorative SVG inside the row", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    const glyph = screen.getByTestId("glyph-Alpha");
    fireEvent.pointerDown(glyph, { button: 0, pointerId: 1 });
    movePointerTo(body, 2);

    // The press target of a row is very often an `SVGElement` — a status icon,
    // a chevron, a provenance mark — and an `instanceof HTMLElement` guard
    // rejects every one of them, so the drag never began (davetho review).
    // The ancestor walk is what still opts an SVG inside a BUTTON out; see the
    // next case, which is the positive control for this one.
    expect(latestSelection()).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("still refuses a press on an SVG inside an interactive control", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    // Same element KIND as the case above, inside a button this time. Widening
    // the target type must not widen what counts as a draggable surface.
    fireEvent.pointerDown(screen.getByTestId("button-glyph-Alpha"), {
      button: 0,
      pointerId: 1,
    });
    movePointerTo(body, 2);

    expect(selections).toEqual([]);
  });

  it("retires a drag whose first move lands outside the grid", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);
    const live = trackLiveListeners(body.ownerDocument, "pointermove");

    pressRow(rowElement("Bravo"));
    expect(live.count()).toBe(1);

    // Below the last painted row and outside the body entirely. Nothing has
    // captured yet — capture is deferred to the first move — so before this
    // fix neither event reached the hook at all: the range never clamped and
    // the drag stayed live, listeners attached, until the next press or
    // unmount (davetho review).
    fireEvent.pointerMove(document.body, {
      clientY: centreOf(ROWS.length) + ROW_HEIGHT,
      pointerId: 1,
    });
    expect(latestSelection()).toEqual(["row-1", "row-2", "row-3"]);

    fireEvent.pointerUp(document.body, { pointerId: 1 });
    expect(live.count()).toBe(0);
  });

  it("ignores a release from a pointer that is not driving the drag", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Alpha"));
    movePointerTo(body, 1);
    // A different pointer's release must not commit and tear down this drag.
    fireEvent.pointerUp(body, { pointerId: 9 });

    fireEvent.pointerMove(body, { clientY: centreOf(2), pointerId: 1 });
    expect(latestSelection()).toEqual(["row-0", "row-1", "row-2"]);
  });

  /**
   * ISS-11865. The predecessor of this case pressed, moved STRAIGHT to another
   * row, and then read the class — so it passed while the whole press-row
   * travel was still selecting text, which is the bug it was named for. The
   * assertion that matters is the one between the press and the first move.
   */
  it("suppresses text selection from the press, before the pointer has crossed a row", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    expect(body).not.toHaveClass("select-none");
    pressRow(rowElement("Alpha"));
    expect(body).toHaveClass("select-none");

    movePointerTo(body, 1);
    expect(body).toHaveClass("select-none");

    fireEvent.pointerUp(body, { pointerId: 1 });
    // Given back afterwards, so the class is scoped to the press rather than to
    // the life of the grid. It is the press's `preventDefault`, not this class,
    // that is why a mouse can no longer open a selection inside a cell at all —
    // see the hook, and ISS-11865's Expected behavior.
    expect(body).not.toHaveClass("select-none");
  });

  it("gives the class back when a press is released without ever moving", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Alpha"));
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(body).not.toHaveClass("select-none");
  });

  it("cancels the press default, so the browser never opens a selection", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    stubPointerCapture(gridBody());

    // `fireEvent` returns false when a listener called `preventDefault`, which
    // is the only thing that stops the browser's own selection gesture; the
    // class alone cannot, because that gesture has already begun by the first
    // `pointermove`.
    const notPrevented = fireEvent.pointerDown(rowElement("Alpha"), {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(notPrevented).toBe(false);
  });

  it("clears a selection the press landed inside", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);
    const removeAllRanges = vi.fn();
    vi.spyOn(body.ownerDocument, "getSelection").mockReturnValue({
      removeAllRanges,
    } as unknown as Selection);

    pressRow(rowElement("Alpha"));

    // `preventDefault` stops a NEW selection and does nothing to one already
    // painted, so a press inside the reader's own selection would otherwise
    // drag with it still lit.
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });

  it("focuses the cell the press landed in, which the cancelled default no longer does", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    stubPointerCapture(gridBody());
    const pressTarget = screen.getByText("Alpha");
    const pressCell = pressTarget.closest<HTMLElement>("[data-grid-cell]");
    // The row's `onClick` cannot carry this on a drag — `swallowNextClick` eats
    // that click — so the press has to move focus itself or a dragged range
    // leaves the keyboard pointed at whatever was focused before (tamsinb
    // review). Focus starts OFF the cell so the assertion cannot pass on a
    // focus that was already there.
    expect(document.activeElement).not.toBe(pressCell);

    pressRow(pressTarget);

    expect(document.activeElement).toBe(pressCell);
  });

  it("leaves a press that cannot begin a range completely alone", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);
    const removeAllRanges = vi.fn();
    vi.spyOn(body.ownerDocument, "getSelection").mockReturnValue({
      removeAllRanges,
    } as unknown as Selection);

    // A touch press is a scroll, so none of the three halves of the suppression
    // may fire — cancelling its default would stop the list scrolling at all.
    const notPrevented = fireEvent.pointerDown(rowElement("Alpha"), {
      button: 0,
      pointerId: 1,
      pointerType: "touch",
    });

    expect(notPrevented).toBe(true);
    expect(removeAllRanges).not.toHaveBeenCalled();
    expect(body).not.toHaveClass("select-none");
  });

  it("does nothing at all while the flag is closed", () => {
    render(<Host enableRowRangeDrag={false} />);
    // The rows are not even marked selectable, so nothing can resolve a range.
    expect(
      document.querySelectorAll("[data-grid-selectable-row]")
    ).toHaveLength(0);
    const body = gridBody();
    const setCapture = vi.fn();
    body.setPointerCapture = setCapture;

    pressRow(rowElement("Alpha"));
    fireEvent.pointerMove(body, { clientY: centreOf(2), pointerId: 1 });
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(setCapture).not.toHaveBeenCalled();
    expect(selections).toEqual([]);
  });

  it("stays closed for a caller that passes no flag at all", () => {
    // The DEFAULT, not the explicit-`false` branch the case above pins. A gate
    // that shipped open would change what a press does on every v2 grid that
    // never asked for a drag.
    render(
      <GridTableV2<Row>
        columns={[{ id: "status", label: "Status" }]}
        getRowId={(row) => row.id}
        gridTemplateColumns="200px 120px"
        items={ROWS}
        leadingLabel="Name"
        onRowRangeDrag={() => {
          selections.push(["reported"]);
        }}
        renderCell={() => null}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );
    expect(
      document.querySelectorAll("[data-grid-selectable-row]")
    ).toHaveLength(0);
    pressRow(rowElement("Alpha"));
    fireEvent.pointerMove(gridBody(), { clientY: centreOf(2), pointerId: 1 });
    expect(selections).toEqual([]);
  });

  it("leaves Shift+ArrowDown resolving the same range the pointer would", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    stubPointerCapture(gridBody());

    // Anchor with a plain click, then extend by keyboard.
    fireEvent.click(rowElement("Alpha"));
    expect(latestSelection()).toEqual(["row-0"]);

    const cell = screen
      .getByText("Alpha")
      .closest<HTMLElement>("[data-grid-cell]") as HTMLElement;
    cell.focus();
    fireEvent.keyDown(cell, { key: "ArrowDown", shiftKey: true });

    expect(latestSelection()).toEqual(["row-0", "row-1"]);
  });
});

/**
 * A finger dragging the list is a SCROLL, never a range (tamsinb review cid
 * 3930344635). Touch fires `pointerdown` with `button === 0` and then
 * `pointermove` exactly as a mouse does, so the press guard had nothing to tell
 * them apart and every scroll on a tablet selected the rows it passed.
 */
describe("GridTableV2 pointer row range drag touch parity (ISS-8747)", () => {
  beforeEach(() => {
    selections = [];
  });

  it("never starts a range from a touch press, so the list still scrolls", () => {
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Alpha"), { pointerType: "touch" });
    movePointerTo(body, 2);
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(selections).toEqual([]);
  });

  it("still starts one from a mouse press over the same rows", () => {
    // The positive control for the case above: the guard must reject the
    // POINTER TYPE, not the gesture, so a suite that only asserted the touch
    // half would stay green under a guard that rejected everything.
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    pressRow(rowElement("Alpha"));
    movePointerTo(body, 2);
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(latestSelection()).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("leaves a touch press on a native drag row exactly as it renders today", () => {
    // There is no modifier key on a touchscreen, and what touch should do with
    // the two gestures is UNDECIDED. So touch gets no new behaviour at all: the
    // row is still a native drag source and still starts no range.
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    expect(rowElement("Alpha").draggable).toBe(true);
    pressRow(rowElement("Alpha"), { pointerType: "touch" });
    movePointerTo(body, 2);

    expect(selections).toEqual([]);
    expect(rowElement("Alpha").draggable).toBe(true);
  });
});

/**
 * ISS-8930 / whitlockk review cid 3929275022 — the two gestures on one press.
 *
 * `dragstart` fires at the browser's own few-pixel threshold and cancels the
 * pointer stream, so with native group drag wired an unmodified press-and-drag
 * IS a group drag and a range started from it dies at the first move. The
 * operator ruled the two apart with `Alt`/`Option` on 2026-09-04.
 *
 * `Alt` and not `Shift`, because `Shift` is already the range-extend-from-anchor
 * modifier on these same rows — two range meanings on one key, split by
 * click-versus-drag, is worse than either. UNMODIFIED keeps the native group
 * drag that ships today, so no existing user's press changes meaning.
 */
describe("GridTableV2 range drag against native group drag (ISS-8747)", () => {
  beforeEach(() => {
    selections = [];
    groupDrop.mockClear();
    releaseAlt();
  });

  it("gives an unmodified press to the native group drag, which kills the range", () => {
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    const row = rowElement("Alpha");
    pressRow(row);
    // The browser's threshold is crossed before the pointer has reached another
    // row, so this is what actually happens on an unmodified drag.
    expect(startNativeDragIfAllowed(row, body)).toBe(true);
    movePointerTo(body, 2);

    // No range: the gesture belonged to the group drag, exactly as it does today.
    expect(selections).toEqual([]);
  });

  it("gives an Alt press to the range, because no native drag begins", () => {
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    holdAlt();
    const row = rowElement("Alpha");
    pressRow(row, { altKey: true });
    // Unasserted ON PURPOSE. What must fail when the modifier stops reaching
    // `draggable` is the RANGE below, not this helper's return value: a case
    // that stopped at the attribute would redden on the attribute and say
    // nothing about the gesture the user actually performed.
    startNativeDragIfAllowed(row, body);
    movePointerTo(body, 2);
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(latestSelection()).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("restores the native drag the moment Alt is released", () => {
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    holdAlt();
    releaseAlt();
    const row = rowElement("Alpha");
    pressRow(row);
    startNativeDragIfAllowed(row, body);
    movePointerTo(body, 2);

    // The group drag owns the gesture again, exactly as it did before the key
    // was ever pressed.
    expect(selections).toEqual([]);
    expect(row.draggable).toBe(true);
  });

  it("takes the native drag away when Alt arrives AFTER the press", () => {
    // The modifier is live state, not a property of the press: a user who
    // starts moving and only then reaches for Option has not crossed the
    // browser's threshold yet, and the row must already be undraggable when
    // they do.
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    const row = rowElement("Alpha");
    pressRow(row, { altKey: true });
    holdAlt();
    startNativeDragIfAllowed(row, body);
    movePointerTo(body, 2);
    fireEvent.pointerUp(body, { pointerId: 1 });

    expect(latestSelection()).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("gives it back when Alt is released mid-gesture", () => {
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    holdAlt();
    const row = rowElement("Alpha");
    pressRow(row, { altKey: true });
    releaseAlt();
    startNativeDragIfAllowed(row, body);
    movePointerTo(body, 2);

    // The native drag is back mid-gesture and takes the pointer stream with it,
    // so the range the press had begun goes no further.
    expect(selections).toEqual([]);
  });

  it("does not leave the modifier stuck on when the window loses focus", () => {
    // A tab or window switch taken WITH Option down consumes its keyup. Without
    // this, native group drag would stay dead on every row until the user
    // pressed and released the key again — a gesture broken by a key they are
    // no longer holding.
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    holdAlt();
    fireEvent.blur(globalThis.window);

    const row = rowElement("Alpha");
    pressRow(row);
    startNativeDragIfAllowed(row, body);
    movePointerTo(body, 2);

    expect(selections).toEqual([]);
    expect(row.draggable).toBe(true);
  });

  it("renders the row undraggable while Alt is held", () => {
    // The attribute itself, once, because it is the browser's ONLY input at the
    // drag threshold — the gesture cases above are what prove it is load-bearing.
    render(<Host enableRowRangeDrag withGroupDrop />);
    stubRowBoxes();

    expect(rowElement("Alpha").draggable).toBe(true);
    holdAlt();
    expect(rowElement("Alpha").draggable).toBe(false);
    releaseAlt();
    expect(rowElement("Alpha").draggable).toBe(true);
  });

  it("does nothing to a row that is not a native drag source", () => {
    // Holding the modifier where the two gestures never collide must not change
    // the press at all: there is no native drag to give up, so an unmodified
    // press still ranges.
    render(<Host enableRowRangeDrag />);
    stubRowBoxes();
    const body = gridBody();
    stubPointerCapture(body);

    holdAlt();

    pressRow(rowElement("Alpha"));
    movePointerTo(body, 1);

    expect(latestSelection()).toEqual(["row-0", "row-1"]);
  });

  it("leaves the native drag alone while the range gate is closed", () => {
    // The modifier belongs to the range feature. With the flag off there is
    // only one gesture, and Option must not be able to disable it.
    render(<Host enableRowRangeDrag={false} withGroupDrop />);
    stubRowBoxes();

    holdAlt();

    expect(rowElement("Alpha").draggable).toBe(true);
  });
});

/** Wired only where a case asks for it; `draggable` keys off its presence. */
const groupDrop = vi.fn();

/**
 * Press and release `Alt` at the window, which is where the live modifier state
 * is watched from. `altKey` is `true` on `Alt`'s own keydown and `false` on its
 * keyup, which is exactly what the browser sends.
 */
function holdAlt() {
  fireEvent.keyDown(globalThis.window, { altKey: true, key: "Alt" });
}

function releaseAlt() {
  fireEvent.keyUp(globalThis.window, { altKey: false, key: "Alt" });
}
