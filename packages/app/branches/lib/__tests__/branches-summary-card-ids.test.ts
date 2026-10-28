import { describe, expect, it } from "vitest";
import { BRANCHES_SUMMARY_CANONICAL_CARD_SPECS } from "../../components/approved-branches-summary-cards";
import { CANONICAL_BRANCH_SUMMARY_CARD_IDS } from "../branches-summary-card-ids";

/**
 * ISS-10645: the desktop route's loading fallback names its cards from the
 * React-free id list, because it must stay a static import. That list is only
 * honest while it is the order the live strip actually paints, so it is pinned
 * to the specs here rather than trusted.
 */
describe("Branches summary card ids", () => {
  it("matches the canonical row the live strip paints", () => {
    expect(CANONICAL_BRANCH_SUMMARY_CARD_IDS).toEqual(
      BRANCHES_SUMMARY_CANONICAL_CARD_SPECS.map((card) => card.id)
    );
  });
});
