import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { z } from "zod";

/** Product decision for a branch after resolving authoritative repository data. */
export const BranchDefaultEligibilityOutcome = {
  Included: "included",
  Excluded: "excluded",
} as const;
export type BranchDefaultEligibilityOutcome =
  (typeof BranchDefaultEligibilityOutcome)[keyof typeof BranchDefaultEligibilityOutcome];

/** Whether exclusion is the proven default or missing/unusable authority. */
export const BranchDefaultExclusionCause = {
  AuthorityUnavailable: "authority_unavailable",
  DefaultBranch: "default_branch",
} as const;
export type BranchDefaultExclusionCause =
  (typeof BranchDefaultExclusionCause)[keyof typeof BranchDefaultExclusionCause];

export type BranchDefaultEligibilityDecision =
  | {
      outcome: typeof BranchDefaultEligibilityOutcome.Included;
      authority: NormalizedPersistedRepositoryDefaultAuthority;
    }
  | {
      outcome: typeof BranchDefaultEligibilityOutcome.Excluded;
      cause: typeof BranchDefaultExclusionCause.DefaultBranch;
      authority: NormalizedPersistedRepositoryDefaultAuthority;
    }
  | {
      outcome: typeof BranchDefaultEligibilityOutcome.Excluded;
      cause: typeof BranchDefaultExclusionCause.AuthorityUnavailable;
      reason: RepositoryDefaultReason;
    };

const branchCandidateSchema = z
  .object({
    provider: z.enum(VcsProviderKind),
    providerRepositoryId: z.string().trim().min(1).optional(),
    repositoryFullName: z
      .string()
      .transform(normalizeRepoFullName)
      .refine((value) => REPOSITORY_FULL_NAME_RE.test(value)),
    branchName: z.string().trim().min(1),
  })
  .strict();

export type BranchDefaultEligibilityCandidate = z.infer<
  typeof branchCandidateSchema
>;

/**
 * Decide branch eligibility without a name heuristic. Any missing, ambiguous,
 * stale, malformed, or version-skewed authority fails closed with its canonical
 * reason; raw authority evidence remains untouched.
 */
export function decideBranchDefaultEligibility(
  candidate: unknown,
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[]
): BranchDefaultEligibilityDecision {
  const parsedCandidate = branchCandidateSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    return unavailableDecision(RepositoryDefaultReason.Unknown);
  }

  const matching = authorities.filter((authority) =>
    authorityMatchesCandidate(authority, parsedCandidate.data)
  );
  if (matching.length === 0) {
    return unavailableDecision(RepositoryDefaultReason.NotReported);
  }
  if (matching.length > 1) {
    return unavailableDecision(RepositoryDefaultReason.Ambiguous);
  }

  const authority = matching[0];
  if (
    authority.evidence.availability !== RepositoryDefaultAvailability.Available
  ) {
    return unavailableDecision(authority.evidence.reason);
  }
  if (
    authority.evidence.completeness !== RepositoryDefaultCompleteness.Complete
  ) {
    return unavailableDecision(RepositoryDefaultReason.Unknown);
  }
  if (parsedCandidate.data.branchName === authority.evidence.defaultBranch) {
    return {
      outcome: BranchDefaultEligibilityOutcome.Excluded,
      cause: BranchDefaultExclusionCause.DefaultBranch,
      authority,
    };
  }
  return { outcome: BranchDefaultEligibilityOutcome.Included, authority };
}

function authorityMatchesCandidate(
  authority: NormalizedPersistedRepositoryDefaultAuthority,
  candidate: BranchDefaultEligibilityCandidate
): boolean {
  if (
    authority.repository.provider !== candidate.provider ||
    authority.repository.fullName !== candidate.repositoryFullName
  ) {
    return false;
  }
  return (
    candidate.providerRepositoryId === undefined ||
    authority.repository.providerRepositoryId === candidate.providerRepositoryId
  );
}

function unavailableDecision(
  reason: RepositoryDefaultReason
): BranchDefaultEligibilityDecision {
  return {
    outcome: BranchDefaultEligibilityOutcome.Excluded,
    cause: BranchDefaultExclusionCause.AuthorityUnavailable,
    reason,
  };
}

const REPOSITORY_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/;
