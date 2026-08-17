"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * The CSS custom property a summary strip publishes its measured label height
 * on. Its consumer is the row's own label-region class, which floors every
 * card's label to it — so the whole mechanism is one property written by this
 * hook and read by one class.
 */
export const SUMMARY_CARD_LABEL_MIN_PROPERTY = "--summary-card-label-min";

/** Selector for a `MetricCard`'s label region inside the row. */
const LABEL_REGION_SELECTOR = '[data-slot="card-description"]';

// Measure before paint so the derived floor is already in place in the first
// painted frame rather than landing a frame later as a visible jump. React never
// runs a layout effect on the server, so fall back to `useEffect` there — the
// measurement is a no-op without a DOM anyway, and this avoids React's
// "useLayoutEffect does nothing on the server" warning during SSR.
const useMeasureEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;

/**
 * Derive a summary strip's reserved label height from the TALLEST LABEL ACTUALLY
 * RENDERED in that row, and publish it as
 * {@link SUMMARY_CARD_LABEL_MIN_PROPERTY} on the row element (ISS-4887).
 *
 * ## The problem with a fixed line count
 *
 * ISS-4787 fixed the strip's jagged baseline by reserving TWO lines of label
 * height on the row. Two is the right number at the five-across desktop width —
 * and a guess everywhere else. Of the ten labels the two strips rendered when
 * this was written exactly one, "Non-subscription Cost", was long enough to wrap
 * at all (stage review: "LOC / $" is seven characters and never wraps), and at
 * the `wrapBelow` two-column width and in the desktop renderer's narrower pane it
 * took three lines — so the row was jagged again, *and* every card paid a taller
 * floor for the privilege. (That label has since been shortened, so today NO
 * shipped label wraps and the derived reservation is one line — which is the
 * whole point of deriving it: the mechanism did not need touching when the copy
 * changed.) It breaks again the next time a metric with a longer label is
 * added, which is the point: a reservation that is a guess about label length ×
 * card width cannot hold across widths; one derived from what is on screen can,
 * whatever the label set becomes.
 *
 * ## Why measurement rather than `subgrid`
 *
 * CSS `grid-template-rows: subgrid` is the pure-CSS expression of the same idea,
 * but it requires `MetricCard` to expose its header, value, and footer as three
 * subgrid-participating rows — restructuring a primitive that also renders the
 * Insights KPI tiles, the dashboard cards, and every solo card, in a change that
 * cannot be flag-gated without shipping two parallel internal layouts. This
 * lives entirely on the row, changes no card's DOM, and is inert (nothing
 * written, nothing read) when the flag is off.
 *
 * ## The measurement, and why it does not ratchet
 *
 * The naive version measures the label boxes and floors them to the tallest —
 * which then *becomes* every box's height, so the next measurement reads the
 * floor back as if it were natural content and the reservation can only ever
 * grow. Widening the window past the point where a label unwraps would leave the
 * strip reserving a line nothing needs any more.
 *
 * So each pass RESETS the property to zero before reading, which puts every
 * label back on its natural height for the read, and writes the fresh maximum
 * after. Both happen inside one synchronous callback — in a layout effect or a
 * `ResizeObserver` callback, i.e. before paint — so the intermediate zero is
 * never rendered. The property is written straight to the node rather than
 * through React state: no re-render, no dependency on a value the same effect
 * produces, and React leaves a custom property it does not manage alone.
 *
 * Returns the ref to attach to the row.
 *
 * ISS-5062: this used to take an `enabled` flag, because ISS-4887 rolled the
 * derivation out behind `summary-strip-label-baseline`. That flag reached 100%
 * of users, so the derivation is now unconditional and the parameter is gone
 * rather than left as a permanently-true argument. The off branch is not lost:
 * the class that reads {@link SUMMARY_CARD_LABEL_MIN_PROPERTY} declares the
 * ISS-4787 two-line floor as its CSS fallback, so every frame before the first
 * measurement — SSR, a jsdom render, an environment with no `ResizeObserver` —
 * still reserves exactly what the flag-off path reserved.
 */
export function useSummaryLabelBaseline(): {
  ref: React.RefObject<HTMLDivElement | null>;
} {
  const ref = useRef<HTMLDivElement | null>(null);

  const measure = useCallback(() => {
    const row = ref.current;
    if (!row) {
      return;
    }
    // Reset first: the floor we published last pass is ON these boxes, so
    // reading their height without clearing it would read our own output back
    // and the reservation could never shrink.
    row.style.setProperty(SUMMARY_CARD_LABEL_MIN_PROPERTY, "0px");
    let tallest = 0;
    for (const region of row.querySelectorAll<HTMLElement>(
      LABEL_REGION_SELECTOR
    )) {
      tallest = Math.max(tallest, region.getBoundingClientRect().height);
    }
    if (tallest <= 0) {
      // No labels rendered yet, or an environment with no layout (jsdom). Drop
      // the property entirely so the class's own fallback — the previous fixed
      // two-line floor — applies, rather than pinning the row to 0.
      row.style.removeProperty(SUMMARY_CARD_LABEL_MIN_PROPERTY);
      return;
    }
    // Ceil: a fractional floor would let the tallest label overflow its own
    // reservation by a sub-pixel and reintroduce the stagger this removes.
    row.style.setProperty(
      SUMMARY_CARD_LABEL_MIN_PROPERTY,
      `${Math.ceil(tallest)}px`
    );
  }, []);

  useMeasureEffect(() => {
    const row = ref.current;
    if (!row) {
      return;
    }
    measure();

    // ResizeObserver/MutationObserver exist in every browser and the Electron
    // renderer, but a bare jsdom test environment may not polyfill them. Treat
    // them as progressive enhancement: the synchronous pass above already
    // reserved against the current content, so a missing observer degrades to a
    // one-shot measurement instead of throwing during mount.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    // Observing the ROW is what catches a width change — which is the only thing
    // that can rewrap a label. Its own height changing as a result converges
    // immediately: the next pass resets, reads the same natural heights, and
    // writes the same value, so no further resize is produced.
    resizeObserver?.observe(row);

    // Cards mounting or unmounting (a strip whose gated cards appear on sign-in)
    // changes which labels exist without changing the row's width.
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    mutationObserver?.observe(row, { childList: true, subtree: true });

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      // Leave no stale reservation behind when the row unmounts.
      row.style.removeProperty(SUMMARY_CARD_LABEL_MIN_PROPERTY);
    };
  }, [measure]);

  return { ref };
}
