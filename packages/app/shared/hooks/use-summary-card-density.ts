"use client";

import {
  gridTierQuery,
  matchesGridTier,
} from "@repo/app/shared/lib/summary-card-grid-tier";
import {
  CardDensity,
  type CardDensity as CardDensityValue,
} from "@repo/design-system/components/ui/card-density";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/**
 * Measure before paint so the first painted frame already carries the resolved
 * tier rather than flipping density a frame later as a visible reflow. React
 * never runs a layout effect on the server, so fall back to `useEffect` there.
 */
const useMeasureEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;

/**
 * Whether `cardCount` cards fit on ONE rank at `cardMinWidth`, in a track of
 * `trackWidth`, separated by `columnGap` gutters.
 *
 * This is the whole question a density tier answers, and it is the same
 * arithmetic in both of the row's layout modes: in grid mode a rank that does
 * not fit WRAPS, in flex mode it OVERFLOWS behind horizontal scroll. Either way
 * the strip stops reading as one band.
 */
function fitsOneRank({
  cardCount,
  cardMinWidth,
  columnGap,
  trackWidth,
}: {
  cardCount: number;
  cardMinWidth: number;
  columnGap: number;
  trackWidth: number;
}): boolean {
  return cardCount * cardMinWidth + (cardCount - 1) * columnGap <= trackWidth;
}

/**
 * Choose the density a summary strip should lay out at, from the width of the
 * TRACK it is laid into (ISS-5149).
 *
 * ## Why the track and not the card
 *
 * Reviewers on #4358 proposed keying the card INTERIOR on the resulting card
 * width. That cannot work: card width is an OUTPUT of the floor
 * (`minmax(var(--summary-card-min), 1fr)`), so a rule from card width back to
 * the floor is a feedback loop — it either oscillates or degenerates to a flat
 * result. The track is the container the cards are laid INTO. Its inline size is
 * set by the page's chrome, not by anything this tier decides, so it is an input
 * and the derivation is stable. (Density changes a card's HEIGHT, never the
 * row's own width, which is what closes the loop by construction.)
 *
 * It is also not a viewport breakpoint. A `xl:` tier says nothing about content
 * width once a 16rem nav rail and the desktop pane are subtracted — that is
 * exactly the mistake ISS-4787 was filed about, and a viewport-keyed tier would
 * lie at the very widths ISS-5068 was reported at.
 *
 * ## The rule
 *
 * Compact density exists to buy a rank that the comfortable floor cannot close.
 * So it is applied WHERE IT EARNS ITS KEEP, and nowhere else:
 *
 *  - the cards already fit at the comfortable floor  → comfortable;
 *  - they do not, but they fit at the compact floor  → compact;
 *  - they fit at neither                            → comfortable.
 *
 * The last row is the one worth stating out loud. Below the compact floor's
 * one-rank width the strip wraps (or scrolls) whatever the interior does, so a
 * tighter card buys nothing and simply hands the reader a cramped card as well
 * as a broken band. Degrading back to the roomier card there is the deliberate
 * degradation ISS-5149 asks for, not a fallback.
 *
 * ## The FIXED-RANK regime (`fixedColumns`)
 *
 * That whole rule assumes the rank size is what is in play — true at the `md+`
 * auto-fit grid, where a rank that does not fit WRAPS and the cards get no
 * narrower for it. Below `md` the row pins a static `grid-cols-2` instead, and
 * there the question above is not the one the layout is asking (ISS-5366, stage
 * review): five cards never fit one rank at either floor, so the third branch
 * fired and a phone always resolved COMFORTABLE — handing the narrowest cards on
 * any surface (~163px at 375px) the roomiest interior, which is the exact
 * inversion of what compact density is for.
 *
 * So when the caller says the rank is FIXED, the question changes to the one
 * that regime actually poses: is the cell that grid hands each card wide enough
 * for the comfortable floor? Wrapping cannot buy width back here, so a cell
 * under the floor genuinely needs its interior returned.
 *
 * This does NOT reintroduce the card-width feedback loop rejected above. There,
 * card width is an OUTPUT of the published floor (`minmax(var(--summary-card-min),
 * 1fr)`), so keying on it feeds back. Under a fixed `grid-cols-2` the cell is
 * `(track - gap) / 2` — a function of the track alone, independent of whatever
 * floor this returns — so the derivation stays a one-way function of its inputs.
 *
 * Returns `null` when the inputs cannot describe a layout — an unmeasured row, a
 * zero width, a non-finite floor. That is "unknown", not a guess: the caller
 * keeps whatever density it was already using rather than committing to a tier
 * derived from a width nobody measured.
 */
export function resolveSummaryCardDensity({
  cardCount,
  columnGap,
  comfortableMinWidth,
  compactMinWidth,
  fixedColumns,
  trackWidth,
}: {
  /** How many cards the row actually renders. */
  cardCount: number;
  /** The row's resolved `column-gap`, in px. */
  columnGap: number;
  /** The per-card floor at comfortable density, in px. */
  comfortableMinWidth: number;
  /** The per-card floor at compact density, in px. */
  compactMinWidth: number;
  /**
   * The column count the row's own class PINS, when it pins one — the static
   * `grid-cols-2` a `wrapBelow` row uses below `md`. Omit it (the `md+` auto-fit
   * grid, or a non-wrapping flex row) to ask the one-rank question instead.
   */
  fixedColumns?: number;
  /** The row's content-box inline size, in px. */
  trackWidth: number;
}): CardDensityValue | null {
  const inputsUsable =
    Number.isFinite(trackWidth) &&
    trackWidth > 0 &&
    Number.isInteger(cardCount) &&
    cardCount > 0 &&
    Number.isFinite(comfortableMinWidth) &&
    comfortableMinWidth > 0 &&
    Number.isFinite(compactMinWidth) &&
    compactMinWidth > 0 &&
    Number.isFinite(columnGap) &&
    columnGap >= 0;
  if (!inputsUsable) {
    return null;
  }
  if (fixedColumns !== undefined) {
    // A pinned rank the layout will not renegotiate. An unusable count is
    // "unknown", exactly as an unmeasured track is — never a silent fall-through
    // to the one-rank question, which would answer for a layout that is not live.
    if (!(Number.isInteger(fixedColumns) && fixedColumns > 0)) {
      return null;
    }
    const cellWidth =
      (trackWidth - (fixedColumns - 1) * columnGap) / fixedColumns;
    return cellWidth >= comfortableMinWidth
      ? CardDensity.Comfortable
      : CardDensity.Compact;
  }
  if (
    fitsOneRank({
      cardCount,
      cardMinWidth: comfortableMinWidth,
      columnGap,
      trackWidth,
    })
  ) {
    return CardDensity.Comfortable;
  }
  if (
    fitsOneRank({
      cardCount,
      cardMinWidth: compactMinWidth,
      columnGap,
      trackWidth,
    })
  ) {
    return CardDensity.Compact;
  }
  return CardDensity.Comfortable;
}

/**
 * Track-width-keyed density tier for a `SummaryCardRow` (ISS-5149).
 *
 * Measures the row's own content box and returns the density
 * {@link resolveSummaryCardDensity} picks for it. Unlike this row's two sibling
 * derivations — which write a CSS custom property straight to the node — the
 * tier has to come back through React: it decides the published
 * `--summary-card-min` AND the `data-density` attribute, both of which React
 * renders. State churn is bounded by construction, since the value is one of two
 * and only a crossing writes it.
 *
 * Returns `null` until the row has been measured at least once. That is
 * "unknown", not "comfortable" — see the caller, which resolves an unmeasured
 * row to COMPACT so the strip never flashes the roomier card on the way in.
 */
export function useSummaryCardDensity(
  rowRef: RefObject<HTMLDivElement | null>,
  {
    comfortableMinWidth,
    compactMinWidth,
    belowMdColumns,
  }: {
    comfortableMinWidth: number;
    compactMinWidth: number;
    /**
     * The column count the row's own class pins BELOW `md`, for a row that pins
     * one (a `wrapBelow` row's static `grid-cols-2`). Omit it for a row whose
     * layout is negotiable at every width — a non-wrapping flex line has no
     * fixed rank to reason about, and the one-rank question stays correct there.
     */
    belowMdColumns?: number;
  }
): CardDensityValue | null {
  const [density, setDensity] = useState<CardDensityValue | null>(null);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const computed = getComputedStyle(row);
    // `clientWidth` is the padding box; the tracks lay out in the content box.
    const trackWidth =
      row.clientWidth -
      (Number.parseFloat(computed.paddingLeft) || 0) -
      (Number.parseFloat(computed.paddingRight) || 0);
    // The RENDERED element children are the cells. `React.Children.count`
    // reports 3 for the five-card Sessions strip, because one child is a
    // fragment of three cards.
    const resolved = resolveSummaryCardDensity({
      cardCount: row.children.length,
      columnGap: Number.parseFloat(computed.columnGap) || 0,
      comfortableMinWidth,
      compactMinWidth,
      // Below `md` the row's static `grid-cols-2` pins the rank, so the tier
      // asks the fixed-cell question instead of the one-rank one. Read from the
      // VIEWPORT, not the measured track: `md:` utilities are viewport media
      // queries, so a narrow pane on a wide screen is still the `md+` layout.
      fixedColumns: matchesGridTier() ? undefined : belowMdColumns,
      trackWidth,
    });
    // `null` is "not measurable", not "comfortable" — hold the last known tier
    // rather than flapping the whole strip to the roomier card because one
    // frame had no layout (a hidden pane, a bare jsdom render).
    if (resolved === null) {
      return;
    }
    setDensity((current) => (current === resolved ? current : resolved));
  }, [belowMdColumns, comfortableMinWidth, compactMinWidth, rowRef]);

  useMeasureEffect(() => {
    const row = rowRef.current;
    if (!row) {
      // Nothing to observe yet. Drop any tier a previous pass resolved rather
      // than pinning the row to a measurement of an element it no longer has.
      setDensity(null);
      return;
    }
    measure();

    // `ResizeObserver` exists in every browser and the Electron renderer, but a
    // bare jsdom environment may not polyfill it. Treat it as progressive
    // enhancement: the synchronous pass above already resolved a tier for the
    // current width, so a missing observer degrades to a one-shot measurement
    // rather than throwing during mount.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(row);

    // Cards mounting or unmounting (a strip whose gated cards appear on sign-in)
    // changes the cardinality without changing the row's width, and the tier is
    // a function of both.
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    mutationObserver?.observe(row, { childList: true });

    // Crossing `md` swaps which QUESTION the tier asks (fixed cell vs. one
    // rank), so it has to re-resolve even when the row's own box did not move.
    // `ResizeObserver` usually fires too, but not when the row sits in a
    // fixed-width pane — the same reason `useSummaryCardColumns` watches it.
    const tierQuery = gridTierQuery();
    tierQuery?.addEventListener("change", measure);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      tierQuery?.removeEventListener("change", measure);
    };
  }, [measure, rowRef]);

  return density;
}
