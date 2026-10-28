/**
 * ISS-9831 — the window-to-bucket split, held against arithmetic rather than a
 * mock. Everything here is a pure function of two `Date`s, so these cases pin
 * WHICH days the read may take whole and WHICH instants it must go to the source
 * for. That the resulting totals are correct is a question only Postgres can
 * answer, and `branch-analytics-rollup.integration.test.ts` asks it there.
 */
import { describe, expect, it } from "vitest";
import { renderSql } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  branchAnalyticsRollupEdgePartsSql,
  planBranchAnalyticsRollupWindow,
} from "./branch-analytics-rollup-window";

const ORGANIZATION_ID = "11111111-1111-7111-8111-111111111111";
const AS_OF = new Date("2026-09-11T18:00:00.000Z");

describe("planBranchAnalyticsRollupWindow", () => {
  it("takes a day-aligned picker window entirely from whole buckets", () => {
    const plan = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T00:00:00.000Z"),
      endDate: new Date("2026-09-11T23:59:59.999Z"),
    });

    expect(plan).toEqual({
      wholeBucketStart: new Date("2026-09-05T00:00:00.000Z"),
      wholeBucketEndExclusive: new Date("2026-09-12T00:00:00.000Z"),
      headRange: null,
      tailRange: null,
    });
  });

  it("splits an arbitrary-instant cohort window into whole days plus both edges", () => {
    const plan = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T12:00:00.000Z"),
      endDate: new Date("2026-09-11T17:00:00.000Z"),
    });

    expect(plan).toEqual({
      // 09-05 is only half covered, so the first WHOLE bucket is 09-06 and the
      // last is 09-10 — 09-11 stops at 17:00.
      wholeBucketStart: new Date("2026-09-06T00:00:00.000Z"),
      wholeBucketEndExclusive: new Date("2026-09-11T00:00:00.000Z"),
      headRange: {
        startInclusive: new Date("2026-09-05T12:00:00.000Z"),
        endExclusive: new Date("2026-09-06T00:00:00.000Z"),
      },
      tailRange: {
        startInclusive: new Date("2026-09-11T00:00:00.000Z"),
        endInclusive: new Date("2026-09-11T17:00:00.000Z"),
      },
    });
  });

  it("keeps the final day whole only when the bound is its last representable instant", () => {
    const wholeDay = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T00:00:00.000Z"),
      endDate: new Date("2026-09-11T23:59:59.999Z"),
    });
    const oneTickShort = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T00:00:00.000Z"),
      endDate: new Date("2026-09-11T23:59:59.998Z"),
    });

    expect(wholeDay?.wholeBucketEndExclusive).toEqual(
      new Date("2026-09-12T00:00:00.000Z")
    );
    expect(wholeDay?.tailRange).toBeNull();
    // One millisecond earlier the bucket would over-count, so 09-11 becomes an
    // edge day read from the source instead.
    expect(oneTickShort?.wholeBucketEndExclusive).toEqual(
      new Date("2026-09-11T00:00:00.000Z")
    );
    expect(oneTickShort?.tailRange).toEqual({
      startInclusive: new Date("2026-09-11T00:00:00.000Z"),
      endInclusive: new Date("2026-09-11T23:59:59.998Z"),
    });
  });

  it("refuses a window too narrow to contain a whole day", () => {
    const withinOneDay = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T06:00:00.000Z"),
      endDate: new Date("2026-09-05T18:00:00.000Z"),
    });
    const straddlingMidnight = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T06:00:00.000Z"),
      endDate: new Date("2026-09-06T18:00:00.000Z"),
    });

    // Answering either from here would run the fallback's own aggregate and
    // report it as a rollup hit.
    expect(withinOneDay).toBeUndefined();
    expect(straddlingMidnight).toBeUndefined();
  });

  it("refuses an inverted window", () => {
    expect(
      planBranchAnalyticsRollupWindow({
        startDate: new Date("2026-09-11T00:00:00.000Z"),
        endDate: new Date("2026-09-05T00:00:00.000Z"),
      })
    ).toBeUndefined();
  });

  it("leaves an open side unbounded rather than inventing an edge for it", () => {
    const openAbove = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T12:00:00.000Z"),
    });
    const openBelow = planBranchAnalyticsRollupWindow({
      endDate: new Date("2026-09-11T23:59:59.999Z"),
    });

    expect(openAbove).toEqual({
      wholeBucketStart: new Date("2026-09-06T00:00:00.000Z"),
      wholeBucketEndExclusive: null,
      headRange: {
        startInclusive: new Date("2026-09-05T12:00:00.000Z"),
        endExclusive: new Date("2026-09-06T00:00:00.000Z"),
      },
      tailRange: null,
    });
    expect(openBelow).toEqual({
      wholeBucketStart: null,
      wholeBucketEndExclusive: new Date("2026-09-12T00:00:00.000Z"),
      headRange: null,
      tailRange: null,
    });
  });
});

describe("branchAnalyticsRollupEdgePartsSql", () => {
  it("emits no source read at all when both bounds are day-aligned", () => {
    const plan = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T00:00:00.000Z"),
      endDate: new Date("2026-09-11T23:59:59.999Z"),
    });
    if (!plan) {
      throw new Error("expected a plan for a day-aligned window");
    }

    const sql = branchAnalyticsRollupEdgePartsSql(ORGANIZATION_ID, plan, AS_OF);

    expect(renderSql(sql)).not.toContain("agent_session_token_events");
  });

  it("bounds each edge read to its own partial day", () => {
    const plan = planBranchAnalyticsRollupWindow({
      startDate: new Date("2026-09-05T12:00:00.000Z"),
      endDate: new Date("2026-09-11T17:00:00.000Z"),
    });
    if (!plan) {
      throw new Error("expected a plan for a non-aligned window");
    }

    const sql = renderSql(
      branchAnalyticsRollupEdgePartsSql(ORGANIZATION_ID, plan, AS_OF)
    );

    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("FROM requested_sessions requested");
    // Half-open at the head so the boundary instant belongs to the bucket, and
    // inclusive at the tail because that bound is the caller's own.
    expect(sql).toContain("event.event_created_at >=");
    expect(sql).toContain("event.event_created_at <");
    expect(sql).toContain("event.event_created_at <=");
    // Pinned to the rollup's clock, not the wall clock, so both halves of the
    // answer describe one instant.
    expect(sql).toContain("event.created_at <=");
  });
});
