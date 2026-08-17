import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  RepositoryDefaultParityExpectedOutcome,
  repositoryDefaultEligibilityParityCases,
} from "@repo/lib/branches/__tests__/repository-default-eligibility-parity-fixture";
import {
  BranchDefaultEligibilityOutcome,
  BranchDefaultExclusionCause,
  decideBranchDefaultEligibility,
} from "../src/main/database/branch-default-eligibility.js";

describe("ISS-5828 Desktop branch default eligibility", () => {
  test("consumes the shared cloud/Desktop parity matrix", () => {
    for (const fixture of repositoryDefaultEligibilityParityCases) {
      const decision = decideBranchDefaultEligibility(
        fixture.candidate,
        fixture.authorities
      );
      if (
        fixture.expectedOutcome ===
        RepositoryDefaultParityExpectedOutcome.Included
      ) {
        assert.equal(
          decision.outcome,
          BranchDefaultEligibilityOutcome.Included
        );
        continue;
      }
      assert.equal(decision.outcome, BranchDefaultEligibilityOutcome.Excluded);
      if (
        fixture.expectedOutcome ===
        RepositoryDefaultParityExpectedOutcome.DefaultBranch
      ) {
        assert.equal(decision.cause, BranchDefaultExclusionCause.DefaultBranch);
        continue;
      }
      assert.equal(
        decision.cause,
        BranchDefaultExclusionCause.AuthorityUnavailable
      );
      if (decision.cause === BranchDefaultExclusionCause.AuthorityUnavailable) {
        assert.equal(decision.reason, fixture.expectedReason);
      }
    }
  });

  test("excludes only the exact authoritative custom default", () => {
    const authority = availableAuthority("repo-1", "acme/web", "trunk");

    assert.deepEqual(
      decideBranchDefaultEligibility(candidate("trunk"), [authority]),
      {
        outcome: BranchDefaultEligibilityOutcome.Excluded,
        cause: BranchDefaultExclusionCause.DefaultBranch,
        authority,
      }
    );
    assert.equal(
      decideBranchDefaultEligibility(candidate("main"), [authority]).outcome,
      BranchDefaultEligibilityOutcome.Included
    );
  });

  test("matches optional stable identity and never falls back to a namesake", () => {
    const original = availableAuthority("repo-1", "acme/web", "main");
    const recreated = availableAuthority("repo-2", "acme/web", "trunk");

    assert.deepEqual(
      decideBranchDefaultEligibility(
        candidate("feature", { providerRepositoryId: "repo-missing" }),
        [original, recreated]
      ),
      unavailable(RepositoryDefaultReason.NotReported)
    );
    assert.equal(
      decideBranchDefaultEligibility(
        candidate("feature", { providerRepositoryId: "repo-2" }),
        [original, recreated]
      ).outcome,
      BranchDefaultEligibilityOutcome.Included
    );
  });

  test("fails closed when a provider-qualified name maps to multiple identities", () => {
    assert.deepEqual(
      decideBranchDefaultEligibility(candidate("feature"), [
        availableAuthority("repo-1", "acme/web", "main"),
        availableAuthority("repo-2", "acme/web", "trunk"),
      ]),
      unavailable(RepositoryDefaultReason.Ambiguous)
    );
  });

  test("preserves exact unavailable and stale causes", () => {
    for (const reason of [
      RepositoryDefaultReason.PermissionDenied,
      RepositoryDefaultReason.PermissionFiltered,
      RepositoryDefaultReason.RateLimited,
      RepositoryDefaultReason.ProviderError,
      RepositoryDefaultReason.Capped,
      RepositoryDefaultReason.NotReported,
      RepositoryDefaultReason.LegacyRecord,
      RepositoryDefaultReason.Unknown,
    ]) {
      assert.deepEqual(
        decideBranchDefaultEligibility(candidate("feature"), [
          unavailableAuthority(reason),
        ]),
        unavailable(reason)
      );
    }

    assert.deepEqual(
      decideBranchDefaultEligibility(candidate("feature"), [
        staleAuthority(RepositoryDefaultReason.RateLimited),
      ]),
      unavailable(RepositoryDefaultReason.RateLimited)
    );
  });

  test("fails closed for absent, malformed candidates, and normalized newer peers", () => {
    assert.deepEqual(
      decideBranchDefaultEligibility(candidate("feature"), []),
      unavailable(RepositoryDefaultReason.NotReported)
    );
    assert.deepEqual(
      decideBranchDefaultEligibility(candidate("feature"), [
        {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "repo-1",
            fullName: "acme/web",
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Unavailable,
            completeness: RepositoryDefaultCompleteness.Unavailable,
            reason: RepositoryDefaultReason.Unknown,
          },
        },
      ]),
      unavailable(RepositoryDefaultReason.Unknown)
    );
    assert.deepEqual(
      decideBranchDefaultEligibility({ branchName: "feature" }, []),
      unavailable(RepositoryDefaultReason.Unknown)
    );
  });

  test("uses fork head authority when the candidate carries its identity", () => {
    const base = availableAuthority("base-id", "upstream/web", "main");
    const head = availableAuthority("head-id", "contributor/web", "fork-main");

    assert.deepEqual(
      decideBranchDefaultEligibility(
        candidate("fork-main", {
          providerRepositoryId: "head-id",
          repositoryFullName: "contributor/web",
        }),
        [base, head]
      ),
      {
        outcome: BranchDefaultEligibilityOutcome.Excluded,
        cause: BranchDefaultExclusionCause.DefaultBranch,
        authority: head,
      }
    );
  });
});

function candidate(
  branchName: string,
  overrides: Partial<{
    providerRepositoryId: string;
    repositoryFullName: string;
  }> = {}
) {
  return {
    provider: VcsProviderKind.GitHub,
    repositoryFullName: overrides.repositoryFullName ?? "acme/web",
    branchName,
    ...(overrides.providerRepositoryId === undefined
      ? {}
      : { providerRepositoryId: overrides.providerRepositoryId }),
  };
}

function availableAuthority(
  providerRepositoryId: string,
  fullName: string,
  defaultBranch: string
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName,
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch,
    },
    provenance: provenance(providerRepositoryId),
  };
}

function unavailableAuthority(
  reason: RepositoryDefaultReason
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "repo-1",
      fullName: "acme/web",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness:
        reason === RepositoryDefaultReason.Capped
          ? RepositoryDefaultCompleteness.Partial
          : RepositoryDefaultCompleteness.Unavailable,
      reason,
    },
    provenance: provenance(`unavailable:${reason}`),
  };
}

function staleAuthority(
  reason: RepositoryDefaultReason
): RepositoryDefaultAuthority {
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "repo-1",
      fullName: "acme/web",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Stale,
      completeness: RepositoryDefaultCompleteness.Partial,
      defaultBranch: "main",
      reason,
    },
    provenance: provenance(`stale:${reason}`),
  };
}

function provenance(observationKey: string) {
  return {
    source: RepositoryDefaultSource.RepositoryRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.SurfaceOpen,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey,
    observedAt: "2026-08-11T00:00:00.000Z",
  };
}

function unavailable(reason: RepositoryDefaultReason) {
  return {
    outcome: BranchDefaultEligibilityOutcome.Excluded,
    cause: BranchDefaultExclusionCause.AuthorityUnavailable,
    reason,
  };
}
