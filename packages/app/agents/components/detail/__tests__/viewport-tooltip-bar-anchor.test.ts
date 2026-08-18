import { describe, expect, it } from "vitest";
import { getTimelineTooltipAnchor } from "../viewport-tooltip";

/**
 * ISS-5548 (design review): with the column hit target on, a `.reach` bar's
 * outlined and clickable region is its `::before` — the full column — but
 * `getBoundingClientRect()` reports the element's own border box and ignores an
 * overflowing pseudo-element. The tooltip therefore appeared at the column floor
 * while the outline lit up around a pointer as much as ~55px above it, on
 * exactly the quiet buckets the flag exists to make reachable.
 *
 * jsdom does no layout, so both rects are stubbed. What is under test is the
 * derivation — that the anchor's bottom stays on the column floor while its top
 * rises to the strip's content-box top — not the browser's box model.
 */

const STRIP_TOP = 100;
const STRIP_PADDING_TOP = 15;
/** Where `::before` starts: `bottom: 0`, `height: --sd3-bars2-inner-height`. */
const CONTENT_TOP = STRIP_TOP + STRIP_PADDING_TOP;
const COLUMN_FLOOR = 177;

function stubRect(element: HTMLElement, top: number, bottom: number): void {
  element.getBoundingClientRect = () =>
    ({
      bottom,
      height: bottom - top,
      left: 10,
      right: 22,
      top,
      width: 12,
      x: 10,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function mountBar(className: string, barTop: number): HTMLElement {
  const strip = document.createElement("div");
  strip.style.paddingTop = `${STRIP_PADDING_TOP}px`;
  stubRect(strip, STRIP_TOP, COLUMN_FLOOR + 1);

  const bar = document.createElement("button");
  bar.className = className;
  stubRect(bar, barTop, COLUMN_FLOOR);
  strip.append(bar);
  document.body.append(strip);
  return bar;
}

describe("getTimelineTooltipAnchor", () => {
  it("extends a short .reach bar's anchor up to the outlined column", () => {
    // A ~6px sliver: the bar the reader is most likely to probe, and the one
    // whose readout used to land 55px below the outline.
    const bar = mountBar("sd3-bar2 reach", COLUMN_FLOOR - 6);
    const anchor = getTimelineTooltipAnchor(bar);

    expect(anchor.top).toBe(CONTENT_TOP);
    expect(anchor.height).toBe(COLUMN_FLOOR - CONTENT_TOP);
    // The floor and the horizontal extent are the bar's own — only the top moves.
    expect(anchor.bottom).toBe(COLUMN_FLOOR);
    expect(anchor.left).toBe(10);
    expect(anchor.width).toBe(12);
  });

  it("leaves a bar without .reach on its own rect", () => {
    // Flag off, anchorless bucket, or a disabled strip: no hit box exists, so
    // moving the tooltip would point at a region that is not there.
    const bar = mountBar("sd3-bar2", COLUMN_FLOOR - 6);
    const anchor = getTimelineTooltipAnchor(bar);

    expect(anchor.top).toBe(COLUMN_FLOOR - 6);
    expect(anchor.height).toBe(6);
  });

  it("never shrinks a bar already taller than the reach box", () => {
    // The hit box only ever extends a bar UPWARD. A bar taller than the column
    // content box (or an unlaid-out rect) must not be clipped or inverted.
    const bar = mountBar("sd3-bar2 reach", CONTENT_TOP - 20);
    const anchor = getTimelineTooltipAnchor(bar);

    expect(anchor.top).toBe(CONTENT_TOP - 20);
    expect(anchor.height).toBe(COLUMN_FLOOR - (CONTENT_TOP - 20));
  });

  it("falls back to the bar rect when the strip reports no layout", () => {
    // jsdom (and a not-yet-laid-out strip) return all-zero rects; the anchor
    // must stay the bar's own rather than collapsing to a zero-height box.
    const bar = document.createElement("button");
    bar.className = "sd3-bar2 reach";
    stubRect(bar, COLUMN_FLOOR - 6, COLUMN_FLOOR);
    const orphanStrip = document.createElement("div");
    stubRect(orphanStrip, 0, 0);
    orphanStrip.append(bar);

    expect(getTimelineTooltipAnchor(bar).top).toBe(COLUMN_FLOOR - 6);
  });
});
