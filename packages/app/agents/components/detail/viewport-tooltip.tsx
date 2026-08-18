"use client";

import { clamp } from "@repo/api/src/utils/math";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Shared viewport-anchored tooltip infrastructure for the session-detail
 * activity surfaces. Extracted so every horizontal strip stacked in the detail
 * header (the Session Timeline cost bars, its event dots, and the FEA-3705
 * activity-segment strip below them) can render the SAME styled `.sd3-tip`
 * popover instead of one strip using the browser's native `title` box. Two
 * stacked strips must not read as two tooltip treatments.
 */

const TOOLTIP_VIEWPORT_PADDING = 12;
const TOOLTIP_ANCHOR_GAP = 8;

export type TooltipAnchor = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

export type ViewportTooltipPlacement = "above" | "below";

/** The class the column-height hit target is published under (ISS-5548). */
const REACH_CLASS = "reach";

/**
 * The anchor for a Session Timeline control's tooltip — a cost bar or a dot.
 *
 * ISS-5548 (design review): with the column hit target on, a `.reach` bar's
 * clickable and outlined region is its `::before` — the full column — but
 * `getBoundingClientRect()` reports the element's own border box and ignores an
 * overflowing pseudo-element. Anchoring to that box put the readout down at the
 * column floor while the outline lit up around a pointer as much as ~55px above
 * it, on exactly the quiet buckets this flag exists to make reachable. The
 * outline is the affordance now, so the label hangs off it.
 *
 * The extended rect is derived from the DOM rather than restated: `.sd3-bars2`
 * is `align-items: flex-end`, so every bar's bottom edge is already ON the
 * column floor and only the top has to move — up to the strip's content-box top,
 * which is what `::before`'s `height: var(--sd3-bars2-inner-height)` resolves
 * to. Reading it back off the laid-out parent means the tooltip cannot drift
 * from the box if those custom properties change.
 *
 * Without `.reach` — flag off, anchorless bucket, a disabled strip, or any dot
 * on the rail below, none of which carry the class — this is the element's own
 * rect, unchanged. That is why the dot rail shares this helper rather than
 * keeping a second one: one call answers "where does this control's readout
 * hang", and a tall bar's column and bar nearly coincide anyway, so the visible
 * effect is on the short bars alone.
 */
export function getTimelineTooltipAnchor(control: HTMLElement): TooltipAnchor {
  const anchor = getTooltipAnchor(control);
  const strip = control.parentElement;
  if (!(strip && control.classList.contains(REACH_CLASS))) {
    return anchor;
  }
  const stripRect = strip.getBoundingClientRect();
  // An unlaid-out strip reports an all-zero rect (jsdom, and the frame before
  // first layout in a real browser). Deriving a top from it would anchor the
  // readout at the viewport ceiling, which is worse than the defect being
  // fixed — so the bar's own rect stands until the strip has real geometry.
  if (stripRect.height <= 0) {
    return anchor;
  }
  const paddingTop = Number.parseFloat(
    getComputedStyle(strip).paddingTop || "0"
  );
  const top = stripRect.top + (Number.isFinite(paddingTop) ? paddingTop : 0);
  // The hit box only ever extends a bar UPWARD, so a bar already taller than
  // the reach box must not be shrunk or inverted by this.
  if (!(top < anchor.top)) {
    return anchor;
  }
  return { ...anchor, height: anchor.bottom - top, top };
}

/** Snapshot the anchor element's viewport rect for a fixed-position tooltip. */
export function getTooltipAnchor(element: HTMLElement): TooltipAnchor {
  const rect = element.getBoundingClientRect();
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  };
}

/**
 * Position a fixed tooltip against an anchor rect: rendered hidden first, then
 * measured and flipped above/below and clamped into the viewport on layout.
 */
export function useViewportTooltipStyle(anchor: TooltipAnchor) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>(() =>
    getHiddenTooltipStyle(anchor)
  );
  const [placement, setPlacement] = useState<ViewportTooltipPlacement>("below");

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const measured = getMeasuredTooltipStyle(anchor, rect.width, rect.height);
    setPlacement(measured.placement);
    setStyle(measured.style);
  }, [anchor]);

  return { placement, ref, style };
}

/** Portal a tooltip to `document.body` so it escapes any clipping ancestor. */
export function ViewportTooltipPortal({
  children,
}: Readonly<{ children: ReactNode }>) {
  if (globalThis.document === undefined) {
    return null;
  }

  return createPortal(children, globalThis.document.body);
}

function getHiddenTooltipStyle(anchor: TooltipAnchor): CSSProperties {
  return {
    bottom: "auto",
    left: anchor.left,
    position: "fixed",
    top: anchor.bottom + TOOLTIP_ANCHOR_GAP,
    transform: "none",
    visibility: "hidden",
  };
}

function getMeasuredTooltipStyle(
  anchor: TooltipAnchor,
  tooltipWidth: number,
  tooltipHeight: number
): { placement: ViewportTooltipPlacement; style: CSSProperties } {
  const viewportWidth = globalThis.innerWidth;
  const viewportHeight = globalThis.innerHeight;
  const maxLeft = Math.max(
    TOOLTIP_VIEWPORT_PADDING,
    viewportWidth - tooltipWidth - TOOLTIP_VIEWPORT_PADDING
  );
  const centerLeft = anchor.left + anchor.width / 2 - tooltipWidth / 2;
  const left = clamp(centerLeft, TOOLTIP_VIEWPORT_PADDING, maxLeft);
  const topAbove = anchor.top - tooltipHeight - TOOLTIP_ANCHOR_GAP;
  const topBelow = anchor.bottom + TOOLTIP_ANCHOR_GAP;
  const placement: ViewportTooltipPlacement =
    topAbove >= TOOLTIP_VIEWPORT_PADDING ? "above" : "below";
  const rawTop = placement === "above" ? topAbove : topBelow;
  const maxTop = Math.max(
    TOOLTIP_VIEWPORT_PADDING,
    viewportHeight - tooltipHeight - TOOLTIP_VIEWPORT_PADDING
  );

  return {
    placement,
    style: {
      bottom: "auto",
      left,
      maxHeight: `calc(100vh - ${TOOLTIP_VIEWPORT_PADDING * 2}px)`,
      position: "fixed",
      top: clamp(rawTop, TOOLTIP_VIEWPORT_PADDING, maxTop),
      transform: "none",
      visibility: "visible",
    },
  };
}
