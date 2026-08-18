import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
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

vi.mock("@/lib/integration-encryption", () => ({
  decryptIntegrationToken: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { withDb } from "@repo/database";
import { GitHubSyncHealthState } from "@/lib/github/github-access";
import {
  GITHUB_SYNC_WINDOW_SPEND_CAP,
  getGitHubSyncClient,
} from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import {
  drawnLogin,
  makePoolDb,
  mockDecrypt,
  mockGetInstallationOctokit,
  NOW,
  POOL_INPUT,
  poolConnectionFixture,
  type WithDbMock,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;

// Selection and draw: tier-1 installation short-circuit, pool qualification,
// ordering, and the CAS draw claim. The write-back half (rate-limit windows,
// backoff, 401 revocation, lazy access discovery) is covered by
// github-sync-pool-observations.test.ts.
describe("getGitHubSyncClient (selection and draw)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockImplementation((encrypted: string) =>
      Promise.resolve(encrypted.replace("encrypted-", "token-"))
    );
  });

  it("uses the org installation when it covers the target repo (tier 1)", async () => {
    const db = makePoolDb([]);
    db.gitHubInstallation.findUnique.mockResolvedValue({
      installationId: "install-77",
      status: "ACTIVE",
      repositories: [{ id: "repo-row" }],
    });
    wireDb(mockWithDb, db);
    const octokit = { rest: {} };
    mockGetInstallationOctokit.mockResolvedValue(octokit);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe(GitHubCredentialKind.Installation);
      expect(result.value.actingAs).toEqual({ installationId: "install-77" });
      // Pool state is a property of user tokens — installation-lane
      // observations are deliberate no-ops.
      await result.value.recordRateLimit({
        cost: 5,
        remaining: 4000,
        resetAt: null,
      });
      await result.value.recordRepoAccess(GitHubSyncRepoAccessOutcome.Ok);
      // ISS-5093 made NoAccess reachable on this lane (the reconciler now
      // records it on a repo-level denial), so pin that it stays a no-op too.
      // Installation reach is governed by the installation's repository list,
      // not by per-credential verdicts — writing one here would invent a
      // verdict against a credential no user owns.
      await result.value.recordRepoAccess(GitHubSyncRepoAccessOutcome.NoAccess);
    }
    expect(db.gitHubUserConnection.findMany).not.toHaveBeenCalled();
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
    expect(db.gitHubAccessCapability.create).not.toHaveBeenCalled();
    expect(db.gitHubAccessCapability.updateMany).not.toHaveBeenCalled();
  });

  it("classifies tier-1 installation-token acquisition failures", async () => {
    const db = makePoolDb([]);
    db.gitHubInstallation.findUnique.mockResolvedValue({
      installationId: "install-77",
      status: "ACTIVE",
      repositories: [{ id: "repo-row" }],
    });
    wireDb(mockWithDb, db);
    mockGetInstallationOctokit.mockRejectedValue(
      Object.assign(new Error("bad gateway"), { status: 502 })
    );

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });
    // A covering installation's outage is a definitive transient denial —
    // it must not demote to the user-token pool.
    expect(db.gitHubUserConnection.findMany).not.toHaveBeenCalled();
  });

  it("returns not_connected when the org has no pool at all", async () => {
    wireDb(mockWithDb, makePoolDb([]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NotConnected },
    });
  });

  it("rotates via least-recently-used-by-us and stamps the draw", async () => {
    const older = poolConnectionFixture({
      id: "a",
      login: "alice",
      lastUsedAt: new Date("2026-07-30T10:00:00.000Z"),
    });
    const newer = poolConnectionFixture({
      id: "b",
      login: "bob",
      lastUsedAt: new Date("2026-07-30T11:30:00.000Z"),
    });
    const db = makePoolDb([newer, older]);
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("alice");
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "a",
        organizationId: "org-1",
        lastUsedAt: new Date("2026-07-30T10:00:00.000Z"),
      },
      data: { lastUsedAt: NOW },
    });

    // After alice's draw is stamped, the same tick draws bob next.
    older.lastUsedAt = NOW;
    const second = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(drawnLogin(second)).toBe("bob");
  });

  it("prefers a token with known access to the repo over fresher budgets", async () => {
    const known = poolConnectionFixture({
      id: "a",
      login: "alice",
      observedRemaining: 6000,
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          denialReason: null,
        },
      ],
    });
    const fresher = poolConnectionFixture({
      id: "b",
      login: "bob",
      observedRemaining: 10_000,
    });
    wireDb(mockWithDb, makePoolDb([fresher, known]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("alice");
  });

  it("never draws a token below its reserve floor", async () => {
    const floored = poolConnectionFixture({
      id: "a",
      login: "alice",
      observedLimit: 10_000,
      observedRemaining: 4999,
    });
    const healthy = poolConnectionFixture({
      id: "b",
      login: "bob",
      observedLimit: 10_000,
      observedRemaining: 5001,
    });
    wireDb(mockWithDb, makePoolDb([floored, healthy]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("bob");
  });

  it("defers on budget when every pool token is floored or backed off", async () => {
    const floored = poolConnectionFixture({
      id: "a",
      login: "alice",
      observedRemaining: 100,
    });
    const backedOff = poolConnectionFixture({
      id: "b",
      login: "bob",
      backoffUntil: new Date("2026-07-30T12:10:00.000Z"),
    });
    const overspent = poolConnectionFixture({
      id: "c",
      login: "carol",
      windowSpend: GITHUB_SYNC_WINDOW_SPEND_CAP,
    });
    const db = makePoolDb([floored, backedOff, overspent]);
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.BudgetDeferred },
    });
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
  });

  it("requalifies a floored token once its observed window has reset", async () => {
    const staleObservation = poolConnectionFixture({
      id: "a",
      login: "alice",
      observedRemaining: 10,
      windowSpend: GITHUB_SYNC_WINDOW_SPEND_CAP + 500,
      observedResetAt: new Date("2026-07-30T11:59:00.000Z"),
    });
    wireDb(mockWithDb, makePoolDb([staleObservation]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("alice");
  });

  it("excludes tokens with an unexpired no-access verdict for the repo", async () => {
    const noAccess = poolConnectionFixture({
      id: "a",
      login: "alice",
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          denialReason: GitHubAccessDenialReason.NoInstallation,
        },
      ],
    });
    const reaches = poolConnectionFixture({ id: "b", login: "bob" });
    wireDb(mockWithDb, makePoolDb([noAccess, reaches]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("bob");
  });

  it("reports no_installation when every token is known to lack access", async () => {
    const noAccess = poolConnectionFixture({
      id: "a",
      login: "alice",
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          denialReason: GitHubAccessDenialReason.NoInstallation,
        },
      ],
    });
    wireDb(mockWithDb, makePoolDb([noAccess]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NoInstallation },
    });
  });

  it("reports insufficient_scope for a pool of scope-deficient OAuth tokens", async () => {
    // Non-empty scopes missing `repo` = the OAuth family needing a
    // scope-widening reconnect — NOT a revoked connection.
    const scopeShort = poolConnectionFixture({
      id: "a",
      login: "alice",
      scopes: ["read:user", "user:email"],
    });
    wireDb(mockWithDb, makePoolDb([scopeShort]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.InsufficientScope },
    });
  });

  it("reports revoked when the whole pool is unhealthy", async () => {
    const unhealthy = poolConnectionFixture({
      id: "a",
      login: "alice",
      healthState: GitHubSyncHealthState.Unhealthy,
    });
    wireDb(mockWithDb, makePoolDb([unhealthy]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Revoked },
    });
  });

  it("reports revoked when the pool holds only revoked connections", async () => {
    const revoked = poolConnectionFixture({
      id: "a",
      login: "alice",
      revokedAt: new Date("2026-07-30T09:00:00.000Z"),
    });
    wireDb(mockWithDb, makePoolDb([revoked]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Revoked },
    });
  });

  it("retries the next candidate when a concurrent sweep wins the draw claim", async () => {
    const first = poolConnectionFixture({
      id: "a",
      login: "alice",
      lastUsedAt: new Date("2026-07-30T10:00:00.000Z"),
    });
    const second = poolConnectionFixture({
      id: "b",
      login: "bob",
      lastUsedAt: new Date("2026-07-30T11:00:00.000Z"),
    });
    const db = makePoolDb([first, second]);
    // Alice's CAS claim loses (count 0) — another sweep drew her; Bob's wins.
    db.gitHubUserConnection.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("bob");
  });

  it("ignores verdict rows earned by the other credential family", async () => {
    // A stale OAuth-family denial must not exclude the connection now that
    // its stored scopes derive the App family.
    const flipped = poolConnectionFixture({
      id: "a",
      login: "alice",
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.OauthUser,
          denialReason: GitHubAccessDenialReason.NoInstallation,
        },
      ],
    });
    wireDb(mockWithDb, makePoolDb([flipped]));

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("alice");
  });

  it("skips an undecryptable token and draws the next candidate", async () => {
    const broken = poolConnectionFixture({
      id: "a",
      login: "alice",
      lastUsedAt: null,
    });
    const working = poolConnectionFixture({
      id: "b",
      login: "bob",
      lastUsedAt: new Date("2026-07-30T11:00:00.000Z"),
    });
    wireDb(mockWithDb, makePoolDb([broken, working]));
    mockDecrypt.mockImplementation((encrypted: string) => {
      if (encrypted === "encrypted-a") {
        return Promise.reject(new Error("kms denied"));
      }
      return Promise.resolve("token-b");
    });

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("bob");
  });
});
