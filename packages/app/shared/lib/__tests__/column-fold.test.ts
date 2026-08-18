import {
  fitGridTemplateToWholeColumns,
  measureWholeColumnFold,
  parseGridTrackMinWidthsPx,
  splitGridTracks,
} from "@repo/design-system/lib/column-fold";
import { describe, expect, it } from "vitest";

/**
 * ISS-4889: the pure half of whole-column fold fitting. A `GridTable` whose
 * declared tracks exceed its container is cut at the container's right edge, and
 * in the general case that cut lands in the MIDDLE of a track — half a chip, or
 * a currency figure clipped mid-glyph (ISS-4788). These pin that the fit moves
 * the cut onto a column boundary, and — just as important — that it declines to
 * touch a template it cannot safely measure.
 */

// The Sessions default template (lead + Owner, Status, Cost, Repository, Branch,
// PR, Started, Merge, Harness, Model, Duration, Autonomy, Last active, minus the
// optional trailing row-actions track): the real shape this exists for.
// Cumulative boundaries: 300, 480, 612, 712, 892, 1072, 1220, 1340, 1456, 1580,
// 1740, 1844, 1984, 2104.
const SESSIONS_TEMPLATE =
  "minmax(300px, 1fr) 180px 132px 100px 180px 180px 148px 120px 116px 124px 160px 104px 140px 120px";

/** Right edge (px from the table's left) of each track, in render order. */
function columnBoundariesPx(template: string): number[] {
  const widths = parseGridTrackMinWidthsPx(template) ?? [];
  const boundaries: number[] = [];
  let cumulative = 0;
  for (const width of widths) {
    cumulative += width;
    boundaries.push(cumulative);
  }
  return boundaries;
}

/**
 * Whether some track starts before the fold and ends after it — the condition
 * ISS-4889 exists to remove. A container at least as wide as the whole table has
 * no fold at all.
 */
function hasStraddlingColumn(template: string, containerWidthPx: number) {
  const boundaries = columnBoundariesPx(template);
  const totalPx = boundaries.at(-1) ?? 0;
  if (totalPx <= containerWidthPx) {
    return false;
  }
  return !boundaries.includes(containerWidthPx);
}

describe("splitGridTracks", () => {
  it("keeps a minmax() function whole instead of splitting on its comma", () => {
    expect(splitGridTracks("minmax(300px, 1fr) 180px 52px")).toEqual([
      "minmax(300px, 1fr)",
      "180px",
      "52px",
    ]);
  });
});

describe("parseGridTrackMinWidthsPx", () => {
  it("reads each track at its px minimum, which is what an overflowing grid pins to", () => {
    expect(
      parseGridTrackMinWidthsPx("minmax(300px, 1fr) 180px minmax(140px, 0.5fr)")
    ).toEqual([300, 180, 140]);
  });

  it("refuses a template with a track that declares no px length", () => {
    expect(parseGridTrackMinWidthsPx("minmax(0, 1fr) 180px")).toBeNull();
    expect(parseGridTrackMinWidthsPx("1fr auto")).toBeNull();
    expect(parseGridTrackMinWidthsPx("")).toBeNull();
  });

  it("refuses a track whose px length is NOT its minimum", () => {
    // The px length is the MAXIMUM here; the real minimum is `auto`, i.e.
    // content-dependent and unknowable from the string. Reading 300 as the
    // minimum would have the module claim a snapped fold while the browser laid
    // the row out somewhere else.
    expect(parseGridTrackMinWidthsPx("minmax(auto, 300px) 180px")).toBeNull();
    expect(
      parseGridTrackMinWidthsPx("minmax(min-content, 300px) 180px")
    ).toBeNull();
  });

  it("refuses a track that merely CONTAINS a px length", () => {
    // A custom property can resolve to anything; its fallback is not a
    // measurement. Same for a calc() the module cannot evaluate.
    expect(parseGridTrackMinWidthsPx("var(--lead, 300px) 180px")).toBeNull();
    expect(parseGridTrackMinWidthsPx("calc(300px+2rem) 180px")).toBeNull();
  });
});

describe("measureWholeColumnFold", () => {
  it("counts only the tracks that fit WHOLE and reports the leftover", () => {
    expect(measureWholeColumnFold([300, 180, 132, 100], 620)).toEqual({
      fittedCount: 3,
      leftoverPx: 8,
    });
  });

  it("reports zero fitted tracks when not even the first one fits", () => {
    expect(measureWholeColumnFold([300, 180], 250)).toEqual({
      fittedCount: 0,
      leftoverPx: 250,
    });
  });
});

describe("fitGridTemplateToWholeColumns", () => {
  // The failure this ticket is about, at the content width the report was filed
  // at (the 1380px window of the day − the 256px sidebar − the inset gutter; the
  // default is 1400 now, content area 1128): the fold falls at 1108,
  // between Branch (1072) and PR (1220), so the PR column renders ~36px of its
  // 148px track. Fails on the unfitted template.
  it("moves the desktop fold off the middle of a track and onto a column boundary", () => {
    expect(hasStraddlingColumn(SESSIONS_TEMPLATE, 1108)).toBe(true);

    const fitted = fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, 1108);

    expect(hasStraddlingColumn(fitted, 1108)).toBe(false);
    expect(columnBoundariesPx(fitted)).toContain(1108);
  });

  it("absorbs the leftover into the leading track and leaves every data track untouched", () => {
    const fitted = fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, 1108);

    // Lead 300 + the 36px the fold left over after Branch.
    expect(fitted).toBe(
      "minmax(336px, 1fr) 180px 132px 100px 180px 180px 148px 120px 116px 124px 160px 104px 140px 120px"
    );
  });

  it("holds at any container width, not just the one the bug was reported at", () => {
    for (
      let containerWidthPx = 768;
      containerWidthPx <= 2000;
      containerWidthPx += 1
    ) {
      const fitted = fitGridTemplateToWholeColumns(
        SESSIONS_TEMPLATE,
        containerWidthPx
      );
      expect(hasStraddlingColumn(fitted, containerWidthPx)).toBe(false);
    }
  });

  it("never moves a column past the fold that was already whole before it", () => {
    // The lead only ever GROWS, so a column that fit before still fits after —
    // the fit can widen the resting view, never narrow it.
    const before = measureWholeColumnFold(
      parseGridTrackMinWidthsPx(SESSIONS_TEMPLATE) ?? [],
      1108
    );
    const after = measureWholeColumnFold(
      parseGridTrackMinWidthsPx(
        fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, 1108)
      ) ?? [],
      1108
    );
    expect(after.fittedCount).toBe(before.fittedCount);
    expect(after.leftoverPx).toBe(0);
  });

  it("rewrites a bare px leading track as well as a minmax() one", () => {
    expect(fitGridTemplateToWholeColumns("300px 180px 180px", 400)).toBe(
      "400px 180px 180px"
    );
  });

  it("leaves a table that fits its container byte-identical", () => {
    expect(fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, 4000)).toBe(
      SESSIONS_TEMPLATE
    );
  });

  it("leaves a fold that already lands on a boundary byte-identical", () => {
    expect(fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, 1072)).toBe(
      SESSIONS_TEMPLATE
    );
  });

  it("declines when not even the leading column fits, rather than pushing more off-screen", () => {
    expect(fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, 250)).toBe(
      SESSIONS_TEMPLATE
    );
  });

  it("declines a lead whose px length is its maximum, rather than rewriting that maximum", () => {
    // Regression: reading "the first px anywhere in the track" made
    // `minmax(auto, 300px)` look like a 300px minimum, so the fit rewrote the
    // track's MAXIMUM and emitted a template the browser lays out differently
    // from what the module computed.
    const template = "minmax(auto, 300px) 180px 180px";
    expect(fitGridTemplateToWholeColumns(template, 500)).toBe(template);
  });

  it("declines a template it cannot measure instead of fitting it on a guess", () => {
    const unmeasurable = "minmax(0, 1fr) 180px 180px";
    expect(fitGridTemplateToWholeColumns(unmeasurable, 400)).toBe(unmeasurable);
  });

  it("declines a single-track template, which has no fold to move", () => {
    expect(fitGridTemplateToWholeColumns("300px", 200)).toBe("300px");
  });

  it("declines an unmeasured, zero, or non-finite container width", () => {
    expect(fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, 0)).toBe(
      SESSIONS_TEMPLATE
    );
    expect(fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, -1)).toBe(
      SESSIONS_TEMPLATE
    );
    expect(fitGridTemplateToWholeColumns(SESSIONS_TEMPLATE, Number.NaN)).toBe(
      SESSIONS_TEMPLATE
    );
  });

  it("rounds a fractional measurement to a whole pixel so the emitted template is stable", () => {
    // 300 + 180 fit; the 20.4px left over lands on the lead as a whole 320px.
    expect(fitGridTemplateToWholeColumns("300px 180px 180px", 500.4)).toBe(
      "320px 180px 180px"
    );
  });

  it("floors the widened lead so a fractional container never clips the last fitted column", () => {
    // A real browser's `contentRect.width` is fractional. 300 + 180 fit and
    // 20.7px is left over: rounding the 320.7px lead UP to 321px would push the
    // fitted prefix to 501px — half a pixel PAST the 500.7px container, clipping
    // the very column the fit exists to leave whole. Flooring keeps the prefix
    // at or before the edge.
    const fitted = fitGridTemplateToWholeColumns("300px 180px 180px", 500.7);
    expect(fitted).toBe("320px 180px 180px");
    const fittedPrefixPx = (parseGridTrackMinWidthsPx(fitted) ?? [])
      .slice(0, 2)
      .reduce((total, width) => total + width, 0);
    expect(fittedPrefixPx).toBeLessThanOrEqual(500.7);
  });
});
