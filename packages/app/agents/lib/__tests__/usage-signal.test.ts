/**
 * ISS-5363 (wongk review): the three-state usage signal every component-detail
 * surface keys its empty state off.
 *
 * `AgentComponentDetail.sessions` is `number | null` on the wire and a
 * version-skewed producer can omit it entirely. `componentMetrics` already
 * dashed on both; the tabs and the token-trend chart coerced them to `0` and
 * then printed a confident denial under a dashed card. These pin that an
 * un-measurable count can never resolve to the denial branch.
 */

import { describe, expect, it } from "vitest";
import { resolveUsageSignal, UsageSignal } from "../usage-signal";

describe("resolveUsageSignal", () => {
  it("reports a measured positive count as Present", () => {
    expect(resolveUsageSignal(3, 0)).toBe(UsageSignal.Present);
  });

  it("reports a measured zero as None — the only state safe to deny", () => {
    expect(resolveUsageSignal(0, 0)).toBe(UsageSignal.None);
  });

  it("reports an explicit null count as Unknown, NOT as a zero", () => {
    // The producer said "I could not compute this". Coercing it to 0 is what
    // printed "No sessions yet" beside a dashed Sessions card.
    expect(resolveUsageSignal(null, 0)).toBe(UsageSignal.Unknown);
  });

  it("reports an omitted count (version skew) as Unknown", () => {
    expect(resolveUsageSignal(undefined, 0)).toBe(UsageSignal.Unknown);
  });

  it("reports a non-finite count as Unknown rather than formatting it", () => {
    expect(resolveUsageSignal(Number.NaN, 0)).toBe(UsageSignal.Unknown);
  });

  it("treats attributed usage rows as evidence even when the count is unknown", () => {
    // Desktop's local detail can carry attribution rows without a count; that is
    // still proof usage exists, so the surface must not fall to Unknown.
    expect(resolveUsageSignal(null, 2)).toBe(UsageSignal.Present);
  });

  it("treats attributed usage rows as evidence even against a zero count", () => {
    expect(resolveUsageSignal(0, 2)).toBe(UsageSignal.Present);
  });
});
