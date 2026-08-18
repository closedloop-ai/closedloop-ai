import { resolveSummaryCardDensity } from "@repo/app/shared/hooks/use-summary-card-density";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { describe, expect, it } from "vitest";

/**
 * ISS-5149: the strip's density is keyed on the width of the TRACK the cards are
 * laid into — an input — rather than on the resulting card width, which is an
 * output of the floor and therefore a feedback loop.
 *
 * The assertions below sit ON the crossovers, not in a comfortable middle. A
 * tier is a step function and its only interesting behavior is where it steps: a
 * test at 1400 and a test at 900 would pass against an implementation with the
 * boundary off by 60px, which is exactly the class of defect ISS-5068 was filed
 * about.
 *
 * The Sessions strip's real geometry, which every case here is derived from:
 * five cards, a 16px gutter, a 260px comfortable floor and a 192px compact one.
 *   comfortable one-rank width = 5 * 260 + 4 * 16 = 1364
 *   compact     one-rank width = 5 * 192 + 4 * 16 = 1024
 */

const SESSIONS_STRIP = {
  cardCount: 5,
  columnGap: 16,
  comfortableMinWidth: 260,
  compactMinWidth: 192,
};

const COMFORTABLE_ONE_RANK_WIDTH = 1364;
const COMPACT_ONE_RANK_WIDTH = 1024;

function densityAt(trackWidth: number) {
  return resolveSummaryCardDensity({ ...SESSIONS_STRIP, trackWidth });
}

describe("resolveSummaryCardDensity (ISS-5149)", () => {
  it("is comfortable exactly AT the width five cards fit at the roomy floor", () => {
    // The upper crossover. Compact buys nothing here — the cards already fit —
    // so tightening them would cost legibility for no layout gain.
    expect(densityAt(COMFORTABLE_ONE_RANK_WIDTH)).toBe(CardDensity.Comfortable);
  });

  it("is compact ONE PIXEL below that width", () => {
    // The step. If the boundary is off by even a pixel this is the assertion
    // that catches it; a test at some comfortable middle width cannot.
    expect(densityAt(COMFORTABLE_ONE_RANK_WIDTH - 1)).toBe(CardDensity.Compact);
  });

  it("is compact at the 1079px track the defect was REPORTED at", () => {
    // The width the defect was reported at — the measured track of the old
    // 1380px window, no longer the launch geometry (the default is 1400 and its
    // measured track is 1099). Kept as the reported regime, and renamed rather
    // than relabelled "launch", because it sits inside the band exactly as the
    // current track does: 1079 is below 1364 (five do not fit roomy) and above
    // 1024 (five do fit compact), so the tier answer is the same at both.
    expect(densityAt(1079)).toBe(CardDensity.Compact);
    expect(densityAt(1099)).toBe(CardDensity.Compact);
  });

  it("is compact exactly AT the width five cards fit at the tight floor", () => {
    // The lower crossover, from the inside. Compact is still earning its keep
    // here — this is the last width at which it closes the rank.
    expect(densityAt(COMPACT_ONE_RANK_WIDTH)).toBe(CardDensity.Compact);
  });

  it("degrades BACK to comfortable one pixel below the tight floor's rank", () => {
    // The deliberate degradation, and the half a naive "narrower ⇒ tighter"
    // rule gets wrong. Below this the strip wraps whatever the interior does, so
    // a cramped card buys no rank and only costs legibility.
    expect(densityAt(COMPACT_ONE_RANK_WIDTH - 1)).toBe(CardDensity.Comfortable);
  });

  it("moves the crossovers with the card COUNT, not a viewport breakpoint", () => {
    // The same track width answers differently for a four-card strip, which is
    // what "keyed on the track" means and what a `xl:` media query could never
    // express: at 1100px five cards need compact and four do not.
    expect(densityAt(1100)).toBe(CardDensity.Compact);
    expect(
      resolveSummaryCardDensity({
        ...SESSIONS_STRIP,
        cardCount: 4,
        trackWidth: 1100,
      })
    ).toBe(CardDensity.Comfortable);
  });

  it("returns null — not a guess — when the inputs cannot describe a layout", () => {
    // An unmeasured row, a hidden pane, a bare jsdom render. `null` is
    // "unknown"; the caller holds its previous tier rather than flapping the
    // whole strip on one frame with no layout.
    for (const trackWidth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(densityAt(trackWidth)).toBeNull();
    }
    expect(
      resolveSummaryCardDensity({
        ...SESSIONS_STRIP,
        cardCount: 0,
        trackWidth: 1200,
      })
    ).toBeNull();
    expect(
      resolveSummaryCardDensity({
        ...SESSIONS_STRIP,
        columnGap: -1,
        trackWidth: 1200,
      })
    ).toBeNull();
  });

  it("counts the gutters, not just the cards", () => {
    // Five cards of 260 sum to 1300; the four 16px gutters are the other 64. A
    // rule that forgot them would call 1300 comfortable.
    expect(densityAt(1300)).toBe(CardDensity.Compact);
    expect(
      resolveSummaryCardDensity({
        ...SESSIONS_STRIP,
        columnGap: 0,
        trackWidth: 1300,
      })
    ).toBe(CardDensity.Comfortable);
  });
});
