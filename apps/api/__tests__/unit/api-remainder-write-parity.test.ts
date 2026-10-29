/**
 * ISS-6322 (batch 6/6) — parity + narrowing for the discarded Prisma writes in
 * `apps/api/app/{settings,users,teams,catalog,compute-targets}`,
 * `apps/api/lib`, `apps/api/scripts` and `apps/mcp`.
 *
 * Each site swaps a write that RETURNed every column for one that returns the
 * model's primary key. Two things must be proven, and the second is why this
 * file exists at all:
 *
 *  1. NARROWING — the write asks Postgres for exactly the primary key. Fails
 *     before the change, passes after. `PrimaryKeyColumn` names it per model so
 *     a `{ id: true }` applied to a model keyed on something else (`BranchDetail`
 *     on `artifactId`, `LocalGatewayChallengeJti` on `jti`) fails here rather
 *     than in production.
 *
 *  2. PARITY — nothing else moved. In particular `update` must still REJECT
 *     with `P2025` when its `where` matches no row: the tempting conversion is
 *     `updateMany`, which reports `{ count: 0 }` and turns a loud failure into a
 *     silent no-op. A `vi.fn().mockResolvedValue({})` cannot tell those two
 *     apart, so the existing suites for these modules are structurally blind to
 *     that regression — which is the point of driving them through
 *     `createFakeDelegate`, a double that models the row set.
 *
 * The absent-row case is asserted BEFORE and AFTER the narrowing in the same
 * suite, so a later edit that reaches for `updateMany` to shave the last
 * allocation cannot land green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  kmsSend: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ values }),
  },
}));

vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn(() => undefined),
}));

vi.mock("@aws-sdk/client-kms", () => {
  class EncryptCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class DecryptCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class KMSClient {
    send = mocks.kmsSend;
  }
  return { DecryptCommand, EncryptCommand, KMSClient };
});

import {
  createFakeDelegate,
  type FakeDelegate,
  PrimaryKeyColumn,
  PrismaWriteErrorCode,
} from "@/__tests__/support/prisma-write-semantics.test-fixtures";
import { teamsService } from "@/app/teams/service";
import { usersService } from "@/app/users/service";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import { saveCapabilityVerdict } from "@/lib/github/github-capability-store";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const NOW = new Date("2026-02-01T00:00:00.000Z");

/** Route `withDb(cb)` and `withDb.tx(cb)` at the same client stub. */
function installDb(client: Record<string, unknown>) {
  mocks.withDb.mockImplementation(
    (callback: (db: Record<string, unknown>) => unknown) => callback(client)
  );
  mocks.withDb.tx.mockImplementation(
    (callback: (tx: Record<string, unknown>) => unknown) => callback(client)
  );
}

/**
 * The columns the last `method` write asked Postgres to RETURN.
 *
 * `null` is the un-narrowed `RETURNING *` this batch removes; `undefined` means
 * no such write ran at all, which must also fail the caller's `toEqual([pk])` —
 * a site whose write never executed is not a narrowed site.
 */
function returnedColumns(
  delegate: FakeDelegate,
  method: "create" | "update" | "upsert"
): string[] | null | undefined {
  const matching = delegate.writes.filter((write) => write.method === method);
  return matching.at(-1)?.selected;
}

describe("users deactivateByClerkIdAndOrg narrowing (ISS-6322)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deactivates and returns only the user primary key", async () => {
    const user = createFakeDelegate([
      { id: USER_ID, clerkId: "clerk-1", organizationId: ORG_ID, active: true },
    ]);
    installDb({ user });

    await usersService.deactivateByClerkIdAndOrg("clerk-1", ORG_ID);

    expect(user.rows[0]).toMatchObject({ active: false });
    expect(returnedColumns(user, "update")).toEqual([PrimaryKeyColumn.User]);
  });

  it("still rejects with P2025 when no user matches, which the caller relies on", async () => {
    // `auth-hooks` discards the return value, so the THROW is the only signal a
    // membership-deleted webhook has that it deactivated nothing.
    const user = createFakeDelegate([]);
    installDb({ user });

    await expect(
      usersService.deactivateByClerkIdAndOrg("clerk-1", ORG_ID)
    ).rejects.toMatchObject({ code: PrismaWriteErrorCode.NotFound });
  });
});

describe("teams createWithOwner narrowing (ISS-6322)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the membership and returns only its primary key, keeping the team row", async () => {
    const team = createFakeDelegate([]);
    const teamMember = createFakeDelegate([]);
    installDb({ team, teamMember });

    const created = await teamsService.createWithOwner(ORG_ID, USER_ID, {
      name: "Platform",
    });

    // The TEAM create is deliberately NOT narrowed — its row is the value the
    // service reports. Only the membership write is discarded.
    expect(created).toMatchObject({
      ok: true,
      value: { organizationId: ORG_ID, name: "Platform" },
    });
    expect(teamMember.rows[0]).toMatchObject({
      userId: USER_ID,
      role: "OWNER",
    });
    expect(returnedColumns(teamMember, "create")).toEqual([
      PrimaryKeyColumn.TeamMember,
    ]);
  });
});

describe("review-decision aggregate narrowing (ISS-6322)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps the aggregate and returns only the detail primary key", async () => {
    const pullRequestDetail = createFakeDelegate([
      { id: "prd-1", reviewDecision: null },
    ]);
    const gitHubPRReview = {
      findMany: vi.fn().mockResolvedValue([{ state: "APPROVED" }]),
    };

    const decision = await recomputeAndUpdateAggregate(
      { pullRequestDetail, gitHubPRReview } as never,
      "prd-1"
    );

    expect(decision).toBe("APPROVED");
    expect(pullRequestDetail.rows[0]).toMatchObject({
      reviewDecision: "APPROVED",
    });
    expect(returnedColumns(pullRequestDetail, "update")).toEqual([
      PrimaryKeyColumn.PullRequestDetail,
    ]);
  });

  it("still rejects with P2025 when the detail row is gone", async () => {
    const pullRequestDetail = createFakeDelegate([]);
    const gitHubPRReview = { findMany: vi.fn().mockResolvedValue([]) };

    await expect(
      recomputeAndUpdateAggregate(
        { pullRequestDetail, gitHubPRReview } as never,
        "prd-1"
      )
    ).rejects.toMatchObject({ code: PrismaWriteErrorCode.NotFound });
  });
});

describe("branch status-check invalidation narrowing (ISS-6322)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resets the detail and returns only artifactId, NOT id", async () => {
    // `BranchDetail` is a class-table-inheritance model with NO `id` column, so
    // `select: { id: true }` here would be a runtime Prisma error, not a subtler
    // regression. This is the trap that broke seven sites in ISS-6319.
    const branchDetail = createFakeDelegate(
      [{ artifactId: "artifact-1", checksDetailTotalCount: 7 }],
      [["artifactId"]]
    );
    const branchStatusCheck = { deleteMany: vi.fn().mockResolvedValue({}) };

    await invalidateBranchStatusChecksForHeadChange(
      { branchDetail, branchStatusCheck } as never,
      "artifact-1"
    );

    expect(branchDetail.rows[0]).toMatchObject({ checksDetailTotalCount: 0 });
    expect(returnedColumns(branchDetail, "update")).toEqual([
      PrimaryKeyColumn.BranchDetail,
    ]);
  });

  it("still rejects with P2025 when the branch detail is absent", async () => {
    const branchDetail = createFakeDelegate([], [["artifactId"]]);
    const branchStatusCheck = { deleteMany: vi.fn().mockResolvedValue({}) };

    await expect(
      invalidateBranchStatusChecksForHeadChange(
        { branchDetail, branchStatusCheck } as never,
        "artifact-1"
      )
    ).rejects.toMatchObject({ code: PrismaWriteErrorCode.NotFound });
  });
});

describe("github capability store narrowing (ISS-6322)", () => {
  const verdict = {
    organizationId: ORG_ID,
    githubUserConnectionId: "conn-1",
    normalizedTargetOwner: "acme",
    targetOwner: "Acme",
    targetRepo: "app",
    credentialKind: "app",
    denialReason: null,
    installationId: 42,
    checkedAt: NOW,
    expiresAt: new Date("2026-02-02T00:00:00.000Z"),
  };

  beforeEach(() => vi.clearAllMocks());

  it("inserts the verdict and returns only the capability primary key", async () => {
    const gitHubAccessCapability = createFakeDelegate([]);

    await saveCapabilityVerdict(
      { gitHubAccessCapability } as never,
      verdict as never
    );

    expect(gitHubAccessCapability.rows).toHaveLength(1);
    expect(returnedColumns(gitHubAccessCapability, "create")).toEqual([
      PrimaryKeyColumn.GitHubAccessCapability,
    ]);
  });

  it("refreshes a stale row through the guarded update, never reaching the create", async () => {
    // The guard's TRUE branch. Without this the suite only ever exercised the
    // freshness gate failing, so an inverted `checkedAt: { lte }` comparison
    // would have looked identical: no row updated, create runs, P2002. Here the
    // stored verdict is OLDER than the incoming one, so the update must win and
    // the create must never be attempted.
    const gitHubAccessCapability = createFakeDelegate([
      {
        id: "cap-1",
        organizationId: ORG_ID,
        githubUserConnectionId: "conn-1",
        normalizedTargetOwner: "acme",
        targetRepo: "app",
        checkedAt: new Date("2026-01-01T00:00:00.000Z"),
        credentialKind: "stale",
      },
    ]);

    await saveCapabilityVerdict(
      { gitHubAccessCapability } as never,
      verdict as never
    );

    expect(gitHubAccessCapability.rows[0]).toMatchObject({
      credentialKind: "app",
      checkedAt: NOW,
    });
    expect(
      gitHubAccessCapability.writes.filter((write) => write.method === "create")
    ).toHaveLength(0);
    expect(
      gitHubAccessCapability.writes.filter(
        (write) => write.method === "updateMany"
      )
    ).toHaveLength(1);
  });

  it("still routes a lost create race through the P2002 catch, not a throw", async () => {
    // The guarded `updateMany` matches nothing (its `checkedAt <=` freshness
    // gate fails against the seeded row), so the `create` runs and collides.
    // The narrowed write must keep raising P2002 so the catch can re-run the
    // guarded update — swallowing it would drop the verdict silently.
    const gitHubAccessCapability = createFakeDelegate(
      [
        {
          id: "cap-1",
          organizationId: ORG_ID,
          githubUserConnectionId: "conn-1",
          normalizedTargetOwner: "acme",
          targetRepo: "app",
          checkedAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ],
      [
        [
          "organizationId",
          "githubUserConnectionId",
          "normalizedTargetOwner",
          "targetRepo",
        ],
      ]
    );

    await expect(
      saveCapabilityVerdict(
        { gitHubAccessCapability } as never,
        verdict as never
      )
    ).resolves.toBeUndefined();

    const creates = gitHubAccessCapability.writes.filter(
      (write) => write.method === "create"
    );
    expect(creates).toHaveLength(1);
    // Two guarded updates: the pre-check and the post-collision retry.
    expect(
      gitHubAccessCapability.writes.filter(
        (write) => write.method === "updateMany"
      )
    ).toHaveLength(2);
  });
});
