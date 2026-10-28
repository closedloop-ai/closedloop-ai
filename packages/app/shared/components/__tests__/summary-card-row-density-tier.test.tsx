import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { SUMMARY_CARD_MIN_PROPERTY } from "@repo/app/shared/hooks/use-summary-card-columns";
import {
  CARD_COMPACT_SLOT_UTILITIES,
  CardDensity,
} from "@repo/design-system/components/ui/card-density";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreGridTier, stubGridTier } from "./summary-card-grid-tier-stub";
import {
  restoreTrackStub,
  stubTrackGap,
  stubTrackWidth,
  type TrackStubDescriptors,
} from "./summary-card-track-stub";

/**
 * ISS-5149 (gate retired by ISS-5366 — the tier is unconditional): the ROW half
 * of the track-width-keyed density tier. The arithmetic
 * lives in `hooks/__tests__/use-summary-card-density.test.ts`; this asserts that
 * the row actually CONSULTS it — that the resolved tier reaches both the
 * published `--summary-card-min` floor and the `data-density` attribute the
 * `Card` density variant switches on.
 *
 * A resolver test alone would stay green if nobody called the resolver, which is
 * the failure mode worth guarding: ISS-5068's own tests passed identically on
 * the unfitted layout.
 *
 * Every case pins the track width at or beside a CROSSOVER. The strip's real
 * geometry: five cards, a 16px gutter, floors of 260 and 192, so five fit roomy
 * at 1364 and tight at 1024.
 */

const CARD_LABELS = [
  "Sessions",
  "Total Tokens",
  "cost",
  "PRs Shipped",
  "LOC / $",
] as const;

const COMFORTABLE_ONE_RANK_WIDTH = 1364;
const COMPACT_ONE_RANK_WIDTH = 1024;
/**
 * The MEASURED desktop Sessions track at the 1400px launch width, scrollbar
 * included — the number the real renderer sees, which is 13px under the computed
 * 1112 the jsdom fixtures elsewhere pin. It was 1079 at the previous 1380px
 * default; the rail and gutters take the same bite, so the track moved with the
 * window. See `apps/desktop/src/shared/window-defaults.ts` for the derivation
 * chain and why measured and computed now both have names (#4445 review).
 *
 * Still inside the band — five cards miss the 1364 comfortable width and clear
 * the 1024 compact one — so the tier resolves the same way it did before the
 * widening, which is the point of pinning the LAUNCH width here rather than an
 * arbitrary one.
 */
const LAUNCH_TRACK_WIDTH = 1099;

/**
 * A 375px phone's strip track, once the page gutters are shed. Paired into the
 * row's static `grid-cols-2` this is `(343 - 16) / 2 = 163.5px` per card — the
 * width the ISS-5366 inversion was reported at.
 */
const PHONE_TRACK_WIDTH = 343;

/**
 * A track still in the two-column regime but wide enough that each pinned cell
 * clears the comfortable floor: `(552 - 16) / 2 = 268px`, over 260.
 */
const ROOMY_PAIRED_TRACK_WIDTH = 552;

const SHIPPED_MIN_WIDTH = "260px";
const DENSE_MIN_WIDTH = "192px";

/**
 * A representative slice of the rules the compact density switches on: one
 * interior step-down, the caption reservation, and the label re-flow. They are
 * declared on the row at EVERY density and self-gate on `data-density`, so at
 * comfortable density they must all still be present and all still inert.
 *
 * The step-down VALUES are asserted against the real `Card` primitive in
 * `packages/design-system/components/ui/__tests__/card-density.test.tsx`; this
 * list only pins that the row keeps declaring them.
 */
const COMPACT_ONLY_RULES = [
  `[data-slot=card]]:${CARD_COMPACT_SLOT_UTILITIES.cardPaddingY}`,
  `[data-slot=card-content]]:${CARD_COMPACT_SLOT_UTILITIES.contentMinHeight}`,
];

/**
 * The label re-flow, which is NOT one of the rules above any more (ISS-5366).
 * It is applied to the row unconditionally, so it is asserted without the
 * `data-density` prefix and at BOTH densities.
 */
const LABEL_REFLOW_RULE = "[data-slot=card-description]]:block";

let trackStub: TrackStubDescriptors | undefined;
let gridTierDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  // Every width this suite pins is a DESKTOP track, so it renders in the `md+`
  // tier. Declared rather than inherited: the shared setup reports non-matching,
  // which since ISS-5366 puts the density tier in its below-`md` fixed-rank
  // regime and would answer a 1099px track with the phone question.
  gridTierDescriptor = stubGridTier(true);
  // The track-width half of the harness (`summary-card-track-stub.ts`): the
  // `columnGap` proxy plus the `clientWidth` getter each case sets.
  trackStub = stubTrackGap();
});

afterEach(() => {
  if (trackStub) {
    restoreTrackStub(trackStub);
    trackStub = undefined;
  }
  restoreGridTier(gridTierDescriptor);
  gridTierDescriptor = undefined;
});

describe("SummaryCardRow density tier (ISS-5149)", () => {
  it("is compact at the measured desktop launch track, floor and attribute together", () => {
    stubTrackWidth(LAUNCH_TRACK_WIDTH);
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Compact);
    // The floor moves WITH the attribute or the tier is half-applied — a lower
    // floor without the interior that pays for it is the ISS-4787 regression.
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      DENSE_MIN_WIDTH
    );
  });

  it("gives the roomy card back ABOVE the band, where five already fit", () => {
    // The upper crossover, asserted AT the width rather than far above it.
    stubTrackWidth(COMFORTABLE_ONE_RANK_WIDTH);
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Comfortable);
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      SHIPPED_MIN_WIDTH
    );
  });

  it("keeps every compact rule on the row but INERT at comfortable density", () => {
    // ISS-5070 item 1: the density is a NAMED VARIANT, not a conditionally
    // concatenated selector patch — the rules are always present and self-gate
    // on `data-density`. Asserting that here, on the comfortable side, is what
    // makes the attribute (rather than the presence of a class string) the
    // contract; a row that dropped the rules when comfortable would still pass
    // every compact-side assertion in `summary-card-row-density.test.tsx`.
    stubTrackWidth(COMFORTABLE_ONE_RANK_WIDTH);
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Comfortable);
    for (const rule of COMPACT_ONLY_RULES) {
      expect(row.className).toContain(
        `[&[data-density=${CardDensity.Compact}]_${rule}`
      );
    }
  });

  it("re-flows the label region at comfortable density too, not only compact", () => {
    // ISS-5366, stage review. This test used to assert the OPPOSITE: that the
    // comfortable path left the label region as `MetricCard`'s own flex row,
    // which stranded the info trigger in the card's top-right corner while the
    // compact path trailed it after the last word. That made one control mean
    // two things, switched by how wide the user had dragged their window, and
    // retiring the density Labs flag shipped both readings at once.
    //
    // Asserted on the ROW's class, not the label's, on purpose: the re-flow is a
    // row-scoped descendant rule, and jsdom applies no CSS cascade, so the
    // label element still carries `MetricCard`'s own `flex` at every density.
    // A test that read the label's className would report "flex" here and pass
    // whether or not the row re-flowed anything.
    stubTrackWidth(COMFORTABLE_ONE_RANK_WIDTH);
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Comfortable);
    expect(row.className).toContain(`[&_${LABEL_REFLOW_RULE}`);
    // ...and it is NOT re-gated behind the density attribute.
    expect(row.className).not.toContain(
      `[&[data-density=${CardDensity.Compact}]_${LABEL_REFLOW_RULE}`
    );
  });

  it("re-flows the label region at compact density as well", () => {
    // The pair: same rule, same unprefixed form, asserted from the other side of
    // the tier so neither density can silently lose it.
    stubTrackWidth(COMFORTABLE_ONE_RANK_WIDTH - 1);
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Compact);
    expect(row.className).toContain(`[&_${LABEL_REFLOW_RULE}`);
  });

  it("steps to compact one pixel below that width", () => {
    stubTrackWidth(COMFORTABLE_ONE_RANK_WIDTH - 1);
    renderStrip();

    expect(stripRow().dataset.density).toBe(CardDensity.Compact);
  });

  it("gives the roomy card back BELOW the band, where nothing fits either way", () => {
    // The deliberate degradation. Below the compact floor's one-rank width the
    // strip wraps whatever the interior does, so a cramped card buys no rank.
    stubTrackWidth(COMPACT_ONE_RANK_WIDTH - 1);
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Comfortable);
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      SHIPPED_MIN_WIDTH
    );
  });

  it("holds compact at the last width the tight floor closes the rank", () => {
    stubTrackWidth(COMPACT_ONE_RANK_WIDTH);
    renderStrip();

    expect(stripRow().dataset.density).toBe(CardDensity.Compact);
  });

  it("renders compact before the row has ever been measured", () => {
    // A `null` measurement is "unknown", NOT "comfortable". An unmeasured row
    // must resolve COMPACT so the strip never paints the roomier card and then
    // snaps tighter a frame later. jsdom gives `clientWidth` 0 with no stub, so
    // the resolver cannot describe a layout and returns null.
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Compact);
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      DENSE_MIN_WIDTH
    );
  });

  describe("below `md`, where the row pins a static two-column grid", () => {
    // ISS-5366, stage review. The tier used to ask its one-rank question here
    // too: five cards fit one rank at NEITHER floor at phone widths, so the
    // "fits at neither -> comfortable" branch fired and a phone always resolved
    // COMFORTABLE. That handed the narrowest cards on any surface (~163px at a
    // 375px viewport) the roomiest interior, which inverts what compact density
    // is for -- and "cost" then has ~115px of content box to
    // wrap into. Below `md` the rank is PINNED at two, so wrapping can never buy
    // the width back and the question is whether the cell clears the floor.
    beforeEach(() => {
      restoreGridTier(gridTierDescriptor);
      gridTierDescriptor = stubGridTier(false);
    });

    it("resolves COMPACT when the pinned cell is under the comfortable floor", () => {
      // A 375px phone: a ~343px track pairs into (343 - 16) / 2 = 163.5px cells,
      // far under the 260 comfortable floor.
      stubTrackWidth(PHONE_TRACK_WIDTH);
      renderStrip();

      expect(stripRow().dataset.density).toBe(CardDensity.Compact);
    });

    it("still hands the roomy card back when the pinned cell clears the floor", () => {
      // The rule is the CELL against the floor, not "below `md` means compact":
      // a large tablet in the same two-column regime pairs into cells wider than
      // 260, and a cramped interior there would buy nothing.
      stubTrackWidth(ROOMY_PAIRED_TRACK_WIDTH);
      renderStrip();

      expect(stripRow().dataset.density).toBe(CardDensity.Comfortable);
    });

    it("does not ask the fixed-cell question of a non-wrapping row", () => {
      // A row without `wrapBelow` is a flex line at every width -- it pins no
      // rank, so the one-rank question stays correct for it and the phone
      // regime must not be applied. At this track neither floor closes the rank,
      // so the one-rank rule's deliberate degradation returns comfortable.
      stubTrackWidth(PHONE_TRACK_WIDTH);
      render(
        <SummaryCardRow>
          {CARD_LABELS.map((label) => (
            <MetricCard detail="in range" key={label} label={label} value="1" />
          ))}
        </SummaryCardRow>
      );

      expect(stripRow().dataset.density).toBe(CardDensity.Comfortable);
    });
  });

  describe("a pinned density (ISS-10540)", () => {
    // Operator ruling, Tamsin, 2026-09-21: the Sessions and Branches listing
    // strips pin `Compact` so the two read at one vertical rhythm. The pin has
    // to be observable, so every case here stands the row where the MEASURED
    // tier would resolve Comfortable — an unmeasured jsdom row already folds to
    // Compact and would pass with the prop deleted.

    it("wins over a track where the measurement resolves Comfortable — attribute AND floor", () => {
      stubTrackWidth(COMFORTABLE_ONE_RANK_WIDTH);
      // The negative control first: the same track, un-pinned, hands the roomy
      // card back. Without this the assertion below cannot tell the pin from
      // a measurement that happened to agree.
      renderStrip();
      expect(stripRow().dataset.density).toBe(CardDensity.Comfortable);
      cleanup();

      renderStrip({ density: CardDensity.Compact });

      const row = stripRow();
      expect(row.dataset.density).toBe(CardDensity.Compact);
      // The floor moves WITH the attribute or the tier is half-applied — the
      // ISS-4787 baseline regression from the other direction.
      expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
        DENSE_MIN_WIDTH
      );
    });

    it("wins below the band too, where the measurement's deliberate degradation resolves Comfortable", () => {
      stubTrackWidth(COMPACT_ONE_RANK_WIDTH - 1);
      renderStrip({ density: CardDensity.Compact });

      expect(stripRow().dataset.density).toBe(CardDensity.Compact);
    });

    it("wins below `md` on a paired cell that clears the comfortable floor", () => {
      restoreGridTier(gridTierDescriptor);
      gridTierDescriptor = stubGridTier(false);
      stubTrackWidth(ROOMY_PAIRED_TRACK_WIDTH);
      renderStrip({ density: CardDensity.Compact });

      expect(stripRow().dataset.density).toBe(CardDensity.Compact);
    });

    it("skips the measurement entirely rather than resolving a tier it discards", () => {
      // The pin is not "measure and ignore": a row that pins its tier attaches
      // no `ResizeObserver` for it, so neither listing strip re-renders on every
      // resize for an answer nothing reads.
      //
      // The one case in this block that does NOT stand the row at a
      // Comfortable-measuring track, deliberately: its subject is the observer,
      // not the tier, and holding the RESOLVED density equal on both renders is
      // what makes the counts comparable. The row's two sibling derivations
      // observe the same element, and the column one re-attaches when the
      // published floor moves — so a control that resolved a different tier
      // would differ by two observers for two reasons and the assertion could
      // not tell them apart. At the launch track both renders resolve Compact,
      // so the only difference left is the tier's own observer. Delete
      // `enabled` from the row's `useSummaryCardDensity` call and the counts
      // match.
      stubTrackWidth(LAUNCH_TRACK_WIDTH);
      const measuredObservers = countRowObservers(() => {
        renderStrip();
      });
      expect(stripRow().dataset.density).toBe(CardDensity.Compact);
      cleanup();

      const pinnedObservers = countRowObservers(() => {
        renderStrip({ density: CardDensity.Compact });
      });

      expect(stripRow().dataset.density).toBe(CardDensity.Compact);
      expect(pinnedObservers).toBe(measuredObservers - 1);
    });

    it("still yields the floor to an explicit minWidth", () => {
      // `minWidth`'s contract is unchanged by the pin: an explicit value
      // outranks whichever floor the density — pinned or measured — would
      // publish, while the interior still follows the pin.
      stubTrackWidth(COMFORTABLE_ONE_RANK_WIDTH);
      renderStrip({ density: CardDensity.Compact, minWidth: 320 });

      const row = stripRow();
      expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
        "320px"
      );
      expect(row.dataset.density).toBe(CardDensity.Compact);
    });
  });

  it("keeps an explicit minWidth authoritative over the resolved tier", () => {
    // A caller that measured its own surface owns its floor; the tier only
    // supplies the row's DEFAULT.
    stubTrackWidth(LAUNCH_TRACK_WIDTH);
    renderStrip({ minWidth: 320 });

    const row = stripRow();
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe("320px");
    // …while the interior still follows the tier, which is the other half of
    // the same decision.
    expect(row.dataset.density).toBe(CardDensity.Compact);
  });
});

function renderStrip({
  density,
  minWidth,
}: {
  density?: CardDensity;
  minWidth?: number;
} = {}) {
  render(
    <SummaryCardRow density={density} minWidth={minWidth} wrapBelow>
      {CARD_LABELS.map((label) => (
        <MetricCard detail="in range" key={label} label={label} value="1" />
      ))}
    </SummaryCardRow>
  );
}

function stripRow(): HTMLElement {
  const region = screen
    .getByText(CARD_LABELS[0])
    .closest<HTMLElement>('[data-slot="card-description"]');
  const row = region?.closest<HTMLElement>('[data-slot="card"]')?.parentElement;
  if (!row) {
    throw new Error("No summary strip rendered");
  }
  return row;
}

/**
 * How many elements the strip put under a `ResizeObserver` while `run` rendered
 * it. Counts `observe` calls rather than constructions, so a hook that
 * constructs an observer and never attaches it is correctly counted as zero.
 */
function countRowObservers(run: () => void): number {
  const installed = globalThis.ResizeObserver;
  let observed = 0;
  class CountingResizeObserver extends installed {
    observe(target: Element, options?: ResizeObserverOptions) {
      observed += 1;
      super.observe(target, options);
    }
  }
  globalThis.ResizeObserver = CountingResizeObserver;
  try {
    run();
  } finally {
    globalThis.ResizeObserver = installed;
  }
  return observed;
}
