// The `deriveStallSample` half of the stall cron's derivation suite. The
// `deriveFailedGroups` verdict is covered by the sibling
// `derive-failed-groups.test.ts`, split out when the combined file crossed the
// 1,000-line ceiling (ISS-5386).
import type { MergeQueueState } from "@repo/github/merge-queue";
import { describe, expect, it } from "vitest";
import { deriveStallSample, StallSampleStatus } from "./derive";
import { NOW, ageQueue as queue } from "./merge-queue-entry-fixtures";

function okSample(state: MergeQueueState) {
  const sample = deriveStallSample(state, NOW);
  if (sample.status !== StallSampleStatus.Ok) {
    throw new Error(`expected an Ok sample, got ${sample.status}`);
  }
  return sample;
}

describe("deriveStallSample", () => {
  it("reports a truthful zero for an empty queue rather than nothing", () => {
    // An empty queue and an unreadable one must not look alike downstream: 0 is
    // a measurement that lets the monitor recover, absence means broken.
    expect(okSample(queue([]))).toMatchObject({ depth: 0, groupAgeMinutes: 0 });
  });

  it("takes the max across built entries, so a wedged NON-head group is seen", () => {
    // The ALLGREEN partial-stall case: the head is young and fine while a group
    // behind it has been under test for 95 minutes. A head-only metric would
    // report 5 and the stall would page nobody.
    expect(okSample(queue([5, 12, 95])).groupAgeMinutes).toBe(95);
  });

  it("does not depend on the order entries arrive in", () => {
    // GraphQL does not document node ordering. Asserted as the property — two
    // orderings of the same queue must agree — so a `nodes[0]` implementation
    // cannot satisfy it by luck.
    expect(okSample(queue([95, 5, 12])).groupAgeMinutes).toBe(
      okSample(queue([5, 12, 95])).groupAgeMinutes
    );
  });

  it("counts unbuilt entries toward depth but excludes them from the age", () => {
    // Counting an unbuilt entry as old would reintroduce the queue-depth
    // confound that makes `enqueuedAt` unusable as the metric.
    expect(okSample(queue([40, null, null]))).toMatchObject({
      depth: 3,
      groupAgeMinutes: 40,
    });
  });

  it("reports age 0 when nothing is built yet, which is not an error", () => {
    expect(okSample(queue([null, null]))).toMatchObject({
      depth: 2,
      groupAgeMinutes: 0,
    });
  });

  it("clamps a group formed after the clock was read to 0, not a negative age", () => {
    // The clock is read before the API call, so a just-formed group is "newer
    // than now". A negative age is not a meaningful reading on this graph.
    expect(okSample(queue([-2 / 60])).groupAgeMinutes).toBe(0);
  });

  it("rounds a non-terminating age to two decimals", () => {
    // 100 seconds = 1.6666... minutes. A terminating fixture would pass with
    // the rounding removed, so it could not catch a regression in it.
    expect(okSample(queue([100 / 60])).groupAgeMinutes).toBe(1.67);
  });

  it("refuses to derive an age when the queue is deeper than the page", () => {
    // A built, possibly stalled group could sit on a page we never fetched, so
    // the max would understate — potentially to a falsely healthy 0.
    expect(deriveStallSample(queue([10, 4], 137), NOW)).toEqual({
      status: StallSampleStatus.Truncated,
      depth: 137,
    });
  });

  it("does not refuse when the page exactly covers the queue", () => {
    // The boundary: totalCount === nodes.length is complete, not truncated.
    expect(deriveStallSample(queue([10, 4], 2), NOW).status).toBe(
      StallSampleStatus.Ok
    );
  });

  it("never reports a depth below the number of entries it measured", () => {
    // Reconciliation invariant: the diagnostic and the paging signal are
    // derived from one population, so depth cannot contradict the age sample.
    const state = queue([30, null, 12]);
    const sample = okSample(state);
    expect(sample.depth).toBe(state.entries.nodes.length);
    expect(sample.groupAgeMinutes).toBeLessThanOrEqual(30);
  });
});
