/**
 * Canonical Product-navigation decision projected for a Branch Artifact.
 *
 * The field is optional on additive wire shapes: omission means the producer
 * cannot prove eligibility and consumers must fail closed. Producers emit only
 * the two settled decisions below; presentation code never derives this value
 * from row existence, commit evidence, or a local Session link.
 */
export const BranchProductEligibility = {
  Eligible: "eligible",
  Ineligible: "ineligible",
} as const;
export type BranchProductEligibility =
  (typeof BranchProductEligibility)[keyof typeof BranchProductEligibility];
