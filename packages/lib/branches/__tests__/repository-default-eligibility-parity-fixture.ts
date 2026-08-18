import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";

export const RepositoryDefaultParityExpectedOutcome = {
  DefaultBranch: "default_branch",
  Included: "included",
  Unavailable: "authority_unavailable",
} as const;
export type RepositoryDefaultParityExpectedOutcome =
  (typeof RepositoryDefaultParityExpectedOutcome)[keyof typeof RepositoryDefaultParityExpectedOutcome];

export type RepositoryDefaultEligibilityParityCase = {
  name: string;
  candidate: {
    provider: VcsProviderKind;
    providerRepositoryId?: string;
    repositoryFullName: string;
    branchName: string;
  };
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[];
  expectedOutcome: RepositoryDefaultParityExpectedOutcome;
  expectedReason?: RepositoryDefaultReason;
};

/** Shared cloud/Desktop semantic fixture required by PRD-600 COMMON-018. */
export const repositoryDefaultEligibilityParityCases: readonly RepositoryDefaultEligibilityParityCase[] =
  [
    {
      name: "custom default is excluded",
      candidate: candidate("acme/api", "trunk"),
      authorities: [
        authority({ fullName: "acme/api", defaultBranch: "trunk" }),
      ],
      expectedOutcome: RepositoryDefaultParityExpectedOutcome.DefaultBranch,
    },
    {
      name: "ordinary feature is included",
      candidate: candidate("acme/api", "feature/parity"),
      authorities: [
        authority({ fullName: "acme/api", defaultBranch: "trunk" }),
      ],
      expectedOutcome: RepositoryDefaultParityExpectedOutcome.Included,
    },
    {
      name: "fork head uses its own authority",
      candidate: candidate("contributor/api", "main", "fork-456"),
      authorities: [
        authority({ fullName: "acme/api", providerRepositoryId: "base-123" }),
        authority({
          fullName: "contributor/api",
          providerRepositoryId: "fork-456",
        }),
      ],
      expectedOutcome: RepositoryDefaultParityExpectedOutcome.DefaultBranch,
    },
    {
      name: "base authority cannot prove a fork head",
      candidate: candidate("contributor/api", "feature/fork", "fork-456"),
      authorities: [
        authority({ fullName: "acme/api", providerRepositoryId: "base-123" }),
      ],
      expectedOutcome: RepositoryDefaultParityExpectedOutcome.Unavailable,
      expectedReason: RepositoryDefaultReason.NotReported,
    },
    {
      name: "same short repository name remains owner scoped",
      candidate: candidate("org-b/api", "main", "org-b-2"),
      authorities: [
        authority({ fullName: "org-a/api", providerRepositoryId: "org-a-1" }),
        authority({
          fullName: "org-b/api",
          providerRepositoryId: "org-b-2",
          defaultBranch: "trunk",
        }),
      ],
      expectedOutcome: RepositoryDefaultParityExpectedOutcome.Included,
    },
    {
      name: "missing authority fails closed",
      candidate: candidate("acme/missing", "feature/missing"),
      authorities: [],
      expectedOutcome: RepositoryDefaultParityExpectedOutcome.Unavailable,
      expectedReason: RepositoryDefaultReason.NotReported,
    },
    unavailableCase(
      "stale authority retains its cause",
      RepositoryDefaultReason.ProviderError,
      RepositoryDefaultAvailability.Stale
    ),
    unavailableCase(
      "malformed persisted authority",
      RepositoryDefaultReason.Malformed
    ),
    unavailableCase(
      "conflicting newest authority",
      RepositoryDefaultReason.Conflicting
    ),
    unavailableCase(
      "ambiguous repository identity",
      RepositoryDefaultReason.Ambiguous
    ),
    unavailableCase(
      "legacy omitted authority group",
      RepositoryDefaultReason.LegacyRecord
    ),
    unavailableCase(
      "unknown newer peer member",
      RepositoryDefaultReason.Unknown
    ),
    unavailableCase(
      "permission filtered authority",
      RepositoryDefaultReason.PermissionFiltered
    ),
    unavailableCase(
      "rate limited authority",
      RepositoryDefaultReason.RateLimited
    ),
    unavailableCase("capped partial authority", RepositoryDefaultReason.Capped),
    {
      name: "newest default replacement re-evaluates old evidence",
      candidate: candidate("acme/api", "main"),
      authorities: [
        authority({ fullName: "acme/api", defaultBranch: "trunk" }),
      ],
      expectedOutcome: RepositoryDefaultParityExpectedOutcome.Included,
    },
  ] as const;

function candidate(
  repositoryFullName: string,
  branchName: string,
  providerRepositoryId = "repo-123"
): RepositoryDefaultEligibilityParityCase["candidate"] {
  return {
    provider: VcsProviderKind.GitHub,
    providerRepositoryId,
    repositoryFullName,
    branchName,
  };
}

function unavailableCase(
  name: string,
  reason: RepositoryDefaultReason,
  availability: RepositoryDefaultAvailability = RepositoryDefaultAvailability.Unavailable
): RepositoryDefaultEligibilityParityCase {
  return {
    name,
    candidate: candidate("acme/api", "feature/fail-closed"),
    authorities: [unavailableAuthority(reason, availability)],
    expectedOutcome: RepositoryDefaultParityExpectedOutcome.Unavailable,
    expectedReason: reason,
  };
}

function authority(input: {
  fullName: string;
  providerRepositoryId?: string;
  defaultBranch?: string;
}): NormalizedPersistedRepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: input.providerRepositoryId ?? "repo-123",
      fullName: input.fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: input.defaultBranch ?? "main",
    },
    provenance: provenance(),
  };
}

function unavailableAuthority(
  reason: RepositoryDefaultReason,
  availability: RepositoryDefaultAvailability
): NormalizedPersistedRepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "repo-123",
      fullName: "acme/api",
    },
    evidence:
      availability === RepositoryDefaultAvailability.Stale
        ? {
            availability: RepositoryDefaultAvailability.Stale,
            completeness: RepositoryDefaultCompleteness.Partial,
            defaultBranch: "main",
            reason,
          }
        : {
            availability: RepositoryDefaultAvailability.Unavailable,
            completeness:
              reason === RepositoryDefaultReason.Capped
                ? RepositoryDefaultCompleteness.Partial
                : RepositoryDefaultCompleteness.Unavailable,
            reason,
          },
    ...(reason === RepositoryDefaultReason.LegacyRecord
      ? {}
      : { provenance: provenance() }),
  };
}

function provenance() {
  return {
    source: RepositoryDefaultSource.RepositoryRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.UserAction,
    credentialType: GitHubFetchCredentialType.UserOAuth,
    observationKey: "parity-fixture",
    observedAt: "2026-08-11T00:00:00.000Z",
  } as const;
}
