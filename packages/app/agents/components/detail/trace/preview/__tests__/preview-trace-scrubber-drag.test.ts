import { describe, expect, it } from "vitest";
import {
  advanceScrubberDrag,
  beginScrubberDrag,
} from "../preview-trace-scrubber-drag";

const WINDOW = { windowFrom: 0.4, windowTo: 0.6, isWindowed: true };

describe("beginScrubberDrag", () => {
  it("pans when the press lands inside the highlighted window", () => {
    const drag = beginScrubberDrag(0.5, WINDOW);

    expect(drag.mode).toBe("pan");
    // The window is carried unchanged: a press is not yet a move.
    expect(drag.from).toBe(0.4);
    expect(drag.to).toBe(0.6);
  });

  it("cuts a new window when the press lands outside it", () => {
    const drag = beginScrubberDrag(0.8, WINDOW);

    expect(drag.mode).toBe("select");
    expect(drag.from).toBe(0.8);
    expect(drag.to).toBe(0.8);
  });

  it("still cuts a window when the whole session is already shown", () => {
    // An un-zoomed strip is "inside the window" everywhere, so panning there
    // would leave no press that can select anything.
    const drag = beginScrubberDrag(0.5, {
      windowFrom: 0,
      windowTo: 1,
      isWindowed: false,
    });

    expect(drag.mode).toBe("select");
  });
});

describe("advanceScrubberDrag", () => {
  it("moves a panned window without changing its width", () => {
    const moved = advanceScrubberDrag(beginScrubberDrag(0.5, WINDOW), 0.7);

    expect(moved.from).toBeCloseTo(0.6, 10);
    expect(moved.to).toBeCloseTo(0.8, 10);
  });

  it("measures every frame from the press, so a pan cannot compound", () => {
    const start = beginScrubberDrag(0.5, WINDOW);
    const once = advanceScrubberDrag(start, 0.7);
    const twice = advanceScrubberDrag(once, 0.7);

    expect(twice.from).toBeCloseTo(once.from, 10);
    expect(twice.to).toBeCloseTo(once.to, 10);
  });

  it("stops a pan at the end of the axis instead of squashing it", () => {
    const moved = advanceScrubberDrag(beginScrubberDrag(0.5, WINDOW), 1);

    expect(moved.to).toBeCloseTo(1, 10);
    expect(moved.to - moved.from).toBeCloseTo(0.2, 10);
  });

  it("resizes a selection rather than moving it", () => {
    const moved = advanceScrubberDrag(beginScrubberDrag(0.8, WINDOW), 0.9);

    expect(moved.from).toBe(0.8);
    expect(moved.to).toBe(0.9);
  });
});
