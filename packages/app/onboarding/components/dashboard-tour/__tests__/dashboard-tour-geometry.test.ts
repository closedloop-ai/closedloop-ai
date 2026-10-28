/**
 * ISS-8351 / PLN-1875 Step 2: the spotlight arithmetic, lifted out of the tour
 * so it can be exercised without mounting it. Every number here is one a
 * misplaced ring or a scrolled-past anchor would come from.
 */

import { describe, expect, it } from "vitest";
import {
  anchorScrollTop,
  getScrollParent,
  measureRect,
  type Rect,
  SPOTLIGHT_PAD,
  skipTranslation,
  spotlightHole,
} from "../dashboard-tour-geometry";

const ANCHOR: Rect = { top: 100, left: 40, width: 200, height: 60 };

describe("spotlightHole", () => {
  it("grows the anchor by the pad on every side", () => {
    expect(spotlightHole(ANCHOR)).toEqual({
      top: ANCHOR.top - SPOTLIGHT_PAD,
      left: ANCHOR.left - SPOTLIGHT_PAD,
      width: ANCHOR.width + SPOTLIGHT_PAD * 2,
      height: ANCHOR.height + SPOTLIGHT_PAD * 2,
    });
  });

  it("has no hole to cut when nothing was measured", () => {
    // The caller renders a full-dim scrim on `null` rather than a ring around
    // the top-left corner, so an unmeasured anchor must not become a rect.
    expect(spotlightHole(null)).toBeNull();
  });

  it("has no hole to cut for an anchor that measured as zero", () => {
    // The case a user actually hits: a row that unmounts mid-step is still the
    // element the measure interval holds, and a detached node measures 0x0
    // rather than going null. Padded, that is a 16x16 ring at (-8, -8) — a lit
    // corner of the viewport under a 9999px scrim.
    expect(spotlightHole({ top: 0, left: 0, width: 0, height: 0 })).toBeNull();
  });

  it("has no hole to cut for a collapsed anchor that still reports a position", () => {
    // A row collapsed to zero height keeps its `top`/`left`, so the zero check
    // has to be on the dimensions, not on the whole rect being blank.
    expect(
      spotlightHole({ top: 240, left: 40, width: 200, height: 0 })
    ).toBeNull();
  });
});

describe("anchorScrollTop", () => {
  it("leaves headroom above the anchor so a sticky header cannot cover it", () => {
    const top = anchorScrollTop({
      containerScrollTop: 300,
      containerTop: 80,
      anchorTop: 500,
    });

    // 300 + (500 - 80) = 720 puts the anchor flush against the container top;
    // the headroom is what keeps it clear of the header above it.
    expect(top).toBeLessThan(720);
    expect(top).toBeGreaterThan(0);
  });

  it("never asks for a negative scroll position", () => {
    // An anchor already at the top of a container scrolled to 0 computes a
    // negative target; `scrollTo` would clamp it, but the floor keeps the
    // measured re-scroll from fighting that clamp on every tick.
    expect(
      anchorScrollTop({
        containerScrollTop: 0,
        containerTop: 100,
        anchorTop: 100,
      })
    ).toBe(0);
  });
});

describe("skipTranslation", () => {
  it("offsets centre to centre, so the callout lands on the dock button", () => {
    const callout: Rect = { top: 100, left: 100, width: 200, height: 100 };
    const target: Rect = { top: 400, left: 500, width: 40, height: 40 };

    // callout centre (200, 150) -> target centre (520, 420).
    expect(skipTranslation(callout, target)).toEqual({ dx: 320, dy: 270 });
  });
});

describe("getScrollParent", () => {
  it("skips ancestors that do not scroll and returns the one that does", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "scroll";
    const passthrough = document.createElement("div");
    passthrough.style.overflowY = "visible";
    const anchor = document.createElement("div");
    scroller.append(passthrough);
    passthrough.append(anchor);
    document.body.append(scroller);

    try {
      expect(getScrollParent(anchor)).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("reports no scroll parent when the page itself is the scroller", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);

    try {
      // `null` is what makes the tour skip the scroll and measure in place.
      expect(getScrollParent(anchor)).toBeNull();
    } finally {
      anchor.remove();
    }
  });
});

describe("measureRect", () => {
  it("narrows the element rect to the four values the spotlight uses", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () =>
      ({
        top: 12,
        left: 34,
        width: 56,
        height: 78,
        right: 90,
        bottom: 90,
        x: 34,
        y: 12,
      }) as DOMRect;

    expect(measureRect(element)).toEqual({
      top: 12,
      left: 34,
      width: 56,
      height: 78,
    });
  });
});
