import { describe, expect, it } from "vitest";
import {
  NumeratorContribution,
  NumeratorEntity,
  normalizePersonMetrics,
  PENSERO_METRIC_NORMALIZATION,
  PenseroMetric,
  type PenseroPersonDeliveryRecord,
} from "../normalization";

describe("Pensero normalization contract", () => {
  it("maps every consumed metric to a target entity (exhaustive)", () => {
    // The Record type makes this exhaustive at compile time; assert at runtime
    // that no member resolves to an undefined rule.
    for (const metric of Object.values(PenseroMetric)) {
      const rule = PENSERO_METRIC_NORMALIZATION[metric];
      expect(rule).toBeDefined();
      expect(Object.values(NumeratorEntity)).toContain(rule.entity);
      expect(Object.values(NumeratorContribution)).toContain(rule.contribution);
    }
  });

  it("never attributes a metric to a person (entity is session/branch/PR only)", () => {
    const targets = new Set(
      Object.values(PENSERO_METRIC_NORMALIZATION).map((r) => r.entity)
    );
    expect(targets.has(NumeratorEntity.Session)).toBe(true);
    expect([...targets].every((t) => t !== ("person" as unknown))).toBe(true);
  });

  it("charges a PR metric to the PR id, not the person", () => {
    const records: PenseroPersonDeliveryRecord[] = [
      {
        personId: "person-1",
        prId: "pr-42",
        metrics: { [PenseroMetric.MergedPullRequests]: 3 },
      },
    ];
    const out = normalizePersonMetrics(records);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metric: PenseroMetric.MergedPullRequests,
      entity: NumeratorEntity.Pr,
      entityId: "pr-42",
      value: 3,
    });
  });

  it("charges a branch metric to the branch id and a session metric to the session id", () => {
    const records: PenseroPersonDeliveryRecord[] = [
      {
        personId: "person-1",
        branchId: "branch-7",
        sessionId: "session-9",
        metrics: {
          [PenseroMetric.DeliveredFeatures]: 2,
          [PenseroMetric.CycleTimeHours]: 5,
        },
      },
    ];
    const out = normalizePersonMetrics(records);
    const byMetric = new Map(out.map((c) => [c.metric, c]));
    expect(byMetric.get(PenseroMetric.DeliveredFeatures)).toMatchObject({
      entity: NumeratorEntity.Branch,
      entityId: "branch-7",
    });
    expect(byMetric.get(PenseroMetric.CycleTimeHours)).toMatchObject({
      entity: NumeratorEntity.Session,
      entityId: "session-9",
      invert: true,
    });
  });

  it("skips a metric when its target entity's correlation id is absent", () => {
    // Person has a session id but the metric targets a PR — no prId, so it is
    // un-correlated and must be dropped, NOT charged to the person or session.
    const records: PenseroPersonDeliveryRecord[] = [
      {
        personId: "person-1",
        sessionId: "session-9",
        metrics: { [PenseroMetric.MergedPullRequests]: 4 },
      },
    ];
    expect(normalizePersonMetrics(records)).toHaveLength(0);
  });

  it("emits only the metrics that are present on a record", () => {
    const records: PenseroPersonDeliveryRecord[] = [
      {
        personId: "person-1",
        prId: "pr-1",
        branchId: "branch-1",
        sessionId: "session-1",
        metrics: { [PenseroMetric.ResolvedReviewComments]: 6 },
      },
    ];
    const out = normalizePersonMetrics(records);
    expect(out.map((c) => c.metric)).toEqual([
      PenseroMetric.ResolvedReviewComments,
    ]);
  });

  it("ignores non-metric keys, including prototype-chain keys, without crashing", () => {
    // A raw/un-validated record whose metrics map carries keys that are not
    // consumed metrics — including a JSON `constructor` key that would resolve
    // through the normalization table's prototype chain — must be skipped, not
    // crash on an undefined rule or mis-index the dispatch table.
    const hostile = JSON.parse(
      '{"personId":"p1","prId":"pr-1","metrics":{"constructor":9,"__proto__":9,"unknown_metric":9,"merged_pull_requests":2}}'
    ) as PenseroPersonDeliveryRecord;
    const out = normalizePersonMetrics([hostile]);
    expect(out.map((c) => c.metric)).toEqual([
      PenseroMetric.MergedPullRequests,
    ]);
  });

  it("carries the correct fold mode for quality vs additive metrics", () => {
    expect(
      PENSERO_METRIC_NORMALIZATION[PenseroMetric.MergedPullRequests]
        .contribution
    ).toBe(NumeratorContribution.Additive);
    expect(
      PENSERO_METRIC_NORMALIZATION[PenseroMetric.ReviewThoroughness]
        .contribution
    ).toBe(NumeratorContribution.Quality);
  });
});
