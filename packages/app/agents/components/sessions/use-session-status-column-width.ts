"use client";

import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** All row grids share the widest visible status, including the cell padding. */
export function useSessionStatusColumnWidth(
  root: RefObject<HTMLDivElement | null>
) {
  const [width, setWidth] = useState(0);
  const measuredRef = useRef(0);
  // Run after each commit: pagination, flags and status updates can all replace
  // the rendered badges without changing the containing element.
  useLayoutEffect(() => {
    const cells = root.current?.querySelectorAll<HTMLElement>(
      '[data-column-id="status"][role="cell"], [data-column-id="status"][role="gridcell"]'
    );
    if (!cells?.length) {
      return;
    }
    const measure = () => {
      let largest = 0;
      for (const cell of cells) {
        const content = cell.firstElementChild;
        if (!content) {
          continue;
        }
        const style = getComputedStyle(cell);
        largest = Math.max(
          largest,
          contentExtent(content) +
            lengthPx(style.paddingLeft) +
            lengthPx(style.paddingRight) +
            lengthPx(style.borderLeftWidth) +
            lengthPx(style.borderRightWidth)
        );
      }
      const next = Math.ceil(largest);
      // Only publish a CHANGED measurement. This effect has no dependency array
      // — it has to re-measure after every commit, because pagination and status
      // updates replace the badges without replacing the container — so an
      // unconditional `setWidth` costs the whole surface a second render pass on
      // every commit (ISS-9556's budget), even when the answer never moved.
      if (next === measuredRef.current) {
        return;
      }
      measuredRef.current = next;
      setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    for (const cell of cells) {
      if (cell.firstElementChild) {
        observer.observe(cell.firstElementChild);
      }
    }
    return () => observer.disconnect();
  });
  return width;
}

/**
 * The badge's own width, NOT the box it currently occupies. The V2 grid cell is
 * `overflow-hidden` with `[&>*]:min-w-0`, so a badge wider than the column is a
 * flex item that has already shrunk: its border box measures the column this
 * hook is trying to widen, which would pin the column to whatever it already is
 * and never grow it. `scrollWidth` is the unshrunk content; the rect still wins
 * where nothing clips and the fractional width is the more precise of the two.
 */
function contentExtent(content: Element): number {
  return Math.max(content.scrollWidth, content.getBoundingClientRect().width);
}

function lengthPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
