import { resolveSummaryCardColumns } from "@repo/app/shared/hooks/use-summary-card-columns";
import { describe, expect, it } from "vitest";

/**
 * ISS-4966: `repeat(auto-fit, minmax(--summary-card-min, 1fr))` maximises
 * columns, which is the wrong objective for a strip of a known, small
 * cardinality. At the default desktop window it resolves to FOUR columns for a
 * five-card strip, so the fifth card sits alone in a quarter-width final row
 * with three dead cells beside it.
 *
 * These exercise the derivation directly rather than a rendered row, because the
 * acceptance criterion is a statement about EVERY width ("never a final row with
 * more than one empty cell at any width from 768px up"), not about one sampled
 * window — and jsdom lays nothing out, so only the arithmetic is observable
 * there anyway. The rendered wiring is covered by
 * `summary-card-row-column-cardinality.test.tsx`.
 */

/** The shipped floor and gutter every summary strip lays out against. */
const CARD_MIN_WIDTH = 260;
const COLUMN_GAP = 16;
/** The strips this issue is about: Sessions and Branches both ship five cards. */
const FIVE_CARD_STRIP = 5;

/**
 * The default desktop strip track: a 1400px window, less the 16rem nav rail, less
 * the inset gutter, less the host's `px-4` gutter. COMPUTED, no scrollbar — the
 * real renderer measures 13px less (1099); see
 * `apps/desktop/src/shared/window-defaults.ts` for the whole chain and why both
 * numbers now have names (#4445 review). `auto-fit` picks 4 here and picked 4 at
 * 1092 (the same track at the previous 1380px default), so the widening moved the
 * number without moving the answer.
 */
const DEFAULT_DESKTOP_CONTENT_WIDTH = 1112;

/** Five 260px cards plus four 16px gutters — the true five-across width. */
const FIVE_ACROSS_CONTENT_WIDTH = 1364;

/**
 * The narrowest CONTENT width the derivation can be handed at `md+`.
 *
 * Not 768: the `md` tier is a VIEWPORT breakpoint, and at a 768 viewport the
 * row's content box lands near 512px once the 16rem nav rail (or the desktop
 * pane) is subtracted. Sampling from the viewport width was how the earlier
 * two-column floor's regression band went unsampled (stage review).
 */
const SMALLEST_COVERED_WIDTH = 240;
const WIDEST_SAMPLED_WIDTH = 2400;

/** The reviewer's band: a 768 viewport behind the 16rem nav rail. */
const NARROW_PANE_CONTENT_WIDTH = 512;

function columnsAt(availableWidth: number, cardCount = FIVE_CARD_STRIP) {
  return resolveSummaryCardColumns({
    availableWidth,
    cardCount,
    cardMinWidth: CARD_MIN_WIDTH,
    columnGap: COLUMN_GAP,
  });
}

/** Empty cells left in the final row when `cardCount` cards fill `columns`. */
function trailingEmptyCells(columns: number, cardCount: number) {
  return (columns - (cardCount % columns)) % columns;
}

describe("resolveSummaryCardColumns (ISS-4966)", () => {
  it("ranks the five-card strip 3 + 2 at the default desktop window", () => {
    // The whole defect: `auto-fit` picks 4 here, stranding the fifth card.
    expect(columnsAt(DEFAULT_DESKTOP_CONTENT_WIDTH)).toBe(3);
  });

  it("goes five-across only once five cards genuinely fit at the floor", () => {
    expect(columnsAt(FIVE_ACROSS_CONTENT_WIDTH - 1)).toBe(3);
    expect(columnsAt(FIVE_ACROSS_CONTENT_WIDTH)).toBe(5);
    expect(columnsAt(WIDEST_SAMPLED_WIDTH)).toBe(5);
  });

  it("never leaves more than one empty cell in the final row, at any width", () => {
    // Reported as the offending widths rather than a bare boolean, so a
    // regression names the band it broke in.
    const orphanedAt: { columns: number; emptyCells: number; width: number }[] =
      [];
    for (
      let width = SMALLEST_COVERED_WIDTH;
      width <= WIDEST_SAMPLED_WIDTH;
      width++
    ) {
      const columns = columnsAt(width) ?? 0;
      const emptyCells = trailingEmptyCells(columns, FIVE_CARD_STRIP);
      if (emptyCells > 1) {
        orphanedAt.push({ columns, emptyCells, width });
      }
    }
    expect(orphanedAt).toEqual([]);
  });

  it("never squeezes a card under the floor at any width it is handed", () => {
    const squeezedAt: { cardWidth: number; columns: number; width: number }[] =
      [];
    for (
      let width = SMALLEST_COVERED_WIDTH;
      width <= WIDEST_SAMPLED_WIDTH;
      width++
    ) {
      const columns = columnsAt(width) ?? 0;
      // A rank of one is not a CHOICE to squeeze — it is the floor being wider
      // than the whole row, where the `auto-fit` template it replaces also
      // gives one full-bleed track. The invariant is about never PACKING cards
      // under the floor.
      if (columns < 2) {
        continue;
      }
      const cardWidth = (width - COLUMN_GAP * (columns - 1)) / columns;
      if (cardWidth < CARD_MIN_WIDTH) {
        squeezedAt.push({ cardWidth, columns, width });
      }
    }
    expect(squeezedAt).toEqual([]);
  });

  it("falls to ONE column when only one card fits, never a squeezed two-up", () => {
    // ISS-4787's floor exists because "Non-subscription Cost" goes to three
    // lines under 260px and drops that card's value out of the row baseline. An
    // earlier revision clamped to a two-column floor here, which handed back
    // ~248px cards in exactly the band the strips ship at behind the nav rail
    // (stage review). `auto-fit` gives one full-width column there, and so must
    // this.
    expect(columnsAt(NARROW_PANE_CONTENT_WIDTH)).toBe(1);
    expect(columnsAt(320)).toBe(1);
    expect(columnsAt(1)).toBe(1);
  });

  it("closes the final row for other cardinalities too", () => {
    // Four cards close flush in the four-wide rank the width already holds.
    expect(columnsAt(DEFAULT_DESKTOP_CONTENT_WIDTH, 4)).toBe(4);
    // Six cards in a four-wide rank would strand two cells, so the rank drops
    // to a flush 3 + 3 rather than 4 + 2.
    expect(columnsAt(DEFAULT_DESKTOP_CONTENT_WIDTH, 6)).toBe(3);
    // Seven cards close 4 + 3, one empty cell, which is allowed.
    expect(columnsAt(DEFAULT_DESKTOP_CONTENT_WIDTH, 7)).toBe(4);
    // A solo card is a rank of one, not the two-up floor.
    expect(columnsAt(DEFAULT_DESKTOP_CONTENT_WIDTH, 1)).toBe(1);
  });

  it("reports UNKNOWN rather than guessing when the row cannot be measured", () => {
    // An unmeasured row (jsdom, SSR, a collapsed pane) must fall back to the
    // row's own class, not to a rank derived from a width nobody measured.
    expect(columnsAt(0)).toBeNull();
    expect(columnsAt(Number.NaN)).toBeNull();
    expect(columnsAt(-100)).toBeNull();
    expect(columnsAt(DEFAULT_DESKTOP_CONTENT_WIDTH, 0)).toBeNull();
    expect(
      resolveSummaryCardColumns({
        availableWidth: DEFAULT_DESKTOP_CONTENT_WIDTH,
        cardCount: FIVE_CARD_STRIP,
        cardMinWidth: Number.NaN,
        columnGap: COLUMN_GAP,
      })
    ).toBeNull();
  });
});
