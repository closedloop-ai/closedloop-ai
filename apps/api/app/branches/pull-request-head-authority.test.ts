import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  repositoryDefaultAuthorityValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistPullRequestHeadRepositoryAuthority,
  pullRequestHeadRepositoryObservation,
} from "./pull-request-head-authority";

const HEAD_REF_GUARD_FUNCTION_REGEX =
  /CREATE FUNCTION "guard_pull_request_head_ref_pair"\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/;
const HEAD_REF_GUARD_TRIGGER_REGEX =
  /CREATE TRIGGER "pull_request_detail_head_ref_pair_guard"[\s\S]*?EXECUTE FUNCTION "guard_pull_request_head_ref_pair"\(\);/;
const HEAD_REF_MIGRATION_PATH = resolve(
  process.cwd(),
  "../../packages/database/prisma/migrations/20260814173000_iss6541_pull_request_head_ref_name/migration.sql"
);

const { createMany, findFirst, logError, logWarn, updateMany } = vi.hoisted(
  () => ({
    createMany: vi.fn(),
    findFirst: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    updateMany: vi.fn(),
  })
);

vi.mock("@repo/observability/log", () => ({
  log: { error: logError, warn: logWarn },
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
const laterObservedAt = "2026-08-10T20:05:00.000Z";

describe("persistPullRequestHeadRepositoryAuthority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMany.mockResolvedValue({ count: 1 });
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("makes an exact observation-key replay a no-op", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({ observationKey: "delivery-1" })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-1", firstObservedAt, "trunk"),
      { name: "feature/existing", oid: "c".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not repair an exact webhook replay after claiming its receipt", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        observationKey: "delivery-1",
        headRefName: null,
        headRefOid: null,
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-1", firstObservedAt, "trunk"),
      { name: " feature/published ", oid: "a".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(createMany).toHaveBeenCalledOnce();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("writes a normalized head name and oid in the accepted authority CAS", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        observationKey: "legacy",
        observedAt: null,
        headRefName: null,
        headRefOid: null,
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-1", firstObservedAt, "trunk"),
      { name: " feature/published ", oid: ` ${"a".repeat(40)} ` }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: scope.pullRequestDetailId,
        organizationId: scope.organizationId,
        headRefName: null,
        headRefOid: null,
      }),
      data: expect.objectContaining({
        headRefName: "feature/published",
        headRefOid: "a".repeat(40),
        headRepositoryDefaultBranchObservationKey: "delivery-1",
      }),
    });
  });

  it("carries the exact REST head pair when refresh callers omit the fourth argument", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        observationKey: "legacy",
        observedAt: null,
        headRefName: null,
        headRefOid: null,
      })
    );
    const authority = restAvailableObservation(
      "rest-refresh-1",
      laterObservedAt,
      "trunk"
    ).authority;

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      pullRequestHeadRepositoryObservation({
        headRepository: authority,
        headBranch: "feature/refreshed",
        headSha: "b".repeat(40),
      })
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRefName: "feature/refreshed",
        headRefOid: "b".repeat(40),
        headRepositoryDefaultBranchObservationKey: "rest-refresh-1",
      }),
    });
  });

  it("repairs a missing legacy name from an exact non-webhook replay", async () => {
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

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-1", firstObservedAt, "trunk"),
      { name: "feature/published", oid: "a".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: scope.pullRequestDetailId,
        organizationId: scope.organizationId,
        headRefName: null,
        headRefOid: "a".repeat(40),
      }),
      data: {
        headRefName: "feature/published",
        headRefOid: "a".repeat(40),
      },
    });
  });

  it("does not repair a legacy-null pair from a different observation identity", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        observationKey: "graphql-1",
        headRefName: null,
        headRefOid: "a".repeat(40),
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-1", firstObservedAt, "trunk"),
      { name: "feature/published", oid: "a".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("repairs a missing legacy oid when the stored head name matches", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.SurfaceOpen,
        observationKey: "rest-1",
        headRefName: "feature/published",
        headRefOid: null,
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-1", firstObservedAt, "trunk"),
      { name: "feature/published", oid: "a".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        headRefName: "feature/published",
        headRefOid: null,
      }),
      data: {
        headRefName: "feature/published",
        headRefOid: "a".repeat(40),
      },
    });
  });

  it("does not populate a fully unknown legacy pair from a replay", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestRest,
        mechanism: GitHubFetchMechanism.Rest,
        trigger: GitHubFetchTrigger.SurfaceOpen,
        observationKey: "rest-1",
        headRefName: null,
        headRefOid: null,
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-1", firstObservedAt, "trunk"),
      { name: "feature/published", oid: "a".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not repair a legacy-null member when the other member conflicts", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        source: RepositoryDefaultSource.PullRequestGraphql,
        mechanism: GitHubFetchMechanism.Graphql,
        observationKey: "graphql-1",
        headRefName: "feature/other",
        headRefOid: null,
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-1", firstObservedAt, "trunk"),
      { name: "feature/published", oid: "a".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { name: "", oid: "a".repeat(40) },
    { name: "feature/published", oid: "   " },
    { name: "feature/published", oid: null },
  ])("rejects available authority with an incomplete head pair", async (headRef) => {
    findFirst.mockResolvedValue(storedAuthority());

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-2", laterObservedAt, "main"),
      headRef
    );

    expect(changed).toBe(false);
    expect(findFirst).toHaveBeenCalledOnce();
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts a newer live REST snapshot after an older webhook event", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        observationKey: "delivery-old-a",
        observedAt: new Date("2026-08-10T20:04:00.000Z"),
        eventAt: new Date(firstObservedAt),
        headRefName: "feature/one",
        headRefOid: "a".repeat(40),
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      restAvailableObservation("rest-snapshot-b", laterObservedAt, "trunk"),
      { name: "feature/two", oid: "b".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRefName: "feature/two",
        headRefOid: "b".repeat(40),
        headRepositoryDefaultBranchObservationKey: "rest-snapshot-b",
      }),
    });
  });

  it("uses the durable receipt to reject a non-consecutive webhook replay", async () => {
    findFirst.mockResolvedValue(storedAuthority());
    createMany.mockResolvedValue({ count: 0 });

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-1", laterObservedAt, "trunk"),
      { name: "feature/must-not-write", oid: "b".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          observationKey: "delivery-1",
          targetId: scope.pullRequestDetailId,
          targetKind: "pull_request_detail",
        }),
      ],
      skipDuplicates: true,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps D2 after a D1, D2, D1 webhook delivery sequence", async () => {
    const d1 = availableObservation(
      "delivery-1",
      firstObservedAt,
      "trunk",
      "2026-08-10T19:00:00.000Z"
    );
    const d2 = availableObservation(
      "delivery-2",
      laterObservedAt,
      "trunk",
      "2026-08-10T19:05:00.000Z"
    );
    findFirst
      .mockResolvedValueOnce(
        storedAuthority({
          observationKey: "legacy",
          observedAt: null,
          headRefName: null,
          headRefOid: null,
        })
      )
      .mockResolvedValueOnce(
        storedAuthority({
          observationKey: "delivery-1",
          eventAt: new Date("2026-08-10T19:00:00.000Z"),
          headRefName: "feature/one",
          headRefOid: "a".repeat(40),
        })
      )
      .mockResolvedValueOnce(
        storedAuthority({
          observationKey: "delivery-2",
          observedAt: new Date(laterObservedAt),
          eventAt: new Date("2026-08-10T19:05:00.000Z"),
          headRefName: "feature/two",
          headRefOid: "b".repeat(40),
        })
      );
    createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await persistPullRequestHeadRepositoryAuthority(db, scope, d1, {
      name: "feature/one",
      oid: "a".repeat(40),
    });
    await persistPullRequestHeadRepositoryAuthority(db, scope, d2, {
      name: "feature/two",
      oid: "b".repeat(40),
    });
    const replayChanged = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      d1,
      { name: "feature/one", oid: "a".repeat(40) }
    );

    expect(replayChanged).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRefName: "feature/two",
        headRefOid: "b".repeat(40),
      }),
    });
  });

  it("scopes replay keys by source", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({ observationKey: "shared-key" })
    );
    const observation = availableObservation(
      "shared-key",
      laterObservedAt,
      "trunk"
    );
    if (observation.authority) {
      observation.authority.provenance.source =
        RepositoryDefaultSource.PullRequestRest;
    }

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      observation,
      { name: "feature/shared", oid: "a".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryDefaultBranchSource:
          RepositoryDefaultSource.PullRequestRest,
        headRepositoryDefaultBranchObservationKey: "shared-key",
        headRepositoryDefaultBranchObservedAt: new Date(laterObservedAt),
      }),
    });
  });

  it("rejects an older observation without mutating authority", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({ observedAt: new Date(laterObservedAt) })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-older", firstObservedAt, "trunk"),
      { name: "feature/must-not-write", oid: "b".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "github_repository_default_authority_stale_rejected",
      expect.objectContaining({
        organizationId: scope.organizationId,
        reason: "stale_observation",
      })
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("rejects a delayed webhook with an older provider event time", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        observedAt: new Date(firstObservedAt),
        eventAt: new Date("2026-08-10T19:00:00.000Z"),
      })
    );
    const delayed = availableObservation(
      "delivery-delayed",
      laterObservedAt,
      "main",
      "2026-08-10T18:00:00.000Z"
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      delayed,
      { name: "feature/delayed", oid: "d".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      mechanism: GitHubFetchMechanism.Rest,
      source: RepositoryDefaultSource.PullRequestRest,
    },
    {
      mechanism: GitHubFetchMechanism.Graphql,
      source: RepositoryDefaultSource.PullRequestGraphql,
    },
  ])("rejects a delayed webhook behind a newer $mechanism snapshot", async ({
    mechanism,
    source,
  }) => {
    findFirst.mockResolvedValue(
      storedAuthority({
        source,
        mechanism,
        observationKey: "live-snapshot-b",
        observedAt: new Date(laterObservedAt),
        headRefName: "feature/two",
        headRefOid: "b".repeat(40),
      })
    );
    const delayed = availableObservation(
      "delivery-delayed-a",
      "2026-08-10T20:10:00.000Z",
      "trunk",
      firstObservedAt
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      delayed,
      { name: "feature/one", oid: "a".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("emits the monitored stale event when compare-and-swap is exhausted", async () => {
    findFirst.mockResolvedValue(storedAuthority());
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      persistPullRequestHeadRepositoryAuthority(
        db,
        scope,
        availableObservation("delivery-2", laterObservedAt, "main"),
        { name: "feature/retry", oid: "a".repeat(40) }
      )
    ).rejects.toThrow(
      "Webhook repository-default authority compare-and-swap exhausted"
    );

    expect(logError).toHaveBeenCalledWith(
      "github_repository_default_authority_stale_rejected",
      expect.objectContaining({
        organizationId: scope.organizationId,
        reason: "compare_and_swap_exhausted",
      })
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("retries the accepted pair with one webhook receipt claim", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        observationKey: "delivery-1",
        headRefName: null,
        headRefOid: null,
      })
    );
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-2", laterObservedAt, "main"),
      { name: "feature/retry", oid: "d".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(createMany).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("advances freshness for a later same-value observation with a new key", async () => {
    findFirst.mockResolvedValue(storedAuthority());

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-2", laterObservedAt, "trunk"),
      { name: "feature/existing", oid: "c".repeat(40) }
    );

    expect(changed).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: scope.pullRequestDetailId,
        organizationId: scope.organizationId,
        headRepositoryDefaultBranchObservationKey: "delivery-1",
      }),
      data: expect.objectContaining({
        headRepositoryDefaultBranchName: "trunk",
        headRepositoryDefaultBranchObservationKey: "delivery-2",
        headRepositoryDefaultBranchObservedAt: new Date(laterObservedAt),
      }),
    });
  });

  it("retains a known branch as stale after a later poorer observation", async () => {
    findFirst.mockResolvedValue(storedAuthority());

    await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      {
        unavailable: {
          reason: RepositoryDefaultReason.PermissionFiltered,
          provenance: provenance("delivery-2", laterObservedAt),
        },
      },
      { name: "feature/must-not-write", oid: "d".repeat(40) }
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryGithubId: "101",
        headRepositoryFullName: "fork-owner/repository",
        headRepositoryDefaultBranchName: "trunk",
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Stale,
        headRepositoryDefaultBranchCompleteness:
          RepositoryDefaultCompleteness.Partial,
        headRepositoryDefaultBranchReason:
          RepositoryDefaultReason.PermissionFiltered,
      }),
    });
    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("headRefName");
    expect(data).not.toHaveProperty("headRefOid");
  });

  it("continues retaining a previously stale known branch", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        availability: RepositoryDefaultAvailability.Stale,
        observedAt: new Date(firstObservedAt),
      })
    );

    await persistPullRequestHeadRepositoryAuthority(db, scope, {
      unavailable: {
        reason: RepositoryDefaultReason.RateLimited,
        provenance: provenance("delivery-3", laterObservedAt),
      },
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryDefaultBranchName: "trunk",
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Stale,
        headRepositoryDefaultBranchReason: RepositoryDefaultReason.RateLimited,
      }),
    });
    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("headRefName");
    expect(data).not.toHaveProperty("headRefOid");
  });

  it("records equal-time differing valid defaults as unavailable conflict", async () => {
    findFirst.mockResolvedValue(storedAuthority());

    await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-2", firstObservedAt, "main"),
      { name: "feature/conflict", oid: "d".repeat(40) }
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.any(Object),
      data: expect.objectContaining({
        headRepositoryDefaultBranchName: null,
        headRepositoryDefaultBranchAvailability:
          RepositoryDefaultAvailability.Unavailable,
        headRepositoryDefaultBranchReason: RepositoryDefaultReason.Conflicting,
      }),
    });
    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("headRefName");
    expect(data).not.toHaveProperty("headRefOid");
    expect(logError).toHaveBeenCalledWith(
      "github_repository_default_authority_conflict",
      expect.objectContaining({
        organizationId: scope.organizationId,
        reason: RepositoryDefaultReason.Conflicting,
      })
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("keeps an equal-time conflict sticky when either original value reappears", async () => {
    findFirst.mockResolvedValue(
      storedAuthority({
        availability: RepositoryDefaultAvailability.Unavailable,
        branchName: null,
        reason: RepositoryDefaultReason.Conflicting,
      })
    );

    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      availableObservation("delivery-3", firstObservedAt, "trunk"),
      { name: "feature/conflict-replay", oid: "e".repeat(40) }
    );

    expect(changed).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("emits the monitored malformed event when malformed evidence is accepted", async () => {
    findFirst.mockResolvedValue(storedAuthority({ observedAt: null }));
    const malformed = availableObservation(
      "delivery-malformed",
      laterObservedAt,
      "trunk"
    );
    if (malformed.authority) {
      malformed.authority.evidence = {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.Malformed,
      };
    }

    await persistPullRequestHeadRepositoryAuthority(db, scope, malformed, {
      name: "feature/must-not-write",
      oid: "d".repeat(40),
    });

    expect(logError).toHaveBeenCalledWith(
      "github_repository_default_authority_malformed",
      expect.objectContaining({
        organizationId: scope.organizationId,
        providerRepositoryId: "101",
        reason: RepositoryDefaultReason.Malformed,
        source: RepositoryDefaultSource.PullRequestWebhook,
      })
    );
    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("headRefName");
    expect(data).not.toHaveProperty("headRefOid");
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("preserves omission for a version-skewed producer", async () => {
    const changed = await persistPullRequestHeadRepositoryAuthority(
      db,
      scope,
      undefined
    );

    expect(changed).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("pull-request head-ref rolling-deploy migration guard", () => {
  const migrationSql = readFileSync(HEAD_REF_MIGRATION_PATH, "utf8");
  const guardFunction = migrationSql.match(HEAD_REF_GUARD_FUNCTION_REGEX)?.[0];
  const guardTrigger = migrationSql.match(HEAD_REF_GUARD_TRIGGER_REGEX)?.[0];

  it("clears only the new pair member when an old writer changes oid without authority advancement", () => {
    expect(guardFunction).toContain('OLD."head_ref_name" IS NOT NULL');
    expect(guardFunction).toContain('OLD."head_ref_oid" IS NOT NULL');
    expect(guardFunction).toContain(
      'NEW."head_ref_oid" IS DISTINCT FROM OLD."head_ref_oid"'
    );
    expect(guardFunction).toContain(
      'NEW."head_ref_name" IS NOT DISTINCT FROM OLD."head_ref_name"'
    );
    expect(guardFunction).toContain(
      'NEW."head_repository_default_branch_source"'
    );
    expect(guardFunction).toContain(
      'NEW."head_repository_default_branch_observation_key"'
    );
    expect(guardFunction).toContain(
      'NEW."head_repository_default_branch_observed_at"'
    );
    expect(guardFunction).toContain(
      'NEW."head_repository_default_branch_event_at"'
    );
    expect(guardFunction).toContain('NEW."head_ref_name" := NULL');
  });

  it("runs before every oid update", () => {
    expect(guardTrigger).toContain(
      'BEFORE UPDATE OF "head_ref_oid" ON "pull_request_detail"'
    );
    expect(guardTrigger).toContain(
      'EXECUTE FUNCTION "guard_pull_request_head_ref_pair"()'
    );
  });
});

function availableObservation(
  observationKey: string,
  observedAt: string,
  defaultBranch: string,
  eventAt?: string
) {
  return {
    authority: repositoryDefaultAuthorityValidator.parse({
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
      provenance: provenance(observationKey, observedAt, eventAt),
    }),
  };
}

function restAvailableObservation(
  observationKey: string,
  observedAt: string,
  defaultBranch: string
) {
  const observation = availableObservation(
    observationKey,
    observedAt,
    defaultBranch
  );
  observation.authority.provenance = {
    ...observation.authority.provenance,
    source: RepositoryDefaultSource.PullRequestRest,
    mechanism: GitHubFetchMechanism.Rest,
    trigger: GitHubFetchTrigger.SurfaceOpen,
  };
  return observation;
}

function provenance(
  observationKey: string,
  observedAt: string,
  eventAt?: string
) {
  return {
    source: RepositoryDefaultSource.PullRequestWebhook,
    mechanism: GitHubFetchMechanism.Webhook,
    trigger: GitHubFetchTrigger.Webhook,
    credentialType: GitHubFetchCredentialType.GitHubApp,
    observationKey,
    observedAt,
    ...(eventAt ? { eventAt } : {}),
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
