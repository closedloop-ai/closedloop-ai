"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

// Measure BEFORE the browser paints, so a layout that adapts to its container
// adapts in the first painted frame instead of shifting one frame later. React
// never runs a layout effect on the server, so fall back to `useEffect` there —
// the measurement is a no-op without a DOM anyway, and this avoids React's
// "useLayoutEffect does nothing on the server" warning during SSR.
const useMeasureEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;

// Wide default for every state that has no real measurement — SSR, and a
// container that measures zero (detached, `display:none`, a keep-alive view
// parked off-screen) — so those render the expanded layout, matching the
// historical desktop behavior. Both write paths below honor that: neither the
// seed nor the observer reports a zero box, so `width` holds this default (or
// the last real measurement) rather than collapsing to 0 and dragging a
// breakpoint-picking caller onto its narrow layout. jsdom has no layout, so its
// `getBoundingClientRect` is zero unless a test stubs it, and component tests
// keep seeing this default until the ResizeObserver shim (see the app vitest
// setup) reports a box.
const DEFAULT_WIDTH = 1024;

/**
 * Measures the observed element's content-box width and re-renders when it
 * changes. Returns a ref to attach to the container plus its current width in
 * px. Used by responsive layouts that switch on their own container width
 * (a `@container`-style breakpoint) rather than the viewport, so a component
 * nested in a narrow pane adapts even when the window is wide.
 *
 * The returned `ref` is a CALLBACK ref, and the observed element is held in
 * state rather than in a `useRef`, so the measure effect keys off the element
 * itself instead of running once on mount. That is what makes late attachment
 * and replacement work: a caller that renders the measured wrapper
 * conditionally — `GridTable` only wraps when `cardRender` or
 * `snapFoldToColumns` is on — attaches the node AFTER the first commit, and a
 * mount-only effect would have already run against a null ref, so no observer
 * would ever be created and the width would sit at the default forever. Keying
 * on the element also disconnects the old observer and re-measures when the
 * node is swapped for a different one.
 */
export function useContainerWidth<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  width: number;
  measured: boolean;
} {
  const [element, setElement] = useState<T | null>(null);
  const ref = useCallback((node: T | null) => {
    setElement(node);
  }, []);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  // Whether `width` is a REAL measurement rather than the wide default above
  // (ISS-4889). A layout that adjusts itself to the true available width — as
  // opposed to one picking between two layouts, which wants the wide default so
  // it never flashes the narrow one — reads this and stays on its unadjusted
  // path until a real width exists. Stays `false` on SSR and wherever the
  // element measures zero, so those degrade to the unadjusted layout instead of
  // adjusting against a guess.
  const [measured, setMeasured] = useState(false);

  useMeasureEffect(() => {
    if (!element) {
      return;
    }
    // Seed from a synchronous read so the first PAINTED frame already has the
    // real width; without it the container renders once at DEFAULT_WIDTH and
    // visibly reflows when the observer reports. A zero width (detached or
    // display:none) is not a measurement — leave `measured` false so callers
    // keep their unadjusted layout rather than adapt to nothing.
    //
    // Measured as a CONTENT box, the same box the observer below reports, so
    // the two paths can never hand the caller two different numbers under one
    // name (see `measureContentBoxWidth`).
    const initialWidth = measureContentBoxWidth(element);
    if (initialWidth > 0) {
      setWidth(initialWidth);
      setMeasured(true);
    }
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      // Same rule as the seed above, applied to BOTH pieces of state: a zero
      // box is not a measurement. The observer fires with `width: 0` for a
      // container that is detached or parked off-screen (a keep-alive view),
      // and reporting that zero would do more than leave `measured` false — a
      // caller picking between layouts on a breakpoint (`GridTable`'s card
      // fallback tests `containerWidth < CARD_FALLBACK_BREAKPOINT`) would read
      // 0, fall below every breakpoint, and render the NARROW layout for a
      // container that is merely hidden, then visibly swap back when it is
      // shown again. Holding the last real width — the wide default until one
      // exists — is what makes the zero-box contract above true on this path
      // as well as on the seed.
      if (entry.contentRect.width > 0) {
        setWidth(entry.contentRect.width);
        setMeasured(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref, width, measured };
}

/**
 * The element's CONTENT-box width — the same box `ResizeObserver` reports in
 * `entry.contentRect.width`, so the synchronous seed and the observer agree.
 *
 * `getBoundingClientRect().width` is the BORDER box. For an observed element
 * with horizontal padding or a border the two disagree, and the caller gets no
 * signal which one it is holding. That is not academic for a width-adjusting
 * caller: `GridTable`'s fold fit turns the number straight into rendered
 * geometry, so a border-box width would snap the fold to a boundary sitting
 * `padding-x` px INSIDE the real viewport edge — putting a column back across
 * the fold, silently, which is the exact condition ISS-4889 exists to remove.
 *
 * Subtracting the computed horizontal padding and border is what makes the two
 * agree; `clientWidth` would still include padding (and is integer-rounded,
 * losing the sub-pixel the fold fit floors against). Each component degrades
 * independently to 0 when the computed style reports no parseable length — a
 * shorthand-only border in jsdom reports `""`, and treating that as `NaN` would
 * discard a padding that WAS readable and hand back the border box. The result
 * is clamped at 0 so a caller never sees a negative width.
 */
function measureContentBoxWidth(element: HTMLElement): number {
  const borderBoxWidth = element.getBoundingClientRect().width;
  const style = globalThis.getComputedStyle(element);
  const horizontalInset =
    toFiniteLengthPx(style.paddingLeft) +
    toFiniteLengthPx(style.paddingRight) +
    toFiniteLengthPx(style.borderLeftWidth) +
    toFiniteLengthPx(style.borderRightWidth);
  return Math.max(0, borderBoxWidth - horizontalInset);
}

/** A computed CSS length in px, or 0 when it declares no parseable length. */
function toFiniteLengthPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
