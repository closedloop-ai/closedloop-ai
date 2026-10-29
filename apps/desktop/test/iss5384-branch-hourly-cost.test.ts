import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { getSharedBranchUsage } from "../src/main/branch/shared-branches-api.js";
import {
  eventFromToken,
  link,
  makeSource,
} from "./shared-branches-test-helpers.js";

vi.mock(
  "../src/main/branch/shared-branches-default-eligibility.js",
  async (importOriginal) =>
    (
      await import("./helpers/complete-eligibility-snapshot.js")
    ).withCompleteEligibility(await importOriginal())
);

describe("ISS-5384 branch hourly cost buckets", () => {
  test("windowed hour buckets sum captured event cost, matching the headline", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "a", session_id: "s1", billing_mode: "api" }),
        link({
          branch_name: "a",
          session_id: "s2",
          billing_mode: "subscription_unknown",
        }),
        link({ branch_name: "a", session_id: "s3", billing_mode: "api" }),
      ],
      usageEvents: [
        {
          ...eventFromToken("s1", "2026-06-20T10:15:00.000Z", 1000, 500, 0.25),
          billing_mode: "api",
        },
        {
          ...eventFromToken("s2", "2026-06-20T10:30:00.000Z", 1000, 500, null),
          billing_mode: "subscription_unknown",
        },
        {
          ...eventFromToken("s3", "2026-06-20T11:15:00.000Z", 1000, 500, 0.75),
          billing_mode: "api",
        },
      ],
    });

    const summary = await getSharedBranchUsage(source, {
      startDate: "2026-06-20T00:00:00.000Z",
      endDate: "2026-06-21T00:00:00.000Z",
    });

    assert.equal(summary.totalEstimatedCost, 1);
    assert.equal(hourlyCost(summary.hourBuckets), summary.totalEstimatedCost);
    assert.deepEqual(
      summary.hourBuckets.map((bucket) => [
        bucket.hourStart,
        hourlyCost([bucket]),
      ]),
      [
        ["2026-06-20T10:00:00.000Z", 0.25],
        ["2026-06-20T11:00:00.000Z", 0.75],
      ]
    );
  });

  test("all-time hour buckets use captured event costs when totals come from aggregates", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "a", session_id: "s1", billing_mode: "api" }),
      ],
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-6",
          input_tokens: 2000,
          output_tokens: 1000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd_estimated: 7.5,
          created_at: "2026-06-20T10:00:00.000Z",
        },
      ],
      usageEvents: [
        eventFromToken("s1", "2026-06-20T10:15:00.000Z", 1000, 500, 2.5),
        eventFromToken("s1", "2026-06-20T11:15:00.000Z", 1000, 500, 5),
      ],
    });

    const summary = await getSharedBranchUsage(source);

    assert.equal(summary.totalEstimatedCost, 7.5);
    assert.equal(hourlyCost(summary.hourBuckets), summary.totalEstimatedCost);
    assert.deepEqual(
      summary.hourBuckets.map((bucket) => [
        bucket.hourStart,
        hourlyCost([bucket]),
      ]),
      [
        ["2026-06-20T10:00:00.000Z", 2.5],
        ["2026-06-20T11:00:00.000Z", 5],
      ]
    );
  });
});

function hourlyCost(
  hourBuckets: Awaited<ReturnType<typeof getSharedBranchUsage>>["hourBuckets"]
): number {
  return hourBuckets.reduce(
    (total, bucket) =>
      total +
      bucket.byActor.reduce(
        (bucketTotal, actor) => bucketTotal + actor.estimatedCostUsd,
        0
      ),
    0
  );
}
