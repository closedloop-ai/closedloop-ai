import { describe, expect, it } from "vitest";
import {
  barLabelsFit,
  estimateBarLabelWidthPx,
  fitBucketBarLabels,
} from "../session-timeline-bar-label-fit";

/**
 * ISS-5761. The regression regime is HIGH COLUMN COUNT, so every assertion here
 * that claims a fix is made at a realistic one.
 *
 * `SESSION_TRACE_BUCKET_TARGET` is 40 and the desktop producer emits one bucket
 * per five minutes, so any session past ~3h20m pins the strip at its 40-column
 * cap. The reported session ran 3h35m and printed 37 labels into a rail that,
 * at a normal detail width, gives each of them about 16px — against a `$8.55`
 * that wants nearly 30px. A test at 5–8 buckets does not collide and proves
 * nothing about that, which is exactly why this defect shipped.
 */

/** A normal session-detail content width for the strip. */
const DETAIL_RAIL_WIDTH_PX = 720;

/** `gap` of `.sd3-bars2-lbls`, mirrored from the stylesheet. */
const RAIL_GAP_PX = 2;

/** The 37 figures the reported strip printed, in order. */
const REPORTED_LABELS = [
  "$8.55",
  "$15.3",
  "$20.20",
  "$14.4",
  "$7",
  "$24.0",
  "$23.0",
  "$19.3",
  "$17.0",
  "$17.3",
  "$10.0",
  "$17.1",
  "$15.3",
  "$10.7",
  "$12.1",
  "$9.14",
  "$17.8",
  "$13.2",
  "$17.2",
  "$15.2",
  "$14.5",
  "$8.41",
  "$10.9",
  "$11.8",
  "$10.9",
  "$24.5",
  "$20.3",
  "$10.3",
  "$30.9",
  "$20.1",
  "$21.6",
  "$19.4",
  "$13.2",
  "$45.5",
  "$31.6",
  "$26.6",
  "$23.0",
];

/**
 * The property under test, computed from the geometry the rail actually renders
 * rather than from the module's own arithmetic: lay each printed label out
 * centred in its own `flex: 1 1 0` cell and report whether any two overlap.
 *
 * Written independently of {@link barLabelsFit} on purpose — a helper that
 * called the function it is checking would agree with it by construction.
 */
function overlappingLabelPairs(
  labels: readonly (string | null)[],
  railWidth: number
): number {
  const cellWidth =
    (railWidth - RAIL_GAP_PX * (labels.length - 1)) / labels.length;
  const boxes: { start: number; end: number }[] = [];
  for (const [index, label] of labels.entries()) {
    if (label == null || label.length === 0) {
      continue;
    }
    const centre = index * (cellWidth + RAIL_GAP_PX) + cellWidth / 2;
    const half = estimateBarLabelWidthPx(label) / 2;
    boxes.push({ start: centre - half, end: centre + half });
  }
  let overlaps = 0;
  for (let index = 1; index < boxes.length; index++) {
    if (boxes[index].start < boxes[index - 1].end) {
      overlaps++;
    }
  }
  return overlaps;
}

describe("barLabelsFit", () => {
  it("rejects the reported 37-column strip at a normal detail width", () => {
    expect(
      barLabelsFit({
        labels: REPORTED_LABELS,
        railWidth: DETAIL_RAIL_WIDTH_PX,
      })
    ).toBe(false);
  });

  it("accepts a short session's strip, so the fix is not just 'always hide'", () => {
    expect(
      barLabelsFit({
        labels: ["$1.02", "$0.44", null, "$2.10", "$0.98", "$1.55"],
        railWidth: DETAIL_RAIL_WIDTH_PX,
      })
    ).toBe(true);
  });

  it("keeps printing at 40 columns when the printed labels are far enough apart", () => {
    // Only every fifth bucket clears `showLabel`, so each label has four blank
    // cells beside it and five times the pitch. Density, not column count, is
    // what the rail is actually constrained by.
    //
    // Offset off cell 0 deliberately: a label centred in the FIRST cell of a
    // 40-column rail overhangs the rail's own left edge no matter how empty its
    // neighbours are, which the edge case below pins separately.
    const sparse = Array.from({ length: 40 }, (_, index) =>
      index % 5 === 2 ? "$1.02" : null
    );
    expect(
      barLabelsFit({ labels: sparse, railWidth: DETAIL_RAIL_WIDTH_PX })
    ).toBe(true);
  });

  it("rejects 40 dense columns — the cap every long session pins to", () => {
    // The literal worst case the fix exists for. `SESSION_TRACE_BUCKET_TARGET`
    // is 40, so a session past ~3h20m always lands here, and the reported one
    // was three columns short of it.
    const dense = Array.from({ length: 40 }, () => "$12.40");
    expect(
      barLabelsFit({ labels: dense, railWidth: DETAIL_RAIL_WIDTH_PX })
    ).toBe(false);
  });

  it("rejects a rail with no width rather than dividing by it", () => {
    expect(barLabelsFit({ labels: ["$1.02", "$2.02"], railWidth: 0 })).toBe(
      false
    );
  });

  it("rejects a non-finite width instead of failing open into a print", () => {
    // Every `needed > available` comparison against NaN is false, so without an
    // explicit guard the loop falls through and reports the rail has room.
    expect(
      barLabelsFit({
        labels: Array.from({ length: 40 }, () => "$12.40"),
        railWidth: Number.NaN,
      })
    ).toBe(false);
    expect(
      barLabelsFit({ labels: ["$1.02"], railWidth: Number.POSITIVE_INFINITY })
    ).toBe(false);
  });

  it("rejects a lone label wide enough to spill past the rail's own edge", () => {
    // Nothing in the rail clips, so a single label in cell 0 of a narrow strip
    // overflows `.sd3-bars2-wrap` into the panel beside it. Adjacency alone
    // never catches this — there is no neighbour to collide with.
    const lone = Array.from({ length: 40 }, (_, index) =>
      index === 0 ? "$45.50" : null
    );
    expect(barLabelsFit({ labels: lone, railWidth: 400 })).toBe(false);
    expect(barLabelsFit({ labels: lone, railWidth: 4000 })).toBe(true);
  });

  it("rejects a strip that fits on a wide panel once the panel narrows", () => {
    const labels = Array.from({ length: 20 }, () => "$12.40");
    expect(barLabelsFit({ labels, railWidth: 1400 })).toBe(true);
    expect(barLabelsFit({ labels, railWidth: 360 })).toBe(false);
  });
});

describe("fitBucketBarLabels", () => {
  it("leaves the reported strip with no overlapping labels", () => {
    const fitted = fitBucketBarLabels({
      labels: REPORTED_LABELS,
      railWidth: DETAIL_RAIL_WIDTH_PX,
    });

    // The regression itself: unfitted, these 37 labels overlap. The fix is only
    // meaningful if that is true of the input.
    expect(
      overlappingLabelPairs(REPORTED_LABELS, DETAIL_RAIL_WIDTH_PX)
    ).toBeGreaterThan(0);
    expect(overlappingLabelPairs(fitted, DETAIL_RAIL_WIDTH_PX)).toBe(0);
  });

  it("keeps one cell per bucket when it blanks them, so the rail holds its height", () => {
    const fitted = fitBucketBarLabels({
      labels: REPORTED_LABELS,
      railWidth: DETAIL_RAIL_WIDTH_PX,
    });
    expect(fitted).toHaveLength(REPORTED_LABELS.length);
    expect(fitted.every((label) => label === null)).toBe(true);
  });

  it("prints a short session's labels verbatim and without overlap", () => {
    const labels = ["$1.02", "$0.44", null, "$2.10", "$0.98", "$1.55"];
    const fitted = fitBucketBarLabels({
      labels,
      railWidth: DETAIL_RAIL_WIDTH_PX,
    });
    expect(fitted).toEqual(labels);
    expect(overlappingLabelPairs(fitted, DETAIL_RAIL_WIDTH_PX)).toBe(0);
  });

  it("keeps the peak alone when the full rail will not fit", () => {
    const fitted = fitBucketBarLabels({
      labels: REPORTED_LABELS,
      // "$45.5", the strip's most expensive bucket.
      peakIndex: 33,
      railWidth: DETAIL_RAIL_WIDTH_PX,
    });

    expect(fitted[33]).toBe("$45.5");
    expect(fitted.filter((label) => label != null)).toHaveLength(1);
    expect(overlappingLabelPairs(fitted, DETAIL_RAIL_WIDTH_PX)).toBe(0);
  });

  it("prints nothing when even the peak alone overhangs the rail", () => {
    // A single label still has to clear the rail's own edges, so the peak-only
    // state is re-checked rather than assumed to fit.
    const labels = Array.from({ length: 40 }, (_, index) =>
      index === 0 ? "$45.50" : "$8.55"
    );
    expect(
      fitBucketBarLabels({ labels, peakIndex: 0, railWidth: 400 })
    ).toEqual(labels.map(() => null));
  });

  it("falls straight to nothing when no peak is named", () => {
    // An older caller that cannot name a peak must not get an invented one.
    expect(
      fitBucketBarLabels({
        labels: REPORTED_LABELS,
        railWidth: DETAIL_RAIL_WIDTH_PX,
      }).every((label) => label === null)
    ).toBe(true);
  });

  it("ignores a peak index the rail was never going to print", () => {
    // `buildBucketBarLabels` blanks the unread tail and every synthesized strip,
    // so a peak index can land on a `null` cell — the rail must not resurrect it.
    const labels = REPORTED_LABELS.map((label, index) =>
      index === 33 ? null : label
    );
    expect(
      fitBucketBarLabels({
        labels,
        peakIndex: 33,
        railWidth: DETAIL_RAIL_WIDTH_PX,
      }).every((label) => label === null)
    ).toBe(true);
  });

  it("never prints a partial rail beyond the single peak", () => {
    // A reader cannot tell a bucket that is cheap (no label by cost) from one
    // that was crowded out, so a rail that thinned to SEVERAL labels would
    // answer the collision with an ambiguity. One label has nothing to be
    // compared against and nothing to be mistaken for; three do.
    const fitted = fitBucketBarLabels({
      labels: REPORTED_LABELS,
      peakIndex: 33,
      railWidth: DETAIL_RAIL_WIDTH_PX,
    });
    const printed = fitted.filter((label) => label != null);
    expect(
      printed.length <= 1 || printed.length === REPORTED_LABELS.length
    ).toBe(true);
  });
});
