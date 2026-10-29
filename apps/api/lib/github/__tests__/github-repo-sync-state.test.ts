import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  failOneRepoThroughFallback,
  type MockDb,
  makeDb,
  mockPrismaJoin,
  mockPrismaSql,
  tiersByRepoFrom,
} from "./github-repo-sync-doubles";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { sql: mockPrismaSql, join: mockPrismaJoin },
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

vi.mock("@repo/api/src/types/branch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/api/src/types/branch")>()),
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findCoveringInstallation: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubCapabilityTtlMs,
} from "@/lib/github/github-access";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import {
  classifyRepoSyncTier,
  GitHubRepoSyncTier,
  markOrgRepoSyncBootstrapAttempt,
  reconcileOrgRepoSyncStates,
  reconcileOrgRepoSyncStatesBestEffort,
  resolveRepoSyncTier,
  selectUnbootstrappedOrgIds,
} from "@/lib/github/github-repo-sync-state";
import { findCoveringInstallation } from "@/lib/github/installation-repository-lookup";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockFindCoveringInstallation =
  findCoveringInstallation as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-08-03T12:00:00.000Z");
const ORG = "org-1";

function wire(db: MockDb): void {
  mockWithDb.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindCoveringInstallation.mockResolvedValue(null);
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
    mockFindCoveringInstallation.mockResolvedValue({
      installationId: "install-77",
    });
    wire(db);

    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.Installed
    );
    expect(mockFindCoveringInstallation).toHaveBeenCalledWith(
      ORG,
      "acme/widgets"
    );
  });

  it("is tier-2 user_token when no installation covers it but a repo-scoped connection exists", async () => {
    const db = makeDb();
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

  // PLN-1742 M4: the row that un-strands tier-2 is the Clerk registry mirror —
  // token-less, carrying only Clerk's mirrored scope set. Nothing in the tier
  // pipeline may demand a stored credential, or tier-2 stays dark for exactly
  // the orgs Clerk serves.
  it("is tier-2 user_token for a token-less Clerk registry row", async () => {
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      {
        id: "conn-clerk",
        scopes: [GITHUB_REPO_SCOPE, "read:org"],
        capabilities: [],
      },
    ]);
    wire(db);

    expect(await classifyRepoSyncTier(input)).toBe(
      GitHubRepoSyncTier.UserToken
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

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result).toEqual({ repoCount: 2, failedRepoCount: 0, settled: true });
    // ISS-6579: both repos ride ONE statement. Asserting the round-trip count —
    // not just the tiers — is what keeps a future edit from quietly returning
    // to a per-repo upsert that still writes the right rows.
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.gitHubRepoSyncState.upsert).not.toHaveBeenCalled();
    const tiersByRepo = tiersByRepoFrom(db);
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

  it("makes a verified observation a tier-2 target candidate for an org with no installation and no PR rows", async () => {
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE], capabilities: [] },
    ]);
    db.gitHubObservedRepository.findMany.mockResolvedValue([
      { repositoryFullName: "acme/observed" },
    ]);
    wire(db);

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result).toEqual({ repoCount: 1, failedRepoCount: 0, settled: true });
    expect(tiersByRepoFrom(db).get("acme/observed")).toBe(
      GitHubRepoSyncTier.UserToken
    );
  });

  it("writes one row for a repo that arrives from both the projection and an observation", async () => {
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE], capabilities: [] },
    ]);
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/shared" },
    ]);
    db.gitHubObservedRepository.findMany.mockResolvedValue([
      { repositoryFullName: "ACME/Shared" },
    ]);
    wire(db);

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result.repoCount).toBe(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect([...tiersByRepoFrom(db).keys()]).toEqual(["acme/shared"]);
  });

  it("lets an installation still win tier-1 for a repo it also observed", async () => {
    const db = makeDb();
    db.gitHubInstallationRepository.findMany.mockResolvedValue([
      { fullName: "acme/covered" },
    ]);
    db.gitHubObservedRepository.findMany.mockResolvedValue([
      { repositoryFullName: "acme/covered" },
    ]);
    wire(db);

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result.repoCount).toBe(1);
    expect(tiersByRepoFrom(db).get("acme/covered")).toBe(
      GitHubRepoSyncTier.Installed
    );
  });

  it("classifies projection repos as unsyncable when no installation and no connection exist", async () => {
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/orphan" },
    ]);
    wire(db);

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result).toEqual({ repoCount: 1, failedRepoCount: 0, settled: true });
    expect(tiersByRepoFrom(db).get("acme/orphan")).toBe(
      GitHubRepoSyncTier.Unsyncable
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

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result).toEqual({ repoCount: 2, failedRepoCount: 0, settled: true });
    const tiersByRepo = tiersByRepoFrom(db);
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

  it("stamps the durable completion marker only after every repo row lands (ISS-6590)", async () => {
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/one" },
      { repositoryFullName: "acme/two" },
      { repositoryFullName: "acme/three" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(db.organization.updateMany).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { githubRepoSyncBootstrappedAt: NOW },
    });
    // The LAST statement, not the first: a marker stamped while a later chunk
    // was still in flight is the bug this guards.
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const lastUpsertOrder = Math.max(
      ...db.$executeRaw.mock.invocationCallOrder
    );
    const markOrder = db.organization.updateMany.mock
      .invocationCallOrder[0] as number;
    expect(markOrder).toBeGreaterThan(lastUpsertOrder);
  });

  it("withholds the completion marker when the pass derived zero candidate repos (ISS-6590)", async () => {
    // The org raced the selector's OR arms. Settling it here would hide it from
    // the cron for good if the lifecycle webhook that later gives it repos is
    // missed — the exact failure that made this cron necessary.
    const db = makeDb();
    wire(db);

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result).toEqual({
      repoCount: 0,
      failedRepoCount: 0,
      settled: false,
    });
    expect(db.organization.updateMany).not.toHaveBeenCalled();
  });

  it("asks for verdicts with two sargable IN lists, not one OR disjunct per repo (ISS-6577)", async () => {
    // An OR disjunct per repo makes Postgres re-evaluate the whole expression
    // against every scanned verdict row — quadratic in the org's repo count on
    // a path that runs on every connect/disconnect webhook — and spends 2 bind
    // parameters per repo against the 65,535 limit.
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE] },
    ]);
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/widgets" },
      { repositoryFullName: "otherorg/backend" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    const where = db.gitHubAccessCapability.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("OR");
    expect(where.normalizedTargetOwner).toEqual({ in: ["acme", "otherorg"] });
    expect(where.targetRepo).toEqual({ in: ["widgets", "backend"] });
  });

  it("discards the cross-product rows the IN lists over-select instead of letting them decide a tier", async () => {
    // Two IN lists match owner × repo, so asking about acme/widgets and
    // otherorg/backend also drags in acme/backend and otherorg/widgets. Those
    // pairs are not this org's repos here; if `groupDenialsByRepo` and
    // `verdictRepoKey` both dropped a segment from the composite key — keying
    // on owner alone, or on repo alone — either denial below would wrongly
    // demote a requested repo to unsyncable.
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE] },
    ]);
    const durableDenial = {
      githubUserConnectionId: "conn-1",
      credentialKind: GitHubCredentialKind.OauthUser,
      denialReason: GitHubAccessDenialReason.NoInstallation,
      checkedAt: NOW,
      expiresAt: new Date(NOW.getTime() + GITHUB_SYNC_REPO_VERDICT_TTL_MS),
    };
    db.gitHubAccessCapability.findMany.mockResolvedValue([
      {
        ...durableDenial,
        normalizedTargetOwner: "acme",
        targetRepo: "backend",
      },
      {
        ...durableDenial,
        normalizedTargetOwner: "otherorg",
        targetRepo: "widgets",
      },
    ]);
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/widgets" },
      { repositoryFullName: "otherorg/backend" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    const tiersByRepo = tiersByRepoFrom(db);
    expect(tiersByRepo.get("acme/widgets")).toBe(GitHubRepoSyncTier.UserToken);
    expect(tiersByRepo.get("otherorg/backend")).toBe(
      GitHubRepoSyncTier.UserToken
    );
  });

  it("does not let an over-segmented name borrow the denial rows of the repo its first two segments name (ISS-7548)", async () => {
    // A full name is normalized but never structurally validated, so
    // `acme/widgets/extra` reaches this sweep as its own repo key. Keying it on
    // its first two segments would hand it `acme/widgets`'s durable denial and
    // demote a different repository to unsyncable, so the shared parser rejects
    // it. It must not then fall through to `user_token` on the unmatched
    // verdict key either: `reconcileRepo` retires the same name to unsyncable,
    // and a batch that disagreed would resurrect it into `selectDueRepos` on
    // every lifecycle event. The neighbour it must not borrow from is asserted
    // alongside it, so a parser that truncated again would fail on both rows.
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
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/widgets" },
      { repositoryFullName: "acme/widgets/extra" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    const tiersByRepo = tiersByRepoFrom(db);
    expect(tiersByRepo.get("acme/widgets")).toBe(GitHubRepoSyncTier.Unsyncable);
    expect(tiersByRepo.get("acme/widgets/extra")).toBe(
      GitHubRepoSyncTier.Unsyncable
    );
  });

  it("retires a malformed name to the tier reconcileRepo writes, not the fail-open user_token (ISS-7548)", async () => {
    // The agreement is only load-bearing when coverage WOULD have said yes: a
    // repo-scoped connection with no denial row anywhere makes `coverage` fail
    // open for every key, so `acme/widgets` legitimately lands on user_token.
    // A malformed sibling under the identical signals must still land on
    // unsyncable, which is the tier `reconcileRepo` persists for it. Without
    // the parse gate this row reads user_token and the two writers alternate.
    const db = makeDb();
    db.gitHubUserConnection.findMany.mockResolvedValue([
      { id: "conn-1", scopes: [GITHUB_REPO_SCOPE] },
    ]);
    db.gitHubAccessCapability.findMany.mockResolvedValue([]);
    // No trailing-slash case: `normalizeRepoFullName` strips it upstream, so
    // `acme/widgets/` collides with `acme/widgets` in the dedupe set and never
    // reaches the parse gate as its own key.
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/widgets" },
      { repositoryFullName: "acme/widgets/extra" },
      { repositoryFullName: "badformat" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    const tiersByRepo = tiersByRepoFrom(db);
    expect(tiersByRepo.get("acme/widgets")).toBe(GitHubRepoSyncTier.UserToken);
    expect(tiersByRepo.get("acme/widgets/extra")).toBe(
      GitHubRepoSyncTier.Unsyncable
    );
    expect(tiersByRepo.get("badformat")).toBe(GitHubRepoSyncTier.Unsyncable);
  });
});

describe("markOrgRepoSyncBootstrapAttempt", () => {
  it("stamps the attempt timestamp through updateMany so a deleted org is a no-op (ISS-6590)", async () => {
    const db = makeDb();
    db.organization.updateMany.mockResolvedValue({ count: 0 });
    wire(db);

    await expect(
      markOrgRepoSyncBootstrapAttempt(ORG, NOW)
    ).resolves.toBeUndefined();

    expect(db.organization.updateMany).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { githubRepoSyncBootstrapAttemptedAt: NOW },
    });
  });
});

describe("selectUnbootstrappedOrgIds", () => {
  it("selects orgs with candidate repos and no completion marker, oldest attempt then newest org first (ISS-6590)", async () => {
    const db = makeDb();
    db.organization.findMany.mockResolvedValue([{ id: "org-1" }]);
    wire(db);

    const ids = await selectUnbootstrappedOrgIds(25);

    expect(ids).toEqual(["org-1"]);
    expect(db.organization.findMany).toHaveBeenCalledWith({
      where: {
        githubRepoSyncBootstrappedAt: null,
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
          {
            githubObservedRepositories: {
              some: {
                verificationState:
                  GitHubObservedRepositoryVerificationState.Verified,
                githubRepoId: { not: null },
              },
            },
            githubUserConnections: {
              some: { revokedAt: null, scopes: { has: GITHUB_REPO_SCOPE } },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: [
        { githubRepoSyncBootstrapAttemptedAt: { sort: "asc", nulls: "first" } },
        { createdAt: "desc" },
      ],
      take: 25,
    });
  });

  it("pairs the observation arm with a live repo-scoped connection", async () => {
    const db = makeDb();
    db.organization.findMany.mockResolvedValue([]);
    wire(db);

    await selectUnbootstrappedOrgIds(25);

    const where = db.organization.findMany.mock.calls[0]?.[0]?.where as {
      OR: Record<string, unknown>[];
    };
    const observationArm = where.OR.find((arm) =>
      Object.hasOwn(arm, "githubObservedRepositories")
    );
    expect(observationArm).toBeDefined();
    expect(observationArm?.githubUserConnections).toEqual({
      some: { revokedAt: null, scopes: { has: GITHUB_REPO_SCOPE } },
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

describe("reconcileOrgRepoSyncStatesBestEffort", () => {
  it("reports a partial failure on the lifecycle path instead of rejecting (ISS-6590)", async () => {
    // The pass used to reject on the first failed write, so this wrapper
    // reported the loss through its catch. It now resolves, so the wrapper has
    // to carry `failedRepoCount` on the info line instead — otherwise a
    // lifecycle event that wrote nothing looks identical to one that wrote
    // everything.
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/one" },
      { repositoryFullName: "acme/two" },
    ]);
    wire(db);
    failOneRepoThroughFallback(db, "acme/two");

    await expect(
      reconcileOrgRepoSyncStatesBestEffort(ORG)
    ).resolves.toBeUndefined();

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("reconciled org repo sync tiers"),
      { organizationId: ORG, repoCount: 2, failedRepoCount: 1, settled: false }
    );
  });

  it("swallows a throw so a webhook seam never sees an unhandled rejection", async () => {
    // The fan-out no longer rejects, but the reads around it still can, and
    // both call sites hand this to `waitUntil` with nothing to catch for them.
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockRejectedValue(new Error("pool down"));
    wire(db);

    await expect(
      reconcileOrgRepoSyncStatesBestEffort(ORG)
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to reconcile org repo sync tiers"),
      expect.objectContaining({ organizationId: ORG })
    );
    expect(log.info).not.toHaveBeenCalled();
  });
});
