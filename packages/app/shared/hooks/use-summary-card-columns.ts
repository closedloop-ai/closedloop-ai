"use client";

import {
  gridTierQuery,
  matchesGridTier,
} from "@repo/app/shared/lib/summary-card-grid-tier";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * The CSS custom property a summary strip publishes its per-card width floor
 * on. Written by `SummaryCardRow` from its `minWidth` prop and read back here,
 * so the column derivation measures against the SAME floor the card widths and
 * the `auto-fit` fallback template use — there is no second copy of 260 to
 * drift.
 */
export const SUMMARY_CARD_MIN_PROPERTY = "--summary-card-min";

/** The grid property this hook owns on the row element. */
const GRID_TEMPLATE_COLUMNS_PROPERTY = "grid-template-columns";

/**
 * The most empty cells a strip's FINAL row may carry.
 *
 * One is the natural rhythm of an odd count in an even rank (five cards in
 * three columns close as 3 + 2). Two or more reads as a broken row: at the
 * default desktop window `auto-fit` picks four columns for a five-card strip
 * and leaves the fifth card alone against THREE dead cells — the FEA-2935
 * orphan at a quarter width instead of a half (ISS-4966).
 */
const MAX_TRAILING_EMPTY_CELLS = 1;

/**
 * Measure before paint so the derived rank is already in place in the first
 * painted frame rather than landing a frame later as a visible reflow. React
 * never runs a layout effect on the server, so fall back to `useEffect` there.
 */
const useMeasureEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;

/** Parse a resolved CSS length, or `null` when it is absent/not a length. */
function readLengthPx(value: string | null | undefined): number | null {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Choose how many columns a summary strip of `cardCount` cards should lay out
 * in, given the width it actually has (ISS-4966).
 *
 * `repeat(auto-fit, minmax(--summary-card-min, 1fr))` maximises columns, which
 * is the wrong objective for a strip of a known, small cardinality: it happily
 * picks a rank that strands the last card. This picks the WIDEST rank that both
 * fits at the shared floor and closes its final row with at most
 * {@link MAX_TRAILING_EMPTY_CELLS} empty cell — so a five-card strip renders
 * five across once five genuinely fit, 3 + 2 below that, and never 4 + 1.
 *
 * Returns `null` when the inputs cannot describe a layout (an unmeasured row, a
 * zero width, a missing floor). That is "unknown", not a guess: the caller
 * removes its published template and the row's own `auto-fit` class governs,
 * rather than committing to a rank derived from a width nobody measured.
 */
export function resolveSummaryCardColumns({
  availableWidth,
  cardCount,
  cardMinWidth,
  columnGap,
}: {
  /** The row's content-box inline size, in px. */
  availableWidth: number;
  /** How many cards the row actually renders. */
  cardCount: number;
  /** The published `--summary-card-min` floor, in px. */
  cardMinWidth: number;
  /** The row's resolved `column-gap`, in px. */
  columnGap: number;
}): number | null {
  const inputsUsable =
    Number.isFinite(availableWidth) &&
    availableWidth > 0 &&
    Number.isInteger(cardCount) &&
    cardCount > 0 &&
    Number.isFinite(cardMinWidth) &&
    cardMinWidth > 0 &&
    Number.isFinite(columnGap) &&
    columnGap >= 0;
  if (!inputsUsable) {
    return null;
  }
  // How many whole floor-width cards the row holds, counting the gutters
  // between them — the same arithmetic `auto-fit` performs.
  const fits = Math.floor(
    (availableWidth + columnGap) / (cardMinWidth + columnGap)
  );
  // `fits` floors at 1: a row too narrow for even one floor-width card still
  // lays out in one full-bleed column, which is exactly what the `auto-fit`
  // template it replaces does there. Never a rank narrower than the cards fit.
  const widest = Math.min(cardCount, Math.max(1, fits));
  for (let columns = widest; columns > 1; columns--) {
    const trailingEmptyCells = (columns - (cardCount % columns)) % columns;
    if (trailingEmptyCells <= MAX_TRAILING_EMPTY_CELLS) {
      return columns;
    }
  }
  // A single column always closes flush, so the walk above can only fall
  // through to it.
  return 1;
}

/**
 * Publish an explicit `grid-template-columns` on a grid-mode `SummaryCardRow`
 * so its cards lay out in a rank that closes its final row (ISS-4966).
 *
 * ## Why this is measured rather than expressed in CSS
 *
 * The rule is "skip the column count that strands the last card", and for a
 * five-card strip that means jumping from five columns straight to three as the
 * row narrows past the five-across width. A `minmax()` floor built from
 * `calc()`/`min()`/`max()` is a continuous, non-decreasing function of the row's
 * width, and the rank it produces would have to DROP its floor discontinuously
 * at that crossover — so no arithmetic template can express it. `repeat()` takes
 * an `<integer>`, not a `calc()`, so the count cannot be computed inline either.
 *
 * The two CSS-only routes left are viewport media queries — the wrong tool, and
 * the cause of ISS-4787: `xl` says nothing about content width once the 16rem
 * nav rail is subtracted — and container queries, which need a wrapper element
 * (an element cannot query itself) plus a second static layout to hold the
 * flag-off state, in a stylesheet that is shrink-only. Measuring the row is
 * container-relative by construction, needs no DOM change, and is the mechanism
 * the sibling label-baseline reservation on this same row already uses.
 *
 * ## Why the card count comes from the DOM
 *
 * `React.Children.count` reports 3 for the five-card Sessions strip, because one
 * child is a fragment of three cards. The rendered element children ARE the grid
 * cells, so counting them is exact for every consumer with no per-call-site
 * cardinality prop to keep in sync — and a `MutationObserver` catches cards
 * mounting or unmounting (a strip whose gated cards appear on sign-in).
 *
 * When `enabled` is false the hook observes nothing and writes nothing, so the
 * row's own `auto-fit` class governs and the strip is byte-identical to before.
 */
export function useSummaryCardColumns(
  enabled: boolean,
  rowRef: RefObject<HTMLDivElement | null>,
  /**
   * ISS-5068: the per-card floor the row is currently publishing as
   * `--summary-card-min`, in px. The hook READS that property inside `measure`,
   * so a floor that moves has to force a fresh measurement, and the effect below
   * would not otherwise re-run, because `enabled` / `measure` / `rowRef` are all
   * unchanged when only the floor moves. That happens for real: the ISS-5149
   * width tier resolves a different density as a live row crosses a track
   * boundary, republishing `--summary-card-min` on an already-mounted
   * derivation, and a host can move its explicit `minWidth` the same way.
   * Passing it here makes the coupling a declared dependency instead of relying
   * on the incidental `ResizeObserver` fire that the density class's unrelated
   * height change happens to produce today.
   *
   * Optional, and inert when omitted: a caller that never varies its floor keeps
   * the previous two-argument behavior byte-for-byte.
   */
  minWidthPx?: number
): void {
  // The last template written. Re-applying an unchanged value would resize the
  // row, which re-notifies the observer that produced it; comparing first makes
  // the pass idempotent instead of relying on that loop settling.
  const appliedTemplateRef = useRef<string | null>(null);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    // Below `md` the row's own `grid-cols-2` class owns the layout (see
    // GRID_TIER_MEDIA_QUERY). Clear anything a wider frame published rather
    // than leaving an inline template overriding that class.
    if (!matchesGridTier()) {
      if (appliedTemplateRef.current !== null) {
        appliedTemplateRef.current = null;
        row.style.removeProperty(GRID_TEMPLATE_COLUMNS_PROPERTY);
      }
      return;
    }
    const computed = getComputedStyle(row);
    // The floor is published inline by the row itself; fall back to the
    // resolved value so a host that overrides it downstream is still honored.
    const cardMinWidth =
      readLengthPx(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)) ??
      readLengthPx(computed.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY));
    // `clientWidth` is the padding box; the tracks lay out in the content box.
    const availableWidth =
      row.clientWidth -
      (readLengthPx(computed.paddingLeft) ?? 0) -
      (readLengthPx(computed.paddingRight) ?? 0);
    const columns =
      cardMinWidth === null
        ? null
        : resolveSummaryCardColumns({
            availableWidth,
            cardCount: row.children.length,
            cardMinWidth,
            columnGap: readLengthPx(computed.columnGap) ?? 0,
          });
    const template =
      columns === null ? "" : `repeat(${columns}, minmax(0, 1fr))`;
    if (appliedTemplateRef.current === template) {
      return;
    }
    appliedTemplateRef.current = template;
    if (template === "") {
      row.style.removeProperty(GRID_TEMPLATE_COLUMNS_PROPERTY);
      return;
    }
    row.style.setProperty(GRID_TEMPLATE_COLUMNS_PROPERTY, template);
  }, [rowRef]);

  useMeasureEffect(() => {
    const row = rowRef.current;
    if (!(enabled && row)) {
      return;
    }
    measure();

    // Both observers exist in every browser and the Electron renderer, but a
    // bare jsdom environment may not polyfill them. Treat them as progressive
    // enhancement: the synchronous pass above already ranked the current
    // content, so a missing observer degrades to a one-shot measurement rather
    // than throwing during mount.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(row);

    // Cards mounting or unmounting changes the cardinality without changing the
    // row's width, and the rank is a function of both.
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    mutationObserver?.observe(row, { childList: true });

    // Crossing `md` hands the layout between this derivation and the row's
    // `grid-cols-2` class. `ResizeObserver` usually fires too (the row's width
    // changes with the viewport), but not when the row is inside a fixed-width
    // pane, so the tier is watched directly rather than inferred.
    const tierQuery = gridTierQuery();
    tierQuery?.addEventListener("change", measure);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      tierQuery?.removeEventListener("change", measure);
      // Leave no stale rank behind when the row stops deriving one.
      row.style.removeProperty(GRID_TEMPLATE_COLUMNS_PROPERTY);
      appliedTemplateRef.current = null;
    };
    // `minWidthPx` is a dependency even though nothing in the effect body reads
    // it: it is the caller's declaration that the floor `measure` reads from the
    // DOM has moved, and re-running the effect is what re-measures against it.
  }, [enabled, measure, minWidthPx, rowRef]);
}
