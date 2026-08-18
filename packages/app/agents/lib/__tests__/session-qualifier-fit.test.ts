import { describe, expect, it } from "vitest";
import {
  estimateQualifierChipWidthPx,
  resolveVisibleQualifierCount,
} from "../session-qualifier-fit";

/**
 * ISS-5282 (review cid 3731458702): the `Signals` track is `minmax(140px, 0.5fr)`,
 * so how many chips fit is a function of the width the column actually got — not
 * a constant. A fixed cap against a variable track made overflow the NORMAL case
 * (one chip plus a counter, on a 1440px window with hundreds of spare pixels)
 * rather than the crowded case.
 */

const SHORT = "Local only";
const LONG = "Transcript still syncing";
const AWAITING = "Awaiting input";
/** The column's declared floor minus the grid cell's 24px horizontal padding. */
const FLOOR_CONTENT_WIDTH_PX = 116;
/** A share representative of the `0.5fr` track on a desktop window. */
const WIDE_CONTENT_WIDTH_PX = 400;

describe("resolveVisibleQualifierCount", () => {
  it("shows every chip when the width holds them all", () => {
    expect(
      resolveVisibleQualifierCount([AWAITING, SHORT], WIDE_CONTENT_WIDTH_PX)
    ).toBe(2);
  });

  it("shows MORE chips as the track widens — the property a fixed cap could not have", () => {
    const labels = [AWAITING, SHORT, LONG];
    const atFloor = resolveVisibleQualifierCount(
      labels,
      FLOOR_CONTENT_WIDTH_PX
    );
    const atWidth = resolveVisibleQualifierCount(labels, WIDE_CONTENT_WIDTH_PX);
    expect(atWidth).toBeGreaterThan(atFloor);
  });

  it("collapses to the leading chip at the track floor, so the most actionable state stays visible", () => {
    expect(
      resolveVisibleQualifierCount([AWAITING, SHORT], FLOOR_CONTENT_WIDTH_PX)
    ).toBe(1);
  });

  it("reserves room for the counter, so the last visible chip never sits under it", () => {
    // Wide enough for two chips outright, but NOT for two chips plus the `+1`
    // that has to disclose the third. The fit must drop back to one.
    const twoChipsPx =
      estimateQualifierChipWidthPx(AWAITING) +
      estimateQualifierChipWidthPx(SHORT) +
      8;
    expect(
      resolveVisibleQualifierCount([AWAITING, SHORT, LONG], twoChipsPx)
    ).toBe(1);
  });

  it("never hides the only qualifier a row has behind a counter", () => {
    // One label, far too wide for the box: still shown, because a counter alone
    // would leave the row with no visible state at all.
    expect(resolveVisibleQualifierCount([LONG], 10)).toBe(1);
  });

  it("returns zero for a row with no qualifiers", () => {
    expect(resolveVisibleQualifierCount([], WIDE_CONTENT_WIDTH_PX)).toBe(0);
  });

  it("falls back to a single chip when the cell has not been measured", () => {
    // 0 = the unmeasured sentinel (SSR, a detached container, the frame before
    // the observer reports). Promising more chips than the track holds and then
    // reflowing is the failure this guards.
    expect(resolveVisibleQualifierCount([AWAITING, SHORT, LONG], 0)).toBe(1);
  });

  it("treats a non-finite width as unmeasured rather than as unlimited room", () => {
    expect(resolveVisibleQualifierCount([AWAITING, SHORT], Number.NaN)).toBe(1);
    expect(
      resolveVisibleQualifierCount([AWAITING, SHORT], Number.NEGATIVE_INFINITY)
    ).toBe(1);
  });
});

describe("estimateQualifierChipWidthPx", () => {
  it("grows with the label, so a longer verdict costs more of the track", () => {
    expect(estimateQualifierChipWidthPx(LONG)).toBeGreaterThan(
      estimateQualifierChipWidthPx(SHORT)
    );
  });

  it("charges for chip chrome even on an empty label", () => {
    expect(estimateQualifierChipWidthPx("")).toBeGreaterThan(0);
  });
});
