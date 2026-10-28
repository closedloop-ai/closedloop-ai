import {
  fitGridTemplateToWholeColumns,
  measureWholeColumnFold,
  parseGridTrackMinWidthsPx,
  splitGridTracks,
} from "@closedloop-ai/design-system/lib/column-fold";
import { describe, expect, it } from "vitest";

/**
 * ISS-7349. `lib/column-fold.ts` decides where a `GridTable`'s right edge lands.
 * Its whole design argument is about what it must REFUSE to do: the module
 * header spends most of its length explaining why "the first px length anywhere
 * in the track" is wrong in both directions — `minmax(auto, 300px)` would be
 * read as a 300px minimum when 300px is its MAXIMUM, and `var(--lead, 300px)`
 * can resolve to anything. In either case the module would claim the fold is
 * snapped to a boundary while the browser lays the row out somewhere else, and
 * the caller gets no failure signal.
 *
 * A story renders one template at one width, so it can only ever exercise the
 * accepting path. The declining paths — and the byte-identical passthrough that
 * makes the function safe to apply unconditionally — are what this pins.
 */

const LEAD_AND_TWO = "minmax(300px, 1fr) 120px 180px";

describe("splitGridTracks", () => {
  it("keeps a minmax() whole rather than splitting on its inner comma", () => {
    expect(splitGridTracks(LEAD_AND_TWO)).toEqual([
      "minmax(300px, 1fr)",
      "120px",
      "180px",
    ]);
  });

  it("returns an empty list for an empty template", () => {
    expect(splitGridTracks("")).toEqual([]);
  });

  it("splits bare tokens on whitespace", () => {
    expect(splitGridTracks("1fr auto 40px")).toEqual(["1fr", "auto", "40px"]);
  });
});

describe("parseGridTrackMinWidthsPx", () => {
  it("reads a bare px track and a minmax px-minimum track", () => {
    expect(parseGridTrackMinWidthsPx(LEAD_AND_TWO)).toEqual([300, 120, 180]);
  });

  it("reads a fractional px length", () => {
    expect(parseGridTrackMinWidthsPx("104.5px 60px")).toEqual([104.5, 60]);
  });

  it("returns null for an empty template", () => {
    expect(parseGridTrackMinWidthsPx("")).toBeNull();
  });

  it.each([
    ["a bare fr track", "1fr 120px"],
    ["an auto track", "auto 120px"],
    ["a zero-minimum minmax", "minmax(0, 1fr) 120px"],
    ["a min() minimum", "minmax(min(100%, 28rem), 1fr) 120px"],
  ])("returns null for %s", (_label, template) => {
    // Not measurable from the string alone; guessing would move columns for the
    // wrong reason.
    expect(parseGridTrackMinWidthsPx(template)).toBeNull();
  });

  it("declines a minmax whose px length is the MAXIMUM, not the minimum", () => {
    // The defect the whitelist exists to prevent: this track's real minimum is
    // `auto`, so reading 300px as its minimum claims a geometry the browser will
    // not produce.
    expect(parseGridTrackMinWidthsPx("minmax(auto, 300px) 120px")).toBeNull();
  });

  it("declines a var() fallback that merely contains a px length", () => {
    expect(parseGridTrackMinWidthsPx("var(--lead, 300px) 120px")).toBeNull();
  });
});

describe("measureWholeColumnFold", () => {
  it("counts the tracks that fit whole and reports the leftover", () => {
    expect(measureWholeColumnFold([300, 120, 180], 500)).toEqual({
      fittedCount: 2,
      leftoverPx: 80,
    });
  });

  it("reports a zero leftover when the fold already lands on a boundary", () => {
    expect(measureWholeColumnFold([300, 120], 420)).toEqual({
      fittedCount: 2,
      leftoverPx: 0,
    });
  });

  it("fits nothing when not even the first track fits", () => {
    expect(measureWholeColumnFold([300, 120], 100)).toEqual({
      fittedCount: 0,
      leftoverPx: 100,
    });
  });

  it("fits every track when the container is wider than the grid", () => {
    expect(measureWholeColumnFold([300, 120], 1000)).toEqual({
      fittedCount: 2,
      leftoverPx: 580,
    });
  });
});

describe("fitGridTemplateToWholeColumns", () => {
  it("widens the leading track by the leftover so the fold lands on a boundary", () => {
    // 300 + 120 = 420 fits in 500, the third track does not; the 80px leftover
    // goes to the lead.
    expect(fitGridTemplateToWholeColumns(LEAD_AND_TWO, 500)).toBe(
      "minmax(380px, 1fr) 120px 180px"
    );
  });

  it("rewrites a bare px leading track in place", () => {
    expect(fitGridTemplateToWholeColumns("300px 120px 180px", 500)).toBe(
      "380px 120px 180px"
    );
  });

  it("floors the widened lead rather than rounding it", () => {
    // Rounding would take the lead UP on a .5 leftover and clip the last whole
    // column by a sub-pixel; ResizeObserver widths are fractional in a real
    // browser, so this is the normal case, not an edge case.
    expect(fitGridTemplateToWholeColumns(LEAD_AND_TWO, 500.9)).toBe(
      "minmax(380px, 1fr) 120px 180px"
    );
  });

  it.each([
    ["a zero width", 0],
    ["a negative width", -10],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("returns the template byte-identical for %s", (_label, width) => {
    // First paint, a detached container, a bad measurement — the caller applies
    // this unconditionally, so every one of these must be a passthrough.
    expect(fitGridTemplateToWholeColumns(LEAD_AND_TWO, width)).toBe(
      LEAD_AND_TWO
    );
  });

  it("returns the template unchanged when the grid already fits", () => {
    // No fold, and the fr maximums are entitled to the free space.
    expect(fitGridTemplateToWholeColumns(LEAD_AND_TWO, 2000)).toBe(
      LEAD_AND_TWO
    );
  });

  it("returns the template unchanged when the fold already sits on a boundary", () => {
    expect(fitGridTemplateToWholeColumns(LEAD_AND_TWO, 420)).toBe(LEAD_AND_TWO);
  });

  it("returns the template unchanged when not even the leading track fits", () => {
    // Widening the lead here would push MORE content off screen.
    expect(fitGridTemplateToWholeColumns(LEAD_AND_TWO, 100)).toBe(LEAD_AND_TWO);
  });

  it("returns the template unchanged when a track is not measurable", () => {
    const unmeasurable = "minmax(0, 1fr) 120px 180px";

    expect(fitGridTemplateToWholeColumns(unmeasurable, 500)).toBe(unmeasurable);
  });

  it("returns a single-track template unchanged", () => {
    // A grid needs a lead plus at least one data track to have a fold at all.
    expect(fitGridTemplateToWholeColumns("300px", 100)).toBe("300px");
  });

  it("rewrites only the leading track's px length, never a later one", () => {
    const result = fitGridTemplateToWholeColumns(LEAD_AND_TWO, 500);

    expect(result.endsWith("120px 180px")).toBe(true);
  });
});

/**
 * ISS-8909 — which track absorbs the leftover, for a grid whose FIRST track is a
 * leading utility track (a favourite star, a checkbox) rather than the identity
 * column.
 *
 * `GridTable` (v1) never had one, so growing track 0 and growing "the identity
 * column" were the same statement there. `GridTableV2` supports one, and the web
 * Sessions host declares it — so absorbing into track 0 there would widen the
 * 36px STAR to whatever the leftover happens to be, leaving the name column at
 * its declared width. The desktop host declares no utility track, so its
 * template leads with the identity column and a naive port would look correct on
 * desktop while being visibly wrong on web.
 */
describe("fitGridTemplateToWholeColumns — the absorbing track", () => {
  /**
   * Star + identity + two data tracks. At 500px: 36 + 240 = 276 fits, + 190 =
   * 466 fits, the next 190 does not — so three tracks fit and 34px is left over.
   * Pinned as literals rather than recomputed from the helper under test.
   */
  const UTILITY_LEAD_AND_TWO = "36px 240px 190px 190px";
  const CONTAINER_PX = 500;

  it("grows the identity track, not the utility track, when told to", () => {
    expect(
      fitGridTemplateToWholeColumns(UTILITY_LEAD_AND_TWO, CONTAINER_PX, 1)
    ).toBe("36px 274px 190px 190px");
  });

  /**
   * The defect the index exists to prevent, kept executable. Without it the same
   * call grows the star — so this and the case above cannot both pass, which is
   * what makes the parameter load-bearing rather than decorative.
   */
  it("grows the utility track when index 0 is taken — the wrong answer for v2", () => {
    expect(
      fitGridTemplateToWholeColumns(UTILITY_LEAD_AND_TWO, CONTAINER_PX, 0)
    ).toBe("70px 240px 190px 190px");
  });

  it("defaults to the leading track, so every v1 caller is unchanged", () => {
    expect(
      fitGridTemplateToWholeColumns(UTILITY_LEAD_AND_TWO, CONTAINER_PX)
    ).toBe(
      fitGridTemplateToWholeColumns(UTILITY_LEAD_AND_TWO, CONTAINER_PX, 0)
    );
  });

  it.each([
    ["at the fold", 3],
    ["past the fold", 9],
    ["negative", -1],
    ["fractional", 1.5],
  ])(
    "returns the template unchanged for an absorbing track %s",
    (_label, index) => {
      // Only three tracks fit. Growing one at or past the fold moves content
      // that is already off-screen and leaves the fold cutting exactly the track
      // it was cutting before — an unfitted layout reported as a fit.
      expect(
        fitGridTemplateToWholeColumns(UTILITY_LEAD_AND_TWO, CONTAINER_PX, index)
      ).toBe(UTILITY_LEAD_AND_TWO);
    }
  );
});
