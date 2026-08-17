import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { formatCost } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";
import {
  BucketJumpBlock,
  formatBucketBarLabel,
  formatBucketTooltipMoney,
  formatBucketTooltipTotal,
  getBarStyle,
  getBucketButtonLabel,
  getBucketCost,
  getBucketJumpHint,
  getBucketKey,
  getBucketReachClass,
  getRowPercent,
  getUnreadFromIndex,
  isInteriorGap,
} from "../activity-bucket-rendering";

function bucket(overrides: Partial<ActivityBucket> = {}): ActivityBucket {
  return {
    label: "12:00",
    cIn: 0,
    cOut: 0,
    cCache: 0,
    total: 0,
    toolStart: 0,
    tl0: null,
    byModel: {},
    ...overrides,
  };
}

describe("getBucketCost", () => {
  it("sums input, output, and cache costs", () => {
    expect(getBucketCost(bucket({ cIn: 1.5, cOut: 2.0, cCache: 0.5 }))).toBe(
      4.0
    );
  });

  it("returns 0 for a zero-cost bucket", () => {
    expect(getBucketCost(bucket())).toBe(0);
  });
});

describe("isInteriorGap", () => {
  it("returns true for a zero-cost bucket between two non-zero buckets", () => {
    const buckets = [
      bucket({ cIn: 1 }),
      bucket(), // index 1: zero cost, interior
      bucket({ cOut: 1 }),
    ];
    expect(isInteriorGap(1, buckets)).toBe(true);
  });

  it("returns false for a trailing zero-cost bucket", () => {
    const buckets = [bucket({ cIn: 1 }), bucket()];
    expect(isInteriorGap(1, buckets)).toBe(false);
  });

  it("returns false for a leading zero-cost bucket", () => {
    const buckets = [bucket(), bucket({ cIn: 1 })];
    expect(isInteriorGap(0, buckets)).toBe(false);
  });

  it("returns false for a non-zero bucket", () => {
    const buckets = [
      bucket({ cIn: 1 }),
      bucket({ cOut: 2 }),
      bucket({ cCache: 1 }),
    ];
    expect(isInteriorGap(1, buckets)).toBe(false);
  });

  it("handles multiple consecutive interior gaps", () => {
    const buckets = [
      bucket({ cIn: 1 }),
      bucket(),
      bucket(),
      bucket({ cOut: 1 }),
    ];
    expect(isInteriorGap(1, buckets)).toBe(true);
    expect(isInteriorGap(2, buckets)).toBe(true);
  });
});

describe("getBarStyle", () => {
  it("returns gap style for interior gaps", () => {
    const style = getBarStyle(0, 10, true);
    expect(style.height).toBe(4);
    expect(style.barClass).toBe("cb-gap");
    expect(style.showLabel).toBe(false);
  });

  it("returns idle style for non-gap zero-cost", () => {
    const style = getBarStyle(0, 10, false);
    expect(style.height).toBe(0);
    expect(style.barClass).toBe("idle");
    expect(style.showLabel).toBe(false);
  });

  it("returns stacked style with sqrt-scaled height for active buckets", () => {
    const style = getBarStyle(4, 16, false);
    expect(style.barClass).toBe("stacked");
    expect(style.height).toBe(
      Math.max(9, Math.round((Math.sqrt(4) / Math.sqrt(16)) * 100))
    );
  });
});

describe("getBucketKey", () => {
  it("returns the bucket key when present", () => {
    expect(getBucketKey(bucket({ key: "my-key" }), 0)).toBe("my-key");
  });

  it("builds a composite key from bucket fields when key is absent", () => {
    const b = bucket({
      label: "13:00",
      tl0: 12_345,
      total: 10,
      toolStart: 2,
      cCache: 0.5,
      cOut: 1.0,
      cIn: 0.25,
    });
    expect(getBucketKey(b, 3)).toBe("3:13:00:12345:10:2:0.5:1:0.25");
  });

  it("uses 'idle' as tl0 placeholder when tl0 is null", () => {
    const b = bucket({ label: "14:00" });
    expect(getBucketKey(b, 5)).toBe("5:14:00:idle:0:0:0:0:0");
  });

  it("returns a missing-bucket sentinel when bucket is undefined", () => {
    expect(getBucketKey(undefined, 7)).toBe("missing-bucket-7");
  });
});

/*
 * ISS-5075 (stage VQA review): on a truncated read the axis still spans the
 * whole run while the bars stop at the cut, so the tail past the last plotted
 * bucket is time with no evidence either way — it must not render as the idle
 * hatch, which on this strip means "observed, and nothing happened".
 */
describe("getUnreadFromIndex", () => {
  it("marks nothing unread when the event stream was read whole", () => {
    const buckets = [bucket({ cIn: 1 }), bucket(), bucket()];
    expect(getUnreadFromIndex(buckets, false)).toBe(buckets.length);
  });

  it("marks everything after the last plotted bucket unread", () => {
    const buckets = [bucket({ cIn: 1 }), bucket({ total: 3 }), bucket()];
    expect(getUnreadFromIndex(buckets, true)).toBe(2);
  });

  it("counts an eventful zero-cost bucket as plotted", () => {
    const buckets = [bucket({ cIn: 1 }), bucket({ total: 2 })];
    expect(getUnreadFromIndex(buckets, true)).toBe(buckets.length);
  });

  it("marks the whole strip unread when the cut left nothing plotted", () => {
    expect(getUnreadFromIndex([bucket(), bucket()], true)).toBe(0);
  });
});

describe("getBucketReachClass", () => {
  it("marks a bucket that has a transcript anchor when the flag is on", () => {
    expect(getBucketReachClass(bucket({ tl0: 4 }), true)).toBe("reach");
  });

  it("leaves an anchorless bucket unmarked even when the flag is on", () => {
    // ISS-5548: the bar has nowhere to send a click, so growing its hit box
    // would only make ISS-5479's inert target bigger.
    expect(getBucketReachClass(bucket({ tl0: null }), false)).toBe("");
    expect(getBucketReachClass(bucket({ tl0: null }), true)).toBe("");
  });

  it("leaves an anchored bucket unmarked while the flag is off", () => {
    expect(getBucketReachClass(bucket({ tl0: 4 }), false)).toBe("");
  });

  it("treats row 0 as a real anchor rather than a falsy miss", () => {
    // `tl0: 0` is the first transcript row — the bucket most likely to be the
    // session's opening prompt, and the one a `!bucket.tl0` test would drop.
    expect(getBucketReachClass(bucket({ tl0: 0 }), true)).toBe("reach");
  });

  it("leaves a disabled bar unmarked even when it has an anchor", () => {
    // Code review: FEA-4252 disables the whole strip while the trace has no
    // rendered rows, and `traceHasRenderedRows` can sit false indefinitely — it
    // is not just a first-paint flash. `.sd3-bar2 { cursor: pointer }` and the
    // base `.sd3-bar2:hover` outline are both unscoped by `:disabled`, so a
    // `.reach` box on a dead control would put a click cursor over the full
    // column and light the 6px sliver from 50px away. The class is withheld
    // rather than patched in CSS so all three signals settle on one answer.
    expect(getBucketReachClass(bucket({ tl0: 4 }), true, true)).toBe("");
    expect(getBucketReachClass(bucket({ tl0: 0 }), true, true)).toBe("");
  });

  it("still marks an anchored bar when the strip is explicitly enabled", () => {
    expect(getBucketReachClass(bucket({ tl0: 4 }), true, false)).toBe("reach");
  });
});

describe("getRowPercent", () => {
  it("centres on the last bucket whose anchor is at or before the active row", () => {
    const buckets = [
      bucket({ tl0: 0 }),
      bucket({ tl0: 10 }),
      bucket({ tl0: 20 }),
      bucket({ tl0: 30 }),
    ];
    // Row 25 sits inside the third bucket, whose centre is 2.5/4.
    expect(getRowPercent(25, buckets)).toBeCloseTo(62.5);
  });

  it("skips anchorless buckets when choosing the marked bucket", () => {
    const buckets = [bucket({ tl0: 0 }), bucket({ tl0: null }), bucket()];
    expect(getRowPercent(99, buckets)).toBeCloseTo((0.5 / 3) * 100);
  });

  it("returns 0 when there is no active row or no buckets", () => {
    expect(getRowPercent(null, [bucket({ tl0: 0 })])).toBe(0);
    expect(getRowPercent(5, [])).toBe(0);
  });
});

/**
 * ISS-5563: the bar label used to be
 * `` `$${cost < 1 ? cost.toFixed(1) : Math.round(cost)}` ``, so every figure at
 * or above a dollar was rounded to whole dollars in the most prominent instance
 * of a number the Properties panel and the Activity breakdown printed exactly.
 */
describe("formatBucketBarLabel", () => {
  it("prints the reported figure at full precision instead of rounding it to $1", () => {
    // The captured session: Properties and the Activity breakdown both read
    // $1.02, the bar label read $1.
    expect(formatBucketBarLabel(1.02)).toBe("$1.02");
  });

  it("keeps the cents the old whole-dollar rounding discarded", () => {
    expect(formatBucketBarLabel(1.49)).toBe("$1.49");
    expect(formatBucketBarLabel(1.5)).toBe("$1.50");
    expect(formatBucketBarLabel(12.34)).toBe("$12.34");
    expect(formatBucketBarLabel(999.99)).toBe("$999.99");
  });

  it("no longer widens a sub-dollar figure to a single decimal", () => {
    // The old branch rendered $0.4 for this; the breakdown rendered $0.42.
    expect(formatBucketBarLabel(0.42)).toBe("$0.42");
  });

  it("shows a real sub-cent bucket rather than flattening it to $0.00", () => {
    // `getBarStyle` can select a bucket this small for a label, and ISS-4919
    // already settled that a genuine sub-cent cost must not read as free.
    expect(formatBucketBarLabel(0.0042)).not.toBe("$0.00");
    expect(formatBucketBarLabel(0.0042)).toContain("0.004");
  });

  it("marks an abbreviated figure as approximate so it cannot be read as exact", () => {
    // $1,108.86 used to render `$1109` — an abbreviation with nothing to signal
    // it was one.
    const label = formatBucketBarLabel(1108.86);
    expect(label.startsWith("~$")).toBe(true);
    expect(label).not.toBe("$1109");
    expect(label).toBe("~$1.1k");
  });

  it("switches to the marked abbreviation exactly at the width threshold", () => {
    expect(formatBucketBarLabel(999.99).startsWith("~")).toBe(false);
    expect(formatBucketBarLabel(1000).startsWith("~")).toBe(true);
  });

  it("agrees with the shared currency formatter across the exact band", () => {
    // The whole point: the bar and the figures it must tie out against are
    // driven by one formatter, so they cannot disagree by construction. Compared
    // against `formatCost` — the formatter the Properties Cost row and the
    // Activity breakdown Cost column both use — not against a literal.
    for (const cost of [0.01, 0.42, 1.02, 1.49, 12.34, 250, 999.99]) {
      expect(formatBucketBarLabel(cost)).toBe(formatCost(cost));
    }
  });
});

/**
 * ISS-5563 code review (logical-metric-reconciliation): the bucket tooltip's
 * HEADER renders the same cost the bar label does, so the two must never
 * disagree about one bucket. Before this fix the header floored sub-cent to
 * `$0.00` while the bar said `$0.0042` — the exact one-figure-two-precisions
 * defect this ticket exists to remove, reintroduced one hover away.
 */
describe("bar label and tooltip header agree about one bucket", () => {
  it("does not read a real sub-cent bucket as free in the tooltip header", () => {
    expect(formatBucketTooltipTotal(0.0042)).not.toBe("$0.00");
    expect(formatBucketTooltipTotal(0.0042)).toBe(formatBucketBarLabel(0.0042));
  });

  it("agrees with the bar label across the whole exact band", () => {
    for (const cost of [0.0042, 0.01, 0.42, 1.02, 1.49, 12.34, 999.99]) {
      expect(formatBucketTooltipTotal(cost)).toBe(formatBucketBarLabel(cost));
    }
  });

  it("refines rather than contradicts the bar above the abbreviation floor", () => {
    // The bar marks itself approximate with `~`; the header, which has the
    // room, gives the exact figure the reader hovered for.
    expect(formatBucketBarLabel(1108.86)).toBe("~$1.1k");
    expect(formatBucketTooltipTotal(1108.86)).toBe("$1,108.86");
  });

  it("keeps the per-model breakdown rows on their deliberate sub-cent floor", () => {
    // The rows are a decomposition where a tail of `$0.0000` cells is noise —
    // that floor is still correct for them whenever the bucket they decompose
    // is itself a cent or more.
    expect(formatBucketTooltipMoney(0.0042, 1.02)).toBe("$0.00");
    expect(formatBucketTooltipMoney(1.02, 1.02)).toBe("$1.02");
  });

  // ISS-5563 second review: the header moved to the precise formatter while the
  // rows kept the floor, so a sub-cent bucket printed `$0.0042` over a table of
  // `$0.00` cells — a decomposition that does not add up to the total two lines
  // above it, inside ONE hover card. The fallback strip makes this routine:
  // `applyBucketCost` splits a floored bucket into three sub-cent slices.
  it("does not print an all-zero decomposition under a sub-cent header", () => {
    const bucketTotal = 0.0042;
    const slices = [0.0029, 0.001, 0.0003];

    for (const slice of slices) {
      expect(formatBucketTooltipMoney(slice, bucketTotal)).not.toBe("$0.00");
    }
    // And the card states ONE magnitude: the rows now use the same formatter
    // the header does, so neither can round the other away.
    expect(formatBucketTooltipMoney(bucketTotal, bucketTotal)).toBe(
      formatBucketTooltipTotal(bucketTotal)
    );
  });
});

/**
 * ISS-5843 (criteria 3 and 13). Mike chose option 2 — silent for `NoTurn`, an
 * at-rest non-toast signal for `NotInReadTranscript` — and that is ALREADY what
 * ISS-5479 shipped, so this ticket verifies the behaviour rather than rebuilding
 * it. These pin the three answers as three DISTINCT sentences so a later refactor
 * cannot quietly fold them together; ISS-5479's own review rejected collapsing
 * `BucketJumpBlock` into a boolean once already, because the reader is owed the
 * difference between "nothing happened in that slice" and "something happened
 * and you are looking at a different file".
 */
describe("the bucket tooltip's three jump answers stay distinct (ISS-5843)", () => {
  it("gives each state its own sentence", () => {
    const anchored = bucket({ tl0: 4 });

    const hints = [
      getBucketJumpHint(anchored, BucketJumpBlock.NoTurn),
      getBucketJumpHint(anchored, BucketJumpBlock.NotInReadTranscript),
      getBucketJumpHint(anchored, null),
    ];

    expect(hints).toEqual([
      " | nothing to open here",
      " | not in the transcript on screen",
      " | click to open in trace",
    ]);
    // Pairwise distinct, stated as its own claim: the literals above could all
    // be edited to one string and still satisfy a per-value assertion.
    expect(new Set(hints).size).toBe(hints.length);
  });

  it("says nothing at all about a click on an unanchored, unblocked bar", () => {
    // A null block must never be read as "this bar is jumpable": the bucket
    // carries no jump row, so promising "click to open in trace" would be a
    // lie. `getBucketJumpBlock` now answers `NoTurn` for exactly this bucket
    // (ISS-6006 retired the gate that used to null every block), so this guards
    // the formatter's own invariant rather than a flag state.
    expect(getBucketJumpHint(bucket({ tl0: null }), null)).toBe("");
  });

  it("drops the jump promise from the name of any blocked bar", () => {
    const anchored = bucket({ tl0: 4, label: "45m" });

    expect(getBucketButtonLabel(anchored, null)).toBe(
      "Jump to activity bucket 45m"
    );
    for (const block of Object.values(BucketJumpBlock)) {
      expect(getBucketButtonLabel(anchored, block)).toBe("Activity bucket 45m");
    }
  });
});
