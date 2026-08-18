import { describe, expect, it } from "vitest";

import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "./github-read-model";
import {
  normalizePersistedRepositoryDefaultAuthority,
  normalizeRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
  repositoryDefaultAuthorityValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "./repository-default-identity";
import { VcsProviderKind } from "./vcs-provider-kind";

const observedAt = "2026-08-10T20:00:00.000Z";
const credentialOwnerId = "019fed13-b752-77c3-bf22-0a6c655d4a38";

describe("repository default identity", () => {
  it("pins the authority reason and provenance-source taxonomy", () => {
    expect(new Set(Object.values(RepositoryDefaultReason)).size).toBe(11);
    expect(new Set(Object.values(RepositoryDefaultSource)).size).toBe(9);
  });

  it("validates a provider-qualified custom default with stable provenance", () => {
    const parsed = repositoryDefaultAuthorityValidator.parse(
      authority({ defaultBranch: "release/next" })
    );

    expect(parsed.repository).toEqual({
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: "12345",
      fullName: "acme/widget",
    });
    expect(parsed.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "release/next",
    });
    expect(parsed.provenance).toEqual(
      expect.objectContaining({
        observationKey: "attempt:123",
        observedAt,
        eventAt: "2026-08-10T19:59:00.000Z",
      })
    );
  });

  it("normalizes full names but rejects short or empty repository identities", () => {
    expect(
      repositoryDefaultAuthorityValidator.parse(
        authority({ fullName: " /Acme/Widget.git/ " })
      ).repository.fullName
    ).toBe("acme/widget");
    expect(
      repositoryDefaultAuthorityValidator.safeParse(
        authority({ fullName: "widget" })
      ).success
    ).toBe(false);
    expect(
      repositoryDefaultAuthorityValidator.safeParse(
        authority({ providerRepositoryId: " " })
      ).success
    ).toBe(false);
  });

  it("rejects whitespace defaults and invalid state combinations", () => {
    expect(
      repositoryDefaultAuthorityValidator.safeParse(
        authority({ defaultBranch: " " })
      ).success
    ).toBe(false);
    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          defaultBranch: "main",
          reason: RepositoryDefaultReason.NotReported,
        },
      }).success
    ).toBe(false);
    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Available,
          completeness: RepositoryDefaultCompleteness.Partial,
          defaultBranch: "main",
        },
      }).success
    ).toBe(false);
  });

  it("rejects missing replay identity, invalid observation time, and extra fields", () => {
    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        provenance: { ...authority().provenance, observationKey: " " },
      }).success
    ).toBe(false);
    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        provenance: { ...authority().provenance, observedAt: "yesterday" },
      }).success
    ).toBe(false);
    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        inferredFromBase: true,
      }).success
    ).toBe(false);
    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        provenance: {
          ...authority().provenance,
          credentialOwnerId: "not-a-uuid",
        },
      }).success
    ).toBe(false);
  });

  it("accepts typed stale and unavailable evidence without inferring a branch", () => {
    expect(
      repositoryDefaultAuthorityValidator.parse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Stale,
          completeness: RepositoryDefaultCompleteness.Partial,
          defaultBranch: "develop",
          reason: RepositoryDefaultReason.ProviderError,
        },
      }).evidence
    ).toEqual(
      expect.objectContaining({
        availability: RepositoryDefaultAvailability.Stale,
        defaultBranch: "develop",
      })
    );
    expect(
      repositoryDefaultAuthorityValidator.parse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          reason: RepositoryDefaultReason.NotReported,
        },
      }).evidence
    ).not.toHaveProperty("defaultBranch");
  });

  it("rejects compatibility-only producer members and invalid capped evidence", () => {
    for (const reason of [
      RepositoryDefaultReason.LegacyRecord,
      RepositoryDefaultReason.Unknown,
    ]) {
      expect(
        repositoryDefaultAuthorityValidator.safeParse({
          ...authority(),
          evidence: {
            availability: RepositoryDefaultAvailability.Unavailable,
            completeness: RepositoryDefaultCompleteness.Unavailable,
            reason,
          },
        }).success
      ).toBe(false);
    }
    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          reason: RepositoryDefaultReason.Capped,
        },
      }).success
    ).toBe(false);
  });

  it("preserves legacy omission and degrades future values conservatively", () => {
    expect(normalizeRepositoryDefaultAuthority(undefined)).toBeUndefined();

    const normalized = normalizeRepositoryDefaultAuthority({
      ...authority(),
      evidence: {
        availability: "future_available",
        completeness: "future_complete",
        defaultBranch: "main",
      },
      provenance: {
        ...authority().provenance,
        source: "future_source",
        mechanism: "future_mechanism",
      },
      futureField: true,
    });

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.Unknown,
    });
    expect(normalized?.provenance.source).toBe(RepositoryDefaultSource.Unknown);
    expect(normalized?.provenance.sourceIdentity).toBe("future_source");
    expect(normalized?.provenance.mechanism).toBe(GitHubFetchMechanism.Unknown);
  });

  it("keeps distinct future raw sources separate across repeated normalization", () => {
    const normalizeFutureSource = (source: string) =>
      normalizeRepositoryDefaultAuthority({
        ...authority(),
        evidence: {
          availability: "future_available",
          completeness: "future_complete",
        },
        provenance: {
          ...authority().provenance,
          source,
          observationKey: "shared-future-key",
        },
      });
    const first = normalizeFutureSource(" future_source_a ");
    const second = normalizeFutureSource("future_source_b");

    expect(first?.provenance).toEqual(
      expect.objectContaining({
        source: RepositoryDefaultSource.Unknown,
        sourceIdentity: "future_source_a",
        observationKey: "shared-future-key",
      })
    );
    expect(second?.provenance).toEqual(
      expect.objectContaining({
        source: RepositoryDefaultSource.Unknown,
        sourceIdentity: "future_source_b",
        observationKey: "shared-future-key",
      })
    );
    expect(
      normalizeRepositoryDefaultAuthority(first)?.provenance.sourceIdentity
    ).toBe("future_source_a");
  });

  it("omits sourceIdentity for known producer sources", () => {
    const normalized = normalizeRepositoryDefaultAuthority(authority());

    expect(normalized?.provenance).not.toHaveProperty("sourceIdentity");
  });

  it("degrades canonical compatibility-only values instead of trusting them", () => {
    for (const reason of [
      RepositoryDefaultReason.LegacyRecord,
      RepositoryDefaultReason.Unknown,
    ]) {
      const normalized = normalizeRepositoryDefaultAuthority({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          reason,
        },
      });

      expect(normalized?.evidence).toEqual({
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.Unknown,
      });
    }
  });

  it("normalizes all-null persisted groups as unavailable legacy records", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({
        defaultBranchName: null,
        defaultBranchAvailability: null,
        defaultBranchCompleteness: null,
        defaultBranchReason: null,
        defaultBranchSource: null,
        defaultBranchMechanism: null,
        defaultBranchTrigger: null,
        defaultBranchCredentialType: null,
        defaultBranchCredentialOwnerId: null,
        defaultBranchObservationKey: null,
        defaultBranchObservedAt: null,
        defaultBranchEventAt: null,
      })
    );

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.LegacyRecord,
    });
    expect(normalized).not.toHaveProperty("provenance");
  });

  it("ignores identity fields when detecting an all-null authority group", () => {
    const columns = {
      ...persistedColumns({
        defaultBranchName: null,
        defaultBranchAvailability: null,
        defaultBranchCompleteness: null,
        defaultBranchReason: null,
        defaultBranchSource: null,
        defaultBranchMechanism: null,
        defaultBranchTrigger: null,
        defaultBranchCredentialType: null,
        defaultBranchCredentialOwnerId: null,
        defaultBranchObservationKey: null,
        defaultBranchObservedAt: null,
        defaultBranchEventAt: null,
      }),
      githubRepoId: "123",
      fullName: "acme/api",
    };
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      columns
    );

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.LegacyRecord,
    });
    expect(normalized).not.toHaveProperty("provenance");
  });

  it("normalizes unknown persisted members without retaining a branch", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({
        defaultBranchName: "main",
        defaultBranchAvailability: "future_available",
        defaultBranchSource: "future_source",
      })
    );

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.Unknown,
    });
    expect(normalized?.evidence).not.toHaveProperty("defaultBranch");
    expect(normalized?.provenance?.source).toBe(
      RepositoryDefaultSource.Unknown
    );
    expect(normalized?.provenance?.sourceIdentity).toBe("future_source");
  });

  it("normalizes valid persisted groups with Date observations", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns()
    );

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: "trunk",
    });
    expect(normalized?.provenance?.observedAt).toBe(observedAt);
    expect(normalized?.provenance?.credentialOwnerId).toBe(credentialOwnerId);
  });

  it("omits absent event time rather than serializing null", () => {
    const normalized = normalizeRepositoryDefaultAuthority(
      authority({ eventAt: undefined })
    );

    expect(normalized?.provenance).not.toHaveProperty("eventAt");
    expect(JSON.stringify(normalized)).not.toContain('"eventAt":null');
  });

  it("keeps observation and provider event time as distinct fields", () => {
    const parsed = repositoryDefaultAuthorityValidator.parse(authority());

    expect(parsed.provenance.observedAt).toBe(observedAt);
    expect(parsed.provenance.eventAt).toBe("2026-08-10T19:59:00.000Z");
    expect(parsed.provenance.observationKey).toBe("attempt:123");
  });

  it("validates provenance-preserving unavailable head observations", () => {
    const parsed = repositoryDefaultUnavailableObservationValidator.parse({
      reason: RepositoryDefaultReason.NotReported,
      provenance: {
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.Unauthenticated,
        observationKey: "graphql-attempt:anonymous",
        observedAt,
      },
    });

    expect(parsed.reason).toBe(RepositoryDefaultReason.NotReported);
    expect(parsed.provenance.credentialType).toBe(
      GitHubFetchCredentialType.Unauthenticated
    );
    expect(parsed.provenance).not.toHaveProperty("credentialOwnerId");
  });
});

function authority(
  overrides: {
    defaultBranch?: string;
    eventAt?: string;
    fullName?: string;
    providerRepositoryId?: string;
  } = {}
) {
  const eventAt = Object.hasOwn(overrides, "eventAt")
    ? overrides.eventAt
    : "2026-08-10T19:59:00.000Z";
  return {
    repository: {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: overrides.providerRepositoryId ?? "12345",
      fullName: overrides.fullName ?? "Acme/Widget",
    },
    evidence: {
      availability: RepositoryDefaultAvailability.Available,
      completeness: RepositoryDefaultCompleteness.Complete,
      defaultBranch: overrides.defaultBranch ?? "trunk",
    },
    provenance: {
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      credentialOwnerId,
      observationKey: "attempt:123",
      observedAt,
      ...(eventAt === undefined ? {} : { eventAt }),
    },
  };
}

function persistedColumns(overrides: Record<string, unknown> = {}) {
  return {
    defaultBranchName: "trunk",
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
    defaultBranchMechanism: GitHubFetchMechanism.Rest,
    defaultBranchTrigger: GitHubFetchTrigger.UserAction,
    defaultBranchCredentialType: GitHubFetchCredentialType.UserOAuth,
    defaultBranchCredentialOwnerId: credentialOwnerId,
    defaultBranchObservationKey: "attempt:123",
    defaultBranchObservedAt: new Date(observedAt),
    defaultBranchEventAt: null,
    ...overrides,
  };
}
