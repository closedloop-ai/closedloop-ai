import { describe, expect, it } from "vitest";
import { BranchProductEligibility } from "./branch-product-eligibility.js";

describe("BranchProductEligibility", () => {
  it("keeps the emitted vocabulary closed to eligible and ineligible", () => {
    expect(Object.values(BranchProductEligibility)).toEqual([
      "eligible",
      "ineligible",
    ]);
  });
});
