import {
  type BranchProductEligibility,
  BranchProductEligibility as BranchProductEligibilityValue,
} from "@repo/api/src/types/branch-product-eligibility";

export const BranchNavigationDisposition = {
  CanonicalDetails: "canonical_details",
  Compatibility: "compatibility",
  Unavailable: "unavailable",
} as const;
export type BranchNavigationDisposition =
  (typeof BranchNavigationDisposition)[keyof typeof BranchNavigationDisposition];

export type BranchDetailsNavigation =
  | {
      disposition: typeof BranchNavigationDisposition.CanonicalDetails;
      href: string;
    }
  | {
      disposition: typeof BranchNavigationDisposition.Compatibility;
      href: string;
    }
  | {
      disposition: typeof BranchNavigationDisposition.Unavailable;
      href: null;
    };

/**
 * Resolve an org-relative Branch destination from API-owned eligibility and
 * provider-fallback projections. Missing and unknown values fail closed.
 */
export function resolveBranchDetailsNavigation(input: {
  branchArtifactId: string;
  hasCompatibilityProviderFallback?: boolean;
  productEligibility?: BranchProductEligibility;
  rolloutEnabled: boolean;
}): BranchDetailsNavigation {
  if (input.productEligibility !== BranchProductEligibilityValue.Eligible) {
    return {
      disposition: BranchNavigationDisposition.Unavailable,
      href: null,
    };
  }
  if (!input.rolloutEnabled) {
    if (input.hasCompatibilityProviderFallback !== true) {
      return {
        disposition: BranchNavigationDisposition.Unavailable,
        href: null,
      };
    }
    return {
      disposition: BranchNavigationDisposition.Compatibility,
      href: `/build/${encodeURIComponent(input.branchArtifactId)}`,
    };
  }
  return {
    disposition: BranchNavigationDisposition.CanonicalDetails,
    href: `/branches/${encodeURIComponent(input.branchArtifactId)}`,
  };
}
