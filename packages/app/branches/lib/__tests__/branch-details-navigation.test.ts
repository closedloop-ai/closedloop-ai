import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import { describe, expect, it } from "vitest";
import {
  BranchNavigationDisposition,
  resolveBranchDetailsNavigation,
} from "../branch-details-navigation";

describe("resolveBranchDetailsNavigation", () => {
  it("returns the canonical Details href only for explicit eligibility", () => {
    expect(
      resolveBranchDetailsNavigation({
        branchArtifactId: "branch id",
        productEligibility: BranchProductEligibility.Eligible,
        rolloutEnabled: true,
      })
    ).toEqual({
      disposition: BranchNavigationDisposition.CanonicalDetails,
      href: "/branches/branch%20id",
    });
  });

  it("keeps an explicitly eligible row on the compatibility path while rollout is off", () => {
    expect(
      resolveBranchDetailsNavigation({
        branchArtifactId: "branch id",
        hasCompatibilityProviderFallback: true,
        productEligibility: BranchProductEligibility.Eligible,
        rolloutEnabled: false,
      })
    ).toEqual({
      disposition: BranchNavigationDisposition.Compatibility,
      href: "/build/branch%20id",
    });
  });

  it.each([
    { label: "omitted", value: undefined },
    { label: "false", value: false },
  ])(
    "does not expose a default-off compatibility link when fallback is $label",
    ({ value }) => {
      expect(
        resolveBranchDetailsNavigation({
          branchArtifactId: "branch-1",
          hasCompatibilityProviderFallback: value,
          productEligibility: BranchProductEligibility.Eligible,
          rolloutEnabled: false,
        })
      ).toEqual({
        disposition: BranchNavigationDisposition.Unavailable,
        href: null,
      });
    }
  );

  it.each([
    {
      label: "explicitly ineligible",
      value: BranchProductEligibility.Ineligible,
    },
    { label: "version-skewed omission", value: undefined },
  ])("fails closed for $label", ({ value }) => {
    expect(
      resolveBranchDetailsNavigation({
        branchArtifactId: "branch-1",
        productEligibility: value,
        rolloutEnabled: true,
      })
    ).toEqual({
      disposition: BranchNavigationDisposition.Unavailable,
      href: null,
    });
  });
});
