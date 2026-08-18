import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  buildBucketBarLabels,
  hasSynthesizedBucketCosts,
  resolveTimelineCostDisclosure,
} from "../session-timeline-bar-labels";

/**
 * ISS-5563 (code review): the Session Timeline's bar labels.
 *
 * Two defects sit behind these specs. The label was rendered INSIDE an
 * `overflow: hidden` bar at `top: -14px`, so it was clipped away entirely and no
 * reader ever saw it — that one is fixed in markup/CSS (the rail) and is not
 * assertable here. The other is what the label SAYS, which is: nothing at all
 * when the money behind it was synthesized rather than measured.
 */
function bucket(cost: number, label = "b"): ActivityBucket {
  return {
    label,
    cIn: cost,
    cOut: 0,
    cCache: 0,
    total: 1,
    toolStart: 0,
    tl0: 0,
    byModel: { "claude-sonnet": { cIn: cost, cOut: 0, cCache: 0 } },
  };
}

describe("hasSynthesizedBucketCosts", () => {
  it("marks a fallback strip on a zero-cost session as synthesized", () => {
    // The reachable shape: no persisted buckets, so `buildActivityBuckets`
    // takes the transcript path and prices the whole strip from
    // `Math.max(estimatedCost, 0.01)` — money nobody measured.
    expect(
      hasSynthesizedBucketCosts({ activityBuckets: [], estimatedCost: 0 })
    ).toBe(true);
    expect(hasSynthesizedBucketCosts({ estimatedCost: 0 })).toBe(true);
  });

  it("does not mark a fallback strip that has real spend behind it", () => {
    // The floor only manufactures money when `estimatedCost` is 0. With real
    // spend the fallback path is distributing a measured total.
    expect(hasSynthesizedBucketCosts({ estimatedCost: 4.82 })).toBe(false);
  });

  it("does not mark persisted buckets, which are priced per event", () => {
    expect(
      hasSynthesizedBucketCosts({
        activityBuckets: [bucket(1.02)],
        estimatedCost: 0,
      })
    ).toBe(false);
  });

  it("treats a missing cost as unpriced rather than as measured", () => {
    // Across the JSON boundary the field can be absent; `!(x > 0)` keeps NaN
    // and undefined on the honest side of the branch.
    const skewed = { estimatedCost: Number.NaN };
    expect(hasSynthesizedBucketCosts(skewed)).toBe(true);
  });
});

/*
 * The ISS-5566 / ISS-5563 reconciliation. Both PRs grew a predicate for "this
 * strip's money is not measured", and this is the merge that has to make them
 * one decision. The three failure modes worth pinning are the ones a textual
 * union would have produced: a MEASURED strip losing its labels to a guard that
 * should not fire, the flag-off path silently REGRESSING ISS-5563's already
 * shipped withdrawal, and the two guards disagreeing so one part of the strip
 * prints money another part has withdrawn.
 */
describe("resolveTimelineCostDisclosure", () => {
  it("leaves a measured strip publishing its money, flag on or off", () => {
    // Persisted buckets: neither predicate can be true, so nothing is withheld
    // and the rail keeps printing. The double-suppression case.
    for (const disclosureEnabled of [true, false]) {
      expect(
        resolveTimelineCostDisclosure({
          costsSynthesized: false,
          disclosureEnabled,
          synthesized: false,
        })
      ).toEqual({ barCostsUnpublished: false, costUnmeasured: false });
    }
  });

  it("withdraws everything on a synthesized strip once the flag is on", () => {
    // The ISS-5566 case that ISS-5563 does not reach: no persisted buckets but a
    // real `estimatedCost`, so the TOTAL is measured while the per-bucket split
    // is invented. One boolean answers for the rail, the stack and the tooltip.
    expect(
      resolveTimelineCostDisclosure({
        costsSynthesized: false,
        disclosureEnabled: true,
        synthesized: true,
      })
    ).toEqual({ barCostsUnpublished: true, costUnmeasured: true });
  });

  it("keeps ISS-5563's ungated label withdrawal while the flag is off", () => {
    // The zero-cost floor case. ISS-5563 shipped this to main unflagged, so the
    // merge must not hand the `$0.001` labels back — but it must ALSO not turn on
    // ISS-5566's flag-gated caption and tooltip changes to do it.
    expect(
      resolveTimelineCostDisclosure({
        costsSynthesized: true,
        disclosureEnabled: false,
        synthesized: true,
      })
    ).toEqual({ barCostsUnpublished: true, costUnmeasured: false });
  });

  it("never publishes labels a broader guard has already withdrawn", () => {
    // `costUnmeasured` implies `barCostsUnpublished` on every input, so the strip
    // cannot end up captioned "not measured" while the rail still prints a
    // figure — the contradiction both issues exist to remove.
    for (const costsSynthesized of [true, false]) {
      for (const disclosureEnabled of [true, false]) {
        for (const synthesized of [true, false]) {
          const { barCostsUnpublished, costUnmeasured } =
            resolveTimelineCostDisclosure({
              costsSynthesized,
              disclosureEnabled,
              synthesized,
            });
          expect(!costUnmeasured || barCostsUnpublished).toBe(true);
        }
      }
    }
  });
});

describe("buildBucketBarLabels", () => {
  const buckets = [bucket(1.02), bucket(0.0025), bucket(0)];
  const maxCost = 1.02;

  it("prints the exact figure for a measured bucket", () => {
    const labels = buildBucketBarLabels({
      buckets,
      costsSynthesized: false,
      maxCost,
      unreadFromIndex: buckets.length,
    });

    // ISS-5563's whole point: not `$1`, which is what the old formatter said
    // for this bucket while two other panels on the same screen said $1.02.
    expect(labels[0]).toBe("$1.02");
  });

  it("prints nothing anywhere when the strip's money was synthesized", () => {
    // The bars still draw — the floor keeps doing its one job — but a
    // placeholder cent spread across buckets must not be published as
    // `$0.001`, four decimals of confidence on a number nobody measured. The
    // same session's Properties Cost row renders a dash one panel above.
    const labels = buildBucketBarLabels({
      buckets,
      costsSynthesized: true,
      maxCost,
      unreadFromIndex: buckets.length,
    });

    expect(labels.every((label) => label === null)).toBe(true);
    expect(labels).toHaveLength(buckets.length);
  });

  it("leaves the unread tail unlabelled", () => {
    const labels = buildBucketBarLabels({
      buckets,
      costsSynthesized: false,
      maxCost,
      unreadFromIndex: 1,
    });

    expect(labels[0]).toBe("$1.02");
    expect(labels[1]).toBeNull();
    expect(labels[2]).toBeNull();
  });

  it("returns one entry per bucket so the rail lines up with the bars", () => {
    // The rail is positional — cell N sits over bar N — so a dropped entry
    // would silently shift every label after it onto the wrong bucket.
    const labels = buildBucketBarLabels({
      buckets,
      costsSynthesized: false,
      maxCost,
      unreadFromIndex: buckets.length,
    });

    expect(labels).toHaveLength(buckets.length);
  });
});
