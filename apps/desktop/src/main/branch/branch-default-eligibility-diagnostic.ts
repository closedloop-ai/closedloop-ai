import type { BranchCloudHydrationStatus } from "@repo/api/src/types/branch";
import {
  RepositoryDefaultReason,
  type RepositoryDefaultReason as RepositoryDefaultReasonValue,
} from "@repo/api/src/types/repository-default-identity";

/** Stable message retained by the internal typed failure and no public payload. */
export const BRANCH_DEFAULT_ELIGIBILITY_UNAVAILABLE_MESSAGE =
  "repository default eligibility unavailable";

/** Bounded reason metadata retained only inside the Desktop main process. */
export type BranchDefaultEligibilityDiagnostic = {
  status: BranchCloudHydrationStatus;
  repositoryDefaultReasons: readonly RepositoryDefaultReasonValue[];
};

/** Internal typed error that carries no repository, credential, or provider text. */
export class BranchDefaultEligibilityUnavailableError extends Error {
  readonly name = "BranchDefaultEligibilityUnavailableError";
  readonly diagnostic: BranchDefaultEligibilityDiagnostic;

  constructor(diagnostic: BranchDefaultEligibilityDiagnostic) {
    super(BRANCH_DEFAULT_ELIGIBILITY_UNAVAILABLE_MESSAGE);
    this.diagnostic = diagnostic;
  }
}

/** Normalize one diagnostic to the canonical closed reason order. */
export function createBranchDefaultEligibilityDiagnostic(input: {
  status: BranchCloudHydrationStatus;
  reasons: Iterable<RepositoryDefaultReasonValue>;
}): BranchDefaultEligibilityDiagnostic {
  const selected = new Set(input.reasons);
  const repositoryDefaultReasons = Object.values(
    RepositoryDefaultReason
  ).filter((reason) => selected.has(reason));
  return {
    status: input.status,
    repositoryDefaultReasons,
  };
}

/** Render only closed vocabulary members for the persistent main-process log. */
export function formatBranchDefaultEligibilityDiagnostic(
  diagnostic: BranchDefaultEligibilityDiagnostic
): string {
  return [
    `status=${diagnostic.status}`,
    `reasons=${diagnostic.repositoryDefaultReasons.join(",") || "none"}`,
  ].join(" ");
}
