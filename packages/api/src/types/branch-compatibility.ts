/** Organization-scoped result for a legacy Branch deep-link lookup. */
export const BranchCompatibilityOutcome = {
  Eligible: "eligible",
  Unavailable: "unavailable",
} as const;
export type BranchCompatibilityOutcome =
  (typeof BranchCompatibilityOutcome)[keyof typeof BranchCompatibilityOutcome];

export type BranchCompatibilityResolution =
  | {
      branchArtifactId: string;
      outcome: typeof BranchCompatibilityOutcome.Eligible;
      providerUrl?: string;
    }
  | {
      outcome: typeof BranchCompatibilityOutcome.Unavailable;
    };
