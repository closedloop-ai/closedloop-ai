import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistPullRequestHeadRepositoryAuthority,
  pullRequestHeadRepositoryObservation,
} from "./pull-request-head-authority";

const { createMany, findFirst, logError, logInfo, logWarn, updateMany } =
  vi.hoisted(() => ({
    createMany: vi.fn(),
    findFirst: vi.fn(),
    logError: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    updateMany: vi.fn(),
  }));

vi.mock("@repo/observability/log", () => ({
  log: { error: logError, info: logInfo, warn: logWarn },
}));

const db = {
  pullRequestDetail: { findFirst, updateMany },
  repositoryDefaultObservationReceipt: { createMany },
} as Parameters<typeof persistPullRequestHeadRepositoryAuthority>[0];

const scope = {
  organizationId: "019c24dc-63ca-717e-b057-ce589da3d2e1",
  pullRequestDetailId: "019fed13-b752-77c3-bf22-0a6c655d4a38",
};
const firstObservedAt = "2026-08-10T20:00:00.000Z";

describe("pullRequestHeadRepositoryObservation (branch pins)", () => {
  it("omits headRef entirely when neither headBranch nor headSha is supplied", () => {
    const result = pullRequestHeadRepositoryObservation({
      headRepositoryUnavailable: {
        reason: RepositoryDefaultReason.ProviderError,
        provenance: provenance("delivery-1", firstObservedAt),
      },
    });

    expect(result).toEqual({
      unavailable: {
        reason: RepositoryDefaultReason.ProviderError,
        provenance: provenance("delivery-1", firstObservedAt),
      },
    });
  });

  it("defaults an omitted headBranch to an empty string alongside a real headSha", () => {
    const result = pullRequestHeadRepositoryObservation({
      headRepositoryUnavailable: {
        reason: RepositoryDefaultReason.ProviderError,
        provenance: provenance("delivery-1", firstObservedAt),
      },
      headSha: "a".repeat(40),
    });

    expect(result?.headRef).toEqual({ name: "", oid: "a".repeat(40) });
  });
});

describe("persistPullRequestHeadRepositoryAuthority (branch pins)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMany.mockResolvedValue({ count: 1 });
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("retries the accepted-but-uncommitted legacy repair once and lands it on the second attempt", () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.SurfaceOpen,
        observationKey: "rest-1",
        headRefName: null,
        headRefOid: "a".repeat(40),
      })
    );
    // The legacy-repair CAS write loses its optimistic race once, then wins.
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    return persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-1", firstObservedAt, "trunk"),
      { name: "feature/published", oid: "a".repeat(40) }
    ).then((changed) => {
      expect(changed).toBe(true);
      expect(findFirst).toHaveBeenCalledTimes(2);
      expect(updateMany).toHaveBeenCalledTimes(2);
    });
  });

  it("stays a no-op when the stored identity already sorts before a semantically-identical replay", async () => {
    // Equal observation time, identical semantic authority (repo/branch/
    // availability/completeness/reason all match), and — isolating the
    // identity tie-break itself — the SAME provenance source on both sides.
    // The deterministic equal-time decision then turns purely on the
    // observation-key ordering, and the lexically SMALLER stored identity
    // wins (stays a no-op) over the lexically greater incoming one.
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestWebhook,
        observationKey: "aaa-earlier",
        observedAt: new Date(firstObservedAt),
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableWebhookObservation("zzz-later", firstObservedAt, "trunk"),
      { name: "feature/existing", oid: "c".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts a same-time REST snapshot over a lexically-later stored webhook identity", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestWebhook,
        observationKey: "zzz-later",
        observedAt: new Date(firstObservedAt),
      })
    );
    const rest = restAvailableObservation(
      "aaa-earlier",
      firstObservedAt,
      "trunk"
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      rest,
      { name: "feature/rest", oid: "e".repeat(40) }
    );

    expect(changed).toBe(true);
    // Representative case for the org-scoped read and the CAS write: both
    // key off `scope.organizationId`, not just `scope.pullRequestDetailId`.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: scope.pullRequestDetailId,
          organizationId: scope.organizationId,
        },
      })
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: scope.pullRequestDetailId,
        organizationId: scope.organizationId,
        headRepositoryDefaultBranchObservationKey: "zzz-later",
        headRepositoryDefaultBranchObservedAt: new Date(firstObservedAt),
        headRefName: "feature/existing",
        headRefOid: "c".repeat(40),
      },
      data: expect.objectContaining({
        headRepositoryDefaultBranchObservationKey: "aaa-earlier",
      }),
    });
  });

  it("prefers an available incoming default over a stored unavailable one at equal time", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        availability: RepositoryDefaultAvailability.Unavailable,
        branchName: null,
        reason: RepositoryDefaultReason.RateLimited,
        observedAt: new Date(firstObservedAt),
      })
    );
    const rest = restAvailableObservation("rest-1", firstObservedAt, "trunk");

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      rest,
      { name: "feature/rest", oid: "e".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Available,
      }),
    });
  });

  it("keeps a stored available default over an equal-time unavailable incoming observation", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({ observedAt: new Date(firstObservedAt) })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(db, scope, {
      unavailable: {
        reason: RepositoryDefaultReason.RateLimited,
        provenance: provenance("delivery-2", firstObservedAt),
      },
    });

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps a null stored observation key as compatible when both sides fail equally", async () => {
    // Both stored and incoming are Unavailable with mismatched semantic
    // authority (stored has no repository identity at all) — the differing
    // tie-break falls through to the observation-key localeCompare, and a
    // NULL stored key (`?? ""`) sorts before any incoming key.
    findFirst.mockResolvedValue({
      ...storedAuthority({
        availability: RepositoryDefaultAvailability.Unavailable,
        branchName: null,
        reason: RepositoryDefaultReason.RateLimited,
        observedAt: new Date(firstObservedAt),
      }),
      headRepositoryDefaultBranchObservationKey: null,
    });

    const changed = await persistPullRequestHeadRepositoryAuthority(db, scope, {
      unavailable: {
        reason: RepositoryDefaultReason.ProviderError,
        provenance: provenance("any-key", firstObservedAt),
      },
    });

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts an unavailable-vs-unavailable observation once the stored key sorts after the incoming one", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        availability: RepositoryDefaultAvailability.Unavailable,
        branchName: null,
        reason: RepositoryDefaultReason.RateLimited,
        observedAt: new Date(firstObservedAt),
        observationKey: "zzz-stored",
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(db, scope, {
      unavailable: {
        reason: RepositoryDefaultReason.ProviderError,
        provenance: provenance("aaa-incoming", firstObservedAt),
      },
    });

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryDefaultBranchReason:
          RepositoryDefaultReason.ProviderError,
      }),
    });
  });

  it("nulls both repository identities in a conflict between two different, unprovenanced repositories", async () => {
    // Equal time, both available/complete, but a DIFFERENT repository and
    // branch on each side — hasSameSemanticAuthority is false, both sides
    // available, so this is a genuine conflict. The stored side carries no
    // reconstructable provenance (source/trigger absent), so the conflict
    // falls back to the INCOMING provenance rather than the stored one.
    findFirst.mockResolvedValue({
      ...storedAuthority({ observedAt: new Date(firstObservedAt) }),
      headRepositoryDefaultBranchSource: null,
      headRepositoryDefaultBranchTrigger: null,
      headRepositoryDefaultBranchObservationKey: null,
    });

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      {
        authority: {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "202",
            fullName: "other-owner/other-repo",
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch: "other-branch",
          },
          provenance: provenance("conflict-a", firstObservedAt),
        },
      } as never,
      { name: "feature/conflict", oid: "f".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryGithubId: null,
        headRepositoryFullName: null,
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Unavailable,
        headRepositoryDefaultBranchReason: RepositoryDefaultReason.Conflicting,
        // Stored provenance couldn't be reconstructed, so the conflict record
        // carries the INCOMING observation's provenance instead.
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestWebhook,
        headRepositoryDefaultBranchObservationKey: "conflict-a",
      }),
    });
  });

  it("also falls back to incoming provenance when every stored field is present but the source is not a recognized value", async () => {
    // Distinct from the "unprovenanced" case above: every field the
    // reconstruction gate checks is present (a legacy/corrupt DB row, not an
    // absent one), so the row PASSES the presence gate and only fails Zod
    // validation on the `source` enum — a different failure mode of the same
    // "stored provenance couldn't be reconstructed" outcome.
    findFirst.mockResolvedValue({
      ...storedAuthority({ observedAt: new Date(firstObservedAt) }),
      headRepositoryDefaultBranchSource: "not_a_real_source",
    });

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      {
        authority: {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "202",
            fullName: "other-owner/other-repo",
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch: "other-branch",
          },
          provenance: provenance("conflict-b", firstObservedAt),
        },
      } as never,
      { name: "feature/conflict-3", oid: "f".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestWebhook,
        headRepositoryDefaultBranchObservationKey: "conflict-b",
      }),
    });
  });

  it("prefers the incoming provenance over a lexically-later stored identity in a same-repository conflict's tie-break", async () => {
    findFirst.mockResolvedValue({
      ...storedAuthority({
        observationKey: "bbb-stored",
        observedAt: new Date(firstObservedAt),
        eventAt: new Date(firstObservedAt),
      }),
      headRepositoryDefaultBranchCredentialOwnerId:
        "019ff900-4000-7000-8000-000000000099",
    });

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableWebhookObservation(
        "aaa-incoming",
        firstObservedAt,
        "other-branch"
      ),
      { name: "feature/conflict-2", oid: "f".repeat(40) }
    );

    expect(changed).toBe(true);
    // Both sides are the SAME repository here (only the branch differs), so
    // the identity is retained — the tie-break decides only the PROVENANCE
    // recorded for the conflict, and the incoming key sorts before the
    // stored one, so the incoming observation's provenance wins.
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryGithubId: "101",
        headRepositoryFullName: "fork-owner/repository",
        headRepositoryDefaultBranchReason: RepositoryDefaultReason.Conflicting,
        headRepositoryDefaultBranchObservationKey: "aaa-incoming",
        headRepositoryDefaultBranchCredentialOwnerId: null,
      }),
    });
  });

  it("sorts a stored row with no reconstructable identity before any incoming identity in an equal-time semantic tie", async () => {
    // Fully matching semantic authority (repo/branch/availability/
    // completeness/reason), but the stored row's own source and key are both
    // null — an empty identity string sorts before any real one, so the
    // stored row wins the tie-break and the write stays a no-op.
    findFirst.mockResolvedValue({
      ...storedAuthority({ observedAt: new Date(firstObservedAt) }),
      headRepositoryDefaultBranchSource: null,
      headRepositoryDefaultBranchObservationKey: null,
    });

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-1", firstObservedAt, "trunk"),
      { name: "feature/existing", oid: "c".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("compares provider event time, not receipt time, when repairing a legacy head-ref pair", async () => {
    // A delayed-but-earlier-event REST replay of the SAME observation key as
    // stored is still an exact replay (decideHeadAuthority's top short
    // circuit), so it falls to the legacy head-ref repair path — which reads
    // `eventAt`, not `observedAt`, off the incoming provenance.
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.SurfaceOpen,
        observationKey: "rest-1",
        headRefName: null,
        headRefOid: "a".repeat(40),
        eventAt: new Date("2026-08-10T19:00:00.000Z"),
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      {
        authority: {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "101",
            fullName: "fork-owner/repository",
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch: "trunk",
          },
          provenance: {
            source: RepositoryDefaultSource.PullRequestRest,
            mechanism: GitHubFetchMechanism.Rest,
            trigger: GitHubFetchTrigger.SurfaceOpen,
            credentialType: GitHubFetchCredentialType.GitHubApp,
            observationKey: "rest-1",
            observedAt: firstObservedAt,
            eventAt: "2026-08-10T19:00:00.000Z",
          },
        },
      } as never,
      { name: "feature/published", oid: "a".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        headRefName: null,
        headRefOid: "a".repeat(40),
      }),
      data: { headRefName: "feature/published", headRefOid: "a".repeat(40) },
    });
  });
});

function restAvailableObservation(
  observationKey: string,
  observedAt: string,
  defaultBranch: string
) {
  return {
    authority: {
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "101",
        fullName: "fork-owner/repository",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch,
      },
      provenance: {
        ...provenance(observationKey, observedAt),
        source: RepositoryDefaultSource.PullRequestRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.SurfaceOpen,
      },
    },
  } as never;
}

function availableWebhookObservation(
  observationKey: string,
  observedAt: string,
  defaultBranch: string
) {
  return {
    authority: {
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "101",
        fullName: "fork-owner/repository",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        completeness: RepositoryDefaultCompleteness.Complete,
        defaultBranch,
      },
      provenance: provenance(observationKey, observedAt),
    },
  } as never;
}

function provenance(observationKey: string, observedAt: string) {
  return {
    source: RepositoryDefaultSource.PullRequestWebhook,
    mechanism: GitHubFetchMechanism.Webhook,
    trigger: GitHubFetchTrigger.Webhook,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey,
    observedAt,
  };
}

function storedAuthority(
  overrides: {
    availability?: RepositoryDefaultAvailability;
    branchName?: string | null;
    headRefName?: string | null;
    headRefOid?: string | null;
    mechanism?: GitHubFetchMechanism;
    observationKey?: string;
    observedAt?: Date | null;
    eventAt?: Date | null;
    reason?: RepositoryDefaultReason | null;
    source?: RepositoryDefaultSource;
    trigger?: GitHubFetchTrigger;
  } = {}
) {
  return {
    headRefName:
      overrides.headRefName === undefined
        ? "feature/existing"
        : overrides.headRefName,
    headRefOid:
      overrides.headRefOid === undefined
        ? "c".repeat(40)
        : overrides.headRefOid,
    headRepositoryGithubId: "101",
    headRepositoryFullName: "fork-owner/repository",
    headRepositoryDefaultBranchName:
      overrides.branchName === undefined ? "trunk" : overrides.branchName,
    headRepositoryDefaultBranchAvailability:
      overrides.availability ?? RepositoryDefaultAvailability.Available,
    headRepositoryDefaultBranchCompleteness:
      RepositoryDefaultCompleteness.Complete,
    headRepositoryDefaultBranchReason: overrides.reason ?? null,
    headRepositoryDefaultBranchSource:
      overrides.source ?? RepositoryDefaultSource.PullRequestWebhook,
    headRepositoryDefaultBranchMechanism:
      overrides.mechanism ?? GitHubFetchMechanism.Webhook,
    headRepositoryDefaultBranchTrigger:
      overrides.trigger ?? GitHubFetchTrigger.Webhook,
    headRepositoryDefaultBranchCredentialType:
      GitHubFetchCredentialType.GitHubApp,
    headRepositoryDefaultBranchCredentialOwnerId: null,
    headRepositoryDefaultBranchObservationKey:
      overrides.observationKey ?? "delivery-1",
    headRepositoryDefaultBranchObservedAt:
      overrides.observedAt === undefined
        ? new Date(firstObservedAt)
        : overrides.observedAt,
    headRepositoryDefaultBranchEventAt: overrides.eventAt ?? null,
  };
}
