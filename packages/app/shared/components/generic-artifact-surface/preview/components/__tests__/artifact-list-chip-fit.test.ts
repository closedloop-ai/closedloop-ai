import { describe, expect, it } from "vitest";
import { fitVisibleChipCount } from "../artifact-list-responsive-chips";

/**
 * ISS-12938 visual QA: a row's tags must not collapse to a bare "+N". The
 * overflow chip takes 34px (4px gap plus 30px) whenever a later chip is cut.
 */
describe("fitVisibleChipCount", () => {
  it("keeps the first chip when nothing fits beside the overflow count", () => {
    expect(fitVisibleChipCount([80, 30], 100)).toBe(1);
  });

  it("fits every chip that has room", () => {
    expect(fitVisibleChipCount([40, 30], 100)).toBe(2);
  });

  it("reserves room for the overflow chip before a cut", () => {
    expect(fitVisibleChipCount([40, 30, 30], 100)).toBe(1);
    expect(fitVisibleChipCount([20, 20, 60], 100)).toBe(2);
  });

  it("shows nothing when there is nothing", () => {
    expect(fitVisibleChipCount([], 100)).toBe(0);
  });
});
