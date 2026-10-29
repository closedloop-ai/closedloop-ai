import { describe, expect, it } from "vitest";
import { isSummaryMetricsLoading } from "../summary-metrics-loading";

/**
 * ISS-9887. Both list summary metric strips — Sessions and Branches — reach
 * their loading answer through this one predicate, so an edit that inverted it,
 * or ANDed the two inputs instead of ORing them, would change what BOTH surfaces
 * render while every component suite kept passing on the case it happened to
 * cover. Pinned here at the predicate's own boundary rather than only observed
 * through two component trees.
 */
describe("isSummaryMetricsLoading", () => {
  it("is loading while no payload for this scope has arrived", () => {
    expect(
      isSummaryMetricsLoading({
        isPending: true,
        isServingPreviousScope: false,
      })
    ).toBe(true);
  });

  it("is loading while the payload in hand belongs to the previous scope", () => {
    // The ISS-9887 defect: Branches read this as settled and stated the previous
    // window's figures as current.
    expect(
      isSummaryMetricsLoading({
        isPending: false,
        isServingPreviousScope: true,
      })
    ).toBe(true);
  });

  it("is loading when both hold", () => {
    expect(
      isSummaryMetricsLoading({ isPending: true, isServingPreviousScope: true })
    ).toBe(true);
  });

  it("is settled only when neither holds", () => {
    expect(
      isSummaryMetricsLoading({
        isPending: false,
        isServingPreviousScope: false,
      })
    ).toBe(false);
  });
});
