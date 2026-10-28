/**
 * ISS-8424: the three states an org-merged population can be in, and which one
 * is entitled to print a number.
 *
 * The defect these cases exist against is specific: an OAuth-only org whose
 * session-linked merged PRs have never been verified rendered `0`, which reads
 * as a measured "you merged nothing". A `0` and a `null` are asserted APART
 * here on purpose — a case that only checked "no number is shown" would pass
 * against the old behavior too, since `0` is falsy.
 */

import { kpi } from "@closedloop-ai/loops-api/insights";
import { KpiFormat } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_KPI_DERIVED_FROM_MERGED_PRS,
  isMergedPrPopulationUnmeasured,
  withUnmeasuredMergedPrKpis,
} from "./delivery-measurement";

describe("isMergedPrPopulationUnmeasured", () => {
  it("calls a session-linked population with nothing verified unmeasured", () => {
    expect(
      isMergedPrPopulationUnmeasured({
        hasSessionLinkedMergedPrs: true,
        hasVerifiedMergedPrs: false,
      })
    ).toBe(true);
  });

  it("calls a partially verified population measured", () => {
    // The exact funnel Kerensa measured after the manual resync: 87 session-linked,
    // 79 verified. Some verification has landed, so the figures are real.
    expect(
      isMergedPrPopulationUnmeasured({
        hasSessionLinkedMergedPrs: true,
        hasVerifiedMergedPrs: true,
      })
    ).toBe(false);
  });

  it("calls an org with no session-linked merged PRs measured, not unmeasured", () => {
    // PRD-683 Rulings 1/2 make session-linkage the definition of the
    // population, so an empty one is a real zero. Without this arm every quiet
    // org's honest 0 would become an em dash.
    expect(
      isMergedPrPopulationUnmeasured({
        hasSessionLinkedMergedPrs: false,
        hasVerifiedMergedPrs: false,
      })
    ).toBe(false);
  });
});

describe("withUnmeasuredMergedPrKpis", () => {
  it("nulls merged-PR-derived values and leaves session cost alone", () => {
    const result = withUnmeasuredMergedPrKpis([
      kpi("merged", "Merged PRs", 0, KpiFormat.Number, "PRs merged in range"),
      kpi("kloc", "KLOC merged", 0, KpiFormat.Number, "thousand lines"),
      kpi("pr-size", "Median PR size", 0, KpiFormat.Number, "lines"),
      kpi("cost", "Cost", 412.5, KpiFormat.Currency, "session spend"),
    ]);

    const byKey = new Map(result.map((stat) => [stat.key, stat.value]));
    // `toBeNull`, never `toBeFalsy`: the value this replaces is `0`, and a
    // falsy assertion cannot tell the fabricated measurement from the honest
    // absence of one.
    expect(byKey.get("merged")).toBeNull();
    expect(byKey.get("kloc")).toBeNull();
    expect(byKey.get("pr-size")).toBeNull();
    expect(byKey.get("cost")).toBe(412.5);
  });

  it("nulls the delta too, so no movement is claimed against an unmeasured base", () => {
    const [stat] = withUnmeasuredMergedPrKpis([
      {
        ...kpi("merged", "Merged PRs", 0, KpiFormat.Number, "PRs merged"),
        deltaPct: -100,
      },
    ]);

    expect(stat?.value).toBeNull();
    expect(stat?.deltaPct).toBeNull();
  });

  it("classifies session cost as not merged-PR-derived", () => {
    expect(DELIVERY_KPI_DERIVED_FROM_MERGED_PRS.cost).toBe(false);
  });
});
