import { describe, expect, it } from "vitest";
import { deriveListEmptyReason, ListEmptyReason } from "./list-empty-state";

describe("deriveListEmptyReason (FEA-4181)", () => {
  it("classifies an errored/unhydrated read as Unavailable, above every other signal", () => {
    // Unavailable must win even when filters are active — a failed read tells us
    // nothing, so it can never be reclassified as an honest empty state (no false
    // all-clear).
    expect(
      deriveListEmptyReason({
        isUnavailable: true,
        hasActiveFilters: true,
      })
    ).toBe(ListEmptyReason.Unavailable);

    expect(
      deriveListEmptyReason({
        isUnavailable: true,
        hasActiveFilters: false,
      })
    ).toBe(ListEmptyReason.Unavailable);
  });

  it("classifies a successful zero-row read with an active filter as Filtered", () => {
    expect(
      deriveListEmptyReason({
        isUnavailable: false,
        hasActiveFilters: true,
      })
    ).toBe(ListEmptyReason.Filtered);
  });

  it("classifies a hydrated, unfiltered, empty scope as genuinely Empty", () => {
    // review cid 3653717607: with no active filter the reason is Empty, full
    // stop. The old `totalBeforeFilters > 0` shortcut has been removed — that
    // count was the current filtered `total`, so on a stale out-of-range page it
    // was `> 0` with zero visible rows and mislabeled the page-clamp artifact as
    // "filtered". Hosts must clamp to a valid page before classifying instead.
    expect(
      deriveListEmptyReason({
        isUnavailable: false,
        hasActiveFilters: false,
      })
    ).toBe(ListEmptyReason.Empty);
  });
});
