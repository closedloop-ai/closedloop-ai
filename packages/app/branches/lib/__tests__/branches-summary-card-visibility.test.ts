import { describe, expect, it } from "vitest";
import {
  BRANCHES_SUMMARY_CARD_IDS,
  branchesSummaryCardOptions,
  resolveBranchesSummaryCardVisibility,
} from "../branches-summary-card-visibility";

describe("ISS-12664 Branches summary-card visibility", () => {
  it("lists one menu row per card, in the strip's order", () => {
    const options = branchesSummaryCardOptions((id) => `label:${id}`);

    expect(options.map((option) => option.key)).toEqual([
      ...BRANCHES_SUMMARY_CARD_IDS,
    ]);
    expect(options[0]).toEqual({
      key: BRANCHES_SUMMARY_CARD_IDS[0],
      label: `label:${BRANCHES_SUMMARY_CARD_IDS[0]}`,
    });
  });

  it("treats an absent hidden set as every card shown", () => {
    const { allHidden, visibleCardKeys } =
      resolveBranchesSummaryCardVisibility(undefined);

    expect(allHidden).toBe(false);
    expect([...visibleCardKeys]).toEqual([...BRANCHES_SUMMARY_CARD_IDS]);
  });

  it("drops only the hidden ids and ignores ids it does not know", () => {
    const [first, ...rest] = BRANCHES_SUMMARY_CARD_IDS;

    const { allHidden, visibleCardKeys } = resolveBranchesSummaryCardVisibility(
      new Set([first, "card-from-a-newer-build"])
    );

    expect(allHidden).toBe(false);
    expect([...visibleCardKeys]).toEqual(rest);
  });

  it("reports allHidden only when every card is hidden", () => {
    expect(
      resolveBranchesSummaryCardVisibility(new Set(BRANCHES_SUMMARY_CARD_IDS))
        .allHidden
    ).toBe(true);
  });
});
