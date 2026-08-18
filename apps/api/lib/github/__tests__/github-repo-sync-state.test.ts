import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

// Passthrough, not a hand-rolled stub: the tier now reads verdict rows through
// the real capability-store helpers, which key on this module's
// `normalizeGitHubName` / `storedGitHubCredentialKind`. Stubbing a subset here
// would silently diverge from how production normalizes and matches.
vi.mock(
  "@/lib/github/github-connection-credential",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/github/github-connection-credential")
    >()),
  })
);

vi.mock("@repo/api/src/types/branch", () => ({
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

// Run the fan-out sequentially so upsert call assertions are deterministic.
vi.mock("@/lib/db-fanout", () => ({
  mapWithDbConcurrency: (
    items: readonly unknown[],
    fn: (item: unknown, index: number) => Promise<unknown>
  ) => Promise.all(items.map((item, index) => fn(item, index))),
}));

import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import {
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubCapabilityTtlMs,
} from "@/lib/github/github-access";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import {
  classifyRepoSyncTier,
  GitHubRepoSyncTier,
  reclassifyRepoSyncState,
  reconcileOrgRepoSyncStates,
  resolveRepoSyncTier,
  selectUnbootstrappedOrgIds,
} from "@/lib/github/github-repo-sync-state";

type MockDb = {
  gitHubInstallation: { findUnique: ReturnType<typeof vi.fn> };
  gitHubUserConnection: { findMany: ReturnType<typeof vi.fn> };
  gitHubAccessCapability: { findMany: ReturnType<typeof vi.fn> };
  gitHubInstallationRepository: { findMany: ReturnType<typeof vi.fn> };
  pullRequestDetail: {
    findMany: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  gitHubRepoSyncState: { upsert: ReturnType<typeof vi.fn> };
  organization: { findMany: ReturnType<typeof vi.fn> };
};

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};

const NOW = new Date("2026-08-03T12:00:00.000Z");
const ORG = "org-1";

function makeDb(): MockDb {
  return {
    gitHubInstallation: { findUnique: vi.fn().mockResolvedValue(null) },
    gitHubUserConnection: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubAccessCapability: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubInstallationRepository: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequestDetail: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    gitHubRepoSyncState: { upsert: vi.fn().mockResolvedValue({}) },
    organization: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

function wire(db: MockDb): void {
  mockWithDb.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveRepoSyncTier", () => {
  it("ranks installation over a user token over nothing", () => {
    expect(
      resolveRepoSyncTier({
        hasCoveringInstallation: true,
        hasRepoScopedConnection: true,
      })
    ).toBe(GitHubRepoSyncTier.Installed);
    expect(
      resolveRepoSyncTier({
        hasCoveringInstallation: false,
        hasRepoScopedConnection: true,
      })
    ).toBe(GitHubRepoSyncTier.UserToken);
    expect(
      resolveRepoSyncTier({
        hasCoveringInstallation: false,
        hasRepoScopedConnection: false,
      })
    ).toBe(GitHubRepoSyncTier.Unsyncable);
  });
});

describe("classifyRepoSyncTier", () => {
  const input = { organizationId: ORG, owner: "acme", repo: "widgets" };

  it("is tier-1 installed when an ACTIVE installation covers the repo", async () => {
    const db = makeDb();
    db.gitHubInstallation.findUnique.mockResolvedValue({
      status: "ACTIVE",
      repositories: [{ id: "repo-row" }],
    });
    wire(db);

    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.Installed
    );
  });

  it("is tier-2 user_token when no installation covers it but a repo-scoped connection exists", async () => {
    const db = makeDb();
    db.gitHubInstallation.findUnique.mockResolvedValue({
      status: "ACTIVE",
      repositories: [],
    });
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE], capabilities: [] },
    ]);
    wire(db);

    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.UserToken
    );
    // App-family (empty-scope) tokens are excluded at the query level: the
    // candidate filter requires the `repo` scope and non-revoked.
    expect(db.gitHubUserConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          revokedAt: null,
          scopes: { has: GITHUB_REPO_SCOPE },
        }),
      })
    );
  });

  it("is tier-3 unsyncable when nothing covers it and no repo-scoped connection exists", async () => {
    const db = makeDb();
    wire(db);
    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.Unsyncable
    );
  });
});

// ISS-5093: a repo-scoped connection that the sync lane has proven cannot reach
// a repo must not count as "covering" it. A durable (6h) verdict is the only
// kind that warrants demotion — a 5-minute interactive verdict must not.
describe("classifyRepoSyncTier (ISS-5093 durable verdict exclusion)", () => {
  const input = {
    organizationId: ORG,
    owner: "acme",
    repo: "widgets",
    now: NOW,
  };

  it("is unsyncable when the only repo-scoped connection holds a durable 6h no-access verdict", async () => {
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      {
        id: "conn-1",
        scopes: [GITHUB_REPO_SCOPE],
        capabilities: [
          {
            credentialKind: GitHubCredentialKind.OauthUser,
            denialReason: GitHubAccessDenialReason.NoInstallation,
            checkedAt: NOW,
            expiresAt: new Date(
              NOW.getTime() + GITHUB_SYNC_REPO_VERDICT_TTL_MS
            ),
          },
        ],
      },
    ]);
    wire(db);

    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.Unsyncable
    );
  });

  it("a 5-minute interactive denial does not demote a repo — the connection still covers it", async () => {
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      {
        id: "conn-1",
        scopes: [GITHUB_REPO_SCOPE],
        capabilities: [
          {
            credentialKind: GitHubCredentialKind.OauthUser,
            denialReason: GitHubAccessDenialReason.NoInstallation,
            checkedAt: NOW,
            expiresAt: new Date(NOW.getTime() + GitHubCapabilityTtlMs.Negative),
          },
        ],
      },
    ]);
    wire(db);

    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.UserToken
    );
  });

  it("is user_token when the connection holds no verdict rows for this repo", async () => {
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE], capabilities: [] },
    ]);
    wire(db);

    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.UserToken
    );
  });
});

describe("reclassifyRepoSyncState", () => {
  it("upserts only tier + lastTierEvaluatedAt, preserving reconciler-owned fields, with a normalized identity", async () => {
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE], capabilities: [] },
    ]);
    wire(db);

    const tier = await reclassifyRepoSyncState({
      organizationId: ORG,
      owner: "Acme",
      repo: "Widgets",
      now: NOW,
    });

    expect(tier).toBe(GitHubRepoSyncTier.UserToken);
    expect(db.gitHubRepoSyncState.upsert).toHaveBeenCalledWith({
      where: {
        organizationId_repositoryFullName: {
          organizationId: ORG,
          repositoryFullName: "acme/widgets",
        },
      },
      create: {
        organizationId: ORG,
        repositoryFullName: "acme/widgets",
        tier: GitHubRepoSyncTier.UserToken,
        lastTierEvaluatedAt: NOW,
      },
      update: {
        tier: GitHubRepoSyncTier.UserToken,
        lastTierEvaluatedAt: NOW,
      },
    });
    // The update must NOT touch watermark/cursor/failureCount/deferredReason.
    const updateArg = db.gitHubRepoSyncState.upsert.mock.calls[0][0].update;
    expect(Object.keys(updateArg).sort()).toEqual([
      "lastTierEvaluatedAt",
      "tier",
    ]);
  });
});

describe("reconcileOrgRepoSyncStates", () => {
  it("classifies covered repos as installed and projection-only repos by connection state, in one bulk pass", async () => {
    const db = makeDb();
    db.gitHubInstallationRepository.findMany.mockResolvedValue([
      { fullName: "acme/covered" },
    ]);
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE], capabilities: [] },
    ]);
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/covered" },
      { repositoryFullName: "acme/pull-only" },
    ]);
    wire(db);

    const count = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(count).toBe(2);
    const tiersByRepo = new Map(
      db.gitHubRepoSyncState.upsert.mock.calls.map((call) => [
        call[0].where.organizationId_repositoryFullName.repositoryFullName,
        call[0].create.tier,
      ])
    );
    expect(tiersByRepo.get("acme/covered")).toBe(GitHubRepoSyncTier.Installed);
    expect(tiersByRepo.get("acme/pull-only")).toBe(
      GitHubRepoSyncTier.UserToken
    );
  });

  it("counts only ACTIVE-installation repos as covering (suspended installations are not tier-1)", async () => {
    const db = makeDb();
    db.gitHubInstallationRepository.findMany.mockResolvedValue([]);
    db.pullRequestDetail.groupBy.mockResolvedValue([]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(db.gitHubInstallationRepository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          installation: expect.objectContaining({
            organizationId: ORG,
            status: GitHubInstallationStatus.ACTIVE,
          }),
          removedAt: null,
        }),
      })
    );
  });

  it("reads projection repos via groupBy for DB-side deduplication", async () => {
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(db.pullRequestDetail.groupBy).toHaveBeenCalledWith({
      by: ["repositoryFullName"],
      where: { organizationId: ORG, repositoryFullName: { not: null } },
    });
  });

  it("classifies projection repos as unsyncable when no installation and no connection exist", async () => {
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/orphan" },
    ]);
    wire(db);

    const count = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(count).toBe(1);
    expect(db.gitHubRepoSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          repositoryFullName: "acme/orphan",
          tier: GitHubRepoSyncTier.Unsyncable,
        }),
      })
    );
  });

  it("agrees with the per-repo classifier: durably denied repo is unsyncable, non-denied repo is user_token", async () => {
    // Mixed-case names: normalization must split + normalizeGitHubName each part
    // so the key used to look up denial rows matches the key the denial rows
    // were stored under. A normalization bug (e.g. treating the full name as
    // opaque) would make all repos fall through to coverage=true / user_token.
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE] },
    ]);
    db.gitHubAccessCapability.findMany.mockResolvedValue([
      {
        githubUserConnectionId: "conn-1",
        normalizedTargetOwner: "acme",
        targetRepo: "widgets",
        credentialKind: GitHubCredentialKind.OauthUser,
        denialReason: GitHubAccessDenialReason.NoInstallation,
        checkedAt: NOW,
        expiresAt: new Date(NOW.getTime() + GITHUB_SYNC_REPO_VERDICT_TTL_MS),
      },
    ]);
    // Mixed-case full names hit normalizeRepoFullName → lowercase, then
    // verdictRepoKey splits and re-normalizes each segment.
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "Acme/Widgets" },
      { repositoryFullName: "Acme/Private" },
    ]);
    wire(db);

    const count = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(count).toBe(2);
    const tiersByRepo = new Map(
      db.gitHubRepoSyncState.upsert.mock.calls.map((call) => [
        call[0].where.organizationId_repositoryFullName.repositoryFullName,
        call[0].create.tier,
      ])
    );
    expect(tiersByRepo.get("acme/widgets")).toBe(GitHubRepoSyncTier.Unsyncable);
    expect(tiersByRepo.get("acme/private")).toBe(GitHubRepoSyncTier.UserToken);
  });

  it("queries gitHubAccessCapability with denialReason: { not: null } to avoid O(repos × connections) volume", async () => {
    // Positive verdicts are written on EVERY successful sweep; loading them
    // would be quadratic in the product of repos and connections. Only denial
    // rows can change a tier, so the filter is both a correctness gate and a
    // query-cost guard.
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE] },
    ]);
    db.gitHubAccessCapability.findMany.mockResolvedValue([]);
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/widgets" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(db.gitHubAccessCapability.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          denialReason: { not: null },
        }),
      })
    );
  });
});

describe("selectUnbootstrappedOrgIds", () => {
  it("selects orgs with candidate repos and zero sync-state rows using the termination-invariant predicate", async () => {
    const db = makeDb();
    db.organization.findMany.mockResolvedValue([{ id: "org-1" }]);
    wire(db);

    const ids = await selectUnbootstrappedOrgIds(25);

    expect(ids).toEqual(["org-1"]);
    expect(db.organization.findMany).toHaveBeenCalledWith({
      where: {
        githubRepoSyncStates: { none: {} },
        OR: [
          {
            githubInstallation: {
              status: GitHubInstallationStatus.ACTIVE,
              repositories: { some: { removedAt: null } },
            },
          },
          {
            pullRequestDetails: {
              some: { repositoryFullName: { not: null } },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 25,
    });
  });

  it("returns an empty array when no unbootstrapped orgs exist", async () => {
    const db = makeDb();
    db.organization.findMany.mockResolvedValue([]);
    wire(db);

    const ids = await selectUnbootstrappedOrgIds(25);

    expect(ids).toEqual([]);
  });
});
