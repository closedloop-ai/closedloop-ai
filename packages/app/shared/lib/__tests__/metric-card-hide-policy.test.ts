import { hiddenMetricCardIds } from "@repo/app/shared/lib/metric-card-hide-policy";
import { describe, expect, it } from "vitest";

/**
 * ISS-9749, ISS-9730 acceptance 3. The all-or-nothing rule is the DECISION about
 * what a zero-card row looks like, so it is asserted here once rather than
 * re-derived by each row that spends it.
 */
describe("metric-card hide policy", () => {
  it("hides only the not-computable cards while one survives", () => {
    expect([
      ...hiddenMetricCardIds({
        cards: [
          { id: "spend", notComputable: true },
          { id: "active", notComputable: false },
          { id: "loc", notComputable: true },
        ],
        enabled: true,
      }),
    ]).toEqual(["spend", "loc"]);
  });

  /**
   * The decision itself. Its sibling above is what stops this passing vacuously:
   * the same two not-computable cards DO hide when a third resolves, so a
   * predicate that simply never hid anything would fail there.
   */
  it("hides nothing when every card in the row is not computable", () => {
    expect(
      hiddenMetricCardIds({
        cards: [
          { id: "spend", notComputable: true },
          { id: "loc", notComputable: true },
        ],
        enabled: true,
      }).size
    ).toBe(0);
  });

  it("hides nothing with the gate off, on a row it would otherwise thin", () => {
    expect(
      hiddenMetricCardIds({
        cards: [
          { id: "spend", notComputable: true },
          { id: "active", notComputable: false },
        ],
        enabled: false,
      }).size
    ).toBe(0);
  });
});
