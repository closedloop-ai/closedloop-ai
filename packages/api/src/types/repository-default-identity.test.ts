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
  repositoryDefaultProvenanceValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "./repository-default-identity";
import { VcsProviderKind } from "./vcs-provider-kind";
import { findIssue } from "./zod-issue.test-helpers";

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

    const shortFullNameResult = repositoryDefaultAuthorityValidator.safeParse(
      authority({ fullName: "widget" })
    );
    expect(shortFullNameResult.success).toBe(false);
    if (!shortFullNameResult.success) {
      const issue = findIssue(shortFullNameResult.error.issues, [
        "repository",
        "fullName",
      ]);
      expect(issue?.code).toBe("custom");
      expect(issue?.message).toBe(
        "repository fullName must be canonical owner/name"
      );
    }

    const blankIdResult = repositoryDefaultAuthorityValidator.safeParse(
      authority({ providerRepositoryId: " " })
    );
    expect(blankIdResult.success).toBe(false);
    if (!blankIdResult.success) {
      const issue = findIssue(blankIdResult.error.issues, [
        "repository",
        "providerRepositoryId",
      ]);
      expect(issue?.message).toBe(
        "Too small: expected string to have >=1 characters"
      );
    }

    const extraSegmentResult = repositoryDefaultAuthorityValidator.safeParse(
      authority({ fullName: "acme/widget/extra" })
    );
    expect(extraSegmentResult.success).toBe(false);
    if (!extraSegmentResult.success) {
      const issue = findIssue(extraSegmentResult.error.issues, [
        "repository",
        "fullName",
      ]);
      expect(issue?.code).toBe("custom");
      expect(issue?.message).toBe(
        "repository fullName must be canonical owner/name"
      );
    }
  });

  it("rejects whitespace defaults and invalid state combinations", () => {
    const blankBranchResult = repositoryDefaultAuthorityValidator.safeParse(
      authority({ defaultBranch: " " })
    );
    expect(blankBranchResult.success).toBe(false);
    if (!blankBranchResult.success) {
      const issue = findIssue(blankBranchResult.error.issues, [
        "evidence",
        "defaultBranch",
      ]);
      expect(issue?.message).toBe(
        "Too small: expected string to have >=1 characters"
      );
    }

    const unavailableWithBranchResult =
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          defaultBranch: "main",
          reason: RepositoryDefaultReason.NotReported,
        },
      });
    expect(unavailableWithBranchResult.success).toBe(false);
    if (!unavailableWithBranchResult.success) {
      const issue = findIssue(unavailableWithBranchResult.error.issues, [
        "evidence",
      ]);
      expect(issue?.message).toBe('Unrecognized key: "defaultBranch"');
    }

    const availablePartialResult =
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Available,
          completeness: RepositoryDefaultCompleteness.Partial,
          defaultBranch: "main",
        },
      });
    expect(availablePartialResult.success).toBe(false);
    if (!availablePartialResult.success) {
      const issue = findIssue(availablePartialResult.error.issues, [
        "evidence",
        "completeness",
      ]);
      expect(issue?.message).toBe('Invalid input: expected "complete"');
    }
  });

  it("rejects missing replay identity, invalid observation time, and extra fields", () => {
    const blankObservationKeyResult =
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        provenance: { ...authority().provenance, observationKey: " " },
      });
    expect(blankObservationKeyResult.success).toBe(false);
    if (!blankObservationKeyResult.success) {
      const issue = findIssue(blankObservationKeyResult.error.issues, [
        "provenance",
        "observationKey",
      ]);
      expect(issue?.message).toBe(
        "Too small: expected string to have >=1 characters"
      );
    }

    const invalidObservedAtResult =
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        provenance: { ...authority().provenance, observedAt: "yesterday" },
      });
    expect(invalidObservedAtResult.success).toBe(false);
    if (!invalidObservedAtResult.success) {
      const issue = findIssue(invalidObservedAtResult.error.issues, [
        "provenance",
        "observedAt",
      ]);
      expect(issue?.message).toBe("Invalid ISO datetime");
    }

    const extraFieldResult = repositoryDefaultAuthorityValidator.safeParse({
      ...authority(),
      inferredFromBase: true,
    });
    expect(extraFieldResult.success).toBe(false);
    if (!extraFieldResult.success) {
      const issue = findIssue(extraFieldResult.error.issues, []);
      expect(issue?.message).toBe('Unrecognized key: "inferredFromBase"');
    }

    const invalidCredentialOwnerIdResult =
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        provenance: {
          ...authority().provenance,
          credentialOwnerId: "not-a-uuid",
        },
      });
    expect(invalidCredentialOwnerIdResult.success).toBe(false);
    if (!invalidCredentialOwnerIdResult.success) {
      const issue = findIssue(invalidCredentialOwnerIdResult.error.issues, [
        "provenance",
        "credentialOwnerId",
      ]);
      expect(issue?.message).toBe("Invalid UUID");
    }
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

  it("rejects a whitespace-only defaultBranch on stale evidence", () => {
    const result = repositoryDefaultAuthorityValidator.safeParse({
      ...authority(),
      evidence: {
        availability: RepositoryDefaultAvailability.Stale,
        completeness: RepositoryDefaultCompleteness.Partial,
        defaultBranch: " ",
        reason: RepositoryDefaultReason.ProviderError,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, [
        "evidence",
        "defaultBranch",
      ]);
      expect(issue?.message).toBe(
        "Too small: expected string to have >=1 characters"
      );
    }
  });

  it("rejects compatibility-only producer members and invalid capped evidence", () => {
    for (const reason of [
      RepositoryDefaultReason.LegacyRecord,
      RepositoryDefaultReason.Unknown,
    ]) {
      const result = repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Unavailable,
          reason,
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = findIssue(result.error.issues, ["evidence", "reason"]);
        expect(issue?.code).toBe("custom");
        expect(issue?.message).toBe(
          "producer evidence reason must not be compatibility-only"
        );
      }
    }

    const cappedResult = repositoryDefaultAuthorityValidator.safeParse({
      ...authority(),
      evidence: {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.Capped,
      },
    });
    expect(cappedResult.success).toBe(false);
    if (!cappedResult.success) {
      const issue = findIssue(cappedResult.error.issues, [
        "evidence",
        "completeness",
      ]);
      expect(issue?.code).toBe("custom");
      expect(issue?.message).toBe("capped evidence must be partial");
    }

    expect(
      repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        evidence: {
          availability: RepositoryDefaultAvailability.Unavailable,
          completeness: RepositoryDefaultCompleteness.Partial,
          reason: RepositoryDefaultReason.Capped,
        },
      }).success
    ).toBe(true);
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
    expect(normalized?.provenance.credentialOwnerId).toBe(credentialOwnerId);
    expect(normalized?.provenance.eventAt).toBe("2026-08-10T19:59:00.000Z");
    // trigger/credentialType were left at their known, valid authority()
    // values, so the compatibility fallback's normalizeConstValue lookup must
    // preserve them rather than collapsing every field to Unknown.
    expect(normalized?.provenance.trigger).toBe(GitHubFetchTrigger.UserAction);
    expect(normalized?.provenance.credentialType).toBe(
      GitHubFetchCredentialType.GitHubApp
    );
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

  it("never invents a sourceIdentity when the compatibility fallback's source is already known", () => {
    const normalized = normalizeRepositoryDefaultAuthority({
      ...authority(),
      provenance: {
        ...authority().provenance,
        source: RepositoryDefaultSource.RepositoryRest,
        sourceIdentity: "leftover-vendor-id",
        mechanism: "future_mechanism",
      },
    });

    expect(normalized?.provenance.source).toBe(
      RepositoryDefaultSource.RepositoryRest
    );
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
    expect(normalized?.provenance).not.toHaveProperty("eventAt");
  });

  it("normalizes a persisted group whose observedAt column is already a string", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({ defaultBranchObservedAt: observedAt })
    );

    expect(normalized?.provenance?.observedAt).toBe(observedAt);
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

  it("flags sourceIdentity only when paired with a known, non-unknown provenance source", () => {
    const withKnownSource = repositoryDefaultProvenanceValidator.safeParse({
      source: RepositoryDefaultSource.RepositoryRest,
      sourceIdentity: "leftover-vendor-id",
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "attempt:1",
      observedAt,
    });
    expect(withKnownSource.success).toBe(false);
    if (!withKnownSource.success) {
      const issue = findIssue(withKnownSource.error.issues, ["sourceIdentity"]);
      expect(issue?.code).toBe("custom");
      expect(issue?.message).toBe(
        "sourceIdentity is reserved for unknown compatibility sources"
      );
    }

    const withUnknownSource = repositoryDefaultProvenanceValidator.safeParse({
      source: RepositoryDefaultSource.Unknown,
      sourceIdentity: "leftover-vendor-id",
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "attempt:1",
      observedAt,
    });
    expect(withUnknownSource.success).toBe(true);
  });

  it("rejects a whitespace-only sourceIdentity even when paired with an unknown source", () => {
    const result = repositoryDefaultProvenanceValidator.safeParse({
      source: RepositoryDefaultSource.Unknown,
      sourceIdentity: "   ",
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "attempt:1",
      observedAt,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["sourceIdentity"]);
      expect(issue?.message).toBe(
        "Too small: expected string to have >=1 characters"
      );
    }
  });

  it("rejects a compatibility-only reason on a producer unavailable observation", () => {
    for (const reason of [
      RepositoryDefaultReason.LegacyRecord,
      RepositoryDefaultReason.Unknown,
    ]) {
      const result = repositoryDefaultUnavailableObservationValidator.safeParse(
        {
          reason,
          provenance: {
            source: RepositoryDefaultSource.RepositoryRest,
            mechanism: GitHubFetchMechanism.Rest,
            trigger: GitHubFetchTrigger.UserAction,
            credentialType: GitHubFetchCredentialType.GitHubApp,
            observationKey: "attempt:1",
            observedAt,
          },
        }
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = findIssue(result.error.issues, ["reason"]);
        expect(issue?.code).toBe("custom");
        expect(issue?.message).toBe(
          "producer evidence reason must not be compatibility-only"
        );
      }
    }
  });

  it("rejects an unknown provenance source on a producer unavailable observation", () => {
    const result = repositoryDefaultUnavailableObservationValidator.safeParse({
      reason: RepositoryDefaultReason.NotReported,
      provenance: {
        source: RepositoryDefaultSource.Unknown,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: "attempt:1",
        observedAt,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["provenance", "source"]);
      expect(issue?.code).toBe("custom");
      expect(issue?.message).toBe("producer provenance source must be known");
    }
  });

  it("rejects an unknown mechanism, trigger, or credential type on a producer unavailable observation", () => {
    const base = {
      source: RepositoryDefaultSource.RepositoryRest,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      credentialType: GitHubFetchCredentialType.GitHubApp,
      observationKey: "attempt:1",
      observedAt,
    };
    for (const override of [
      { mechanism: GitHubFetchMechanism.Unknown },
      { trigger: GitHubFetchTrigger.Unknown },
      { credentialType: GitHubFetchCredentialType.Unknown },
    ]) {
      const result = repositoryDefaultUnavailableObservationValidator.safeParse(
        {
          reason: RepositoryDefaultReason.NotReported,
          provenance: { ...base, ...override },
        }
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = findIssue(result.error.issues, ["provenance"]);
        expect(issue?.code).toBe("custom");
        expect(issue?.message).toBe(
          "producer provenance classifications must be known"
        );
      }
    }
  });

  it("rejects an unknown mechanism, trigger, or credential type on a producer authority", () => {
    for (const override of [
      { mechanism: GitHubFetchMechanism.Unknown },
      { trigger: GitHubFetchTrigger.Unknown },
      { credentialType: GitHubFetchCredentialType.Unknown },
    ]) {
      const result = repositoryDefaultAuthorityValidator.safeParse({
        ...authority(),
        provenance: { ...authority().provenance, ...override },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = findIssue(result.error.issues, ["provenance"]);
        expect(issue?.code).toBe("custom");
        expect(issue?.message).toBe(
          "producer provenance classifications must be known"
        );
      }
    }
  });

  it("rejects an unknown provenance source on a producer authority", () => {
    const result = repositoryDefaultAuthorityValidator.safeParse({
      ...authority(),
      provenance: {
        ...authority().provenance,
        source: RepositoryDefaultSource.Unknown,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = findIssue(result.error.issues, ["provenance", "source"]);
      expect(issue?.code).toBe("custom");
      expect(issue?.message).toBe("producer provenance source must be known");
    }
  });

  it("returns undefined when a value fails even the compatibility fallback shape", () => {
    expect(
      normalizeRepositoryDefaultAuthority({
        repository: {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId: "1",
          fullName: "not-canonical",
        },
        provenance: authority().provenance,
      })
    ).toBeUndefined();
  });

  it("returns undefined when the compatibility fallback observationKey is whitespace-only", () => {
    expect(
      normalizeRepositoryDefaultAuthority({
        repository: authority().repository,
        provenance: {
          source: "totally-unrecognized-source",
          mechanism: GitHubFetchMechanism.Rest,
          trigger: GitHubFetchTrigger.UserAction,
          credentialType: GitHubFetchCredentialType.GitHubApp,
          observationKey: "   ",
          observedAt,
        },
      })
    ).toBeUndefined();
  });

  it("degrades an unrecognized non-string provenance source without inventing an identity", () => {
    const normalized = normalizeRepositoryDefaultAuthority({
      repository: authority().repository,
      provenance: {
        source: 42,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: "attempt:1",
        observedAt,
      },
    });

    expect(normalized?.provenance.source).toBe(RepositoryDefaultSource.Unknown);
    expect(normalized?.provenance).not.toHaveProperty("sourceIdentity");
    expect(normalized?.provenance).not.toHaveProperty("credentialOwnerId");
    expect(normalized?.provenance).not.toHaveProperty("eventAt");
  });

  it("omits sourceIdentity when both the raw source and any prior identity are blank", () => {
    const normalized = normalizeRepositoryDefaultAuthority({
      repository: authority().repository,
      provenance: {
        source: "",
        sourceIdentity: "   ",
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.UserAction,
        credentialType: GitHubFetchCredentialType.GitHubApp,
        observationKey: "attempt:1",
        observedAt,
      },
    });

    expect(normalized?.provenance.source).toBe(RepositoryDefaultSource.Unknown);
    expect(normalized?.provenance).not.toHaveProperty("sourceIdentity");
  });

  it("returns undefined when the persisted repository identity itself is invalid", () => {
    expect(
      normalizePersistedRepositoryDefaultAuthority(
        {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId: "1",
          fullName: "not-canonical",
        },
        persistedColumns()
      )
    ).toBeUndefined();
  });

  it("falls back to an unknown reason when a persisted group is missing required provenance fields", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({ defaultBranchSource: null })
    );

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.Unknown,
    });
    expect(normalized).not.toHaveProperty("provenance");
  });

  it("falls back to an unknown reason when the persisted observedAt is not a valid ISO instant", () => {
    // pins current behavior; looks odd because normalizePersistedInstant does
    // not validate string format, only that a Date is finite — an already-
    // string column value is passed through unchanged and only rejected later
    // by the ISO-datetime schema check.
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({ defaultBranchObservedAt: "not-a-real-date" })
    );

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.Unknown,
    });
    expect(normalized).not.toHaveProperty("provenance");
  });

  it("derives unavailable evidence without a default branch when none was persisted, keeping the recorded reason", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({
        defaultBranchName: null,
        defaultBranchAvailability: RepositoryDefaultAvailability.Unavailable,
        defaultBranchCompleteness: RepositoryDefaultCompleteness.Unavailable,
        defaultBranchReason: RepositoryDefaultReason.RateLimited,
      })
    );

    expect(normalized?.evidence).toEqual({
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.RateLimited,
    });
  });

  it("omits credentialOwnerId from persisted provenance when the column is absent", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({ defaultBranchCredentialOwnerId: null })
    );

    expect(normalized?.provenance).not.toHaveProperty("credentialOwnerId");
  });

  it("includes eventAt in persisted provenance when the column carries a provider event time", () => {
    const normalized = normalizePersistedRepositoryDefaultAuthority(
      authority().repository,
      persistedColumns({
        defaultBranchEventAt: new Date("2026-08-01T00:00:00.000Z"),
      })
    );

    expect(normalized?.provenance?.eventAt).toBe("2026-08-01T00:00:00.000Z");
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
