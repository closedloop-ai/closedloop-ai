import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
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
import {
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubSyncHealthState,
} from "@/lib/github/github-access";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import {
  FUTURE_RESET,
  makePoolDb,
  mockDecrypt,
  NOW,
  POOL_INPUT,
  poolConnectionFixture,
  type WithDbMock,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;

// The write-back half of the pool, exercised through a drawn client (the
// production path): rate-limit window merges, backoff, 401 revocation, and
// lazy repo-access discovery. Selection and draw are covered by
// github-sync-client-pool.test.ts.
describe("sync pool observations (via the drawn client)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockImplementation((encrypted: string) =>
      Promise.resolve(encrypted.replace("encrypted-", "token-"))
    );
  });

  it("learns repo access lazily with the sync verdict TTL", async () => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    await result.value.recordRepoAccess(GitHubSyncRepoAccessOutcome.NoAccess);

    expect(db.gitHubAccessCapability.create).toHaveBeenCalledTimes(1);
    const created = db.gitHubAccessCapability.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(created.data).toMatchObject({
      githubUserConnectionId: "a",
      normalizedTargetOwner: "acme",
      targetRepo: "widgets",
      denialReason: GitHubAccessDenialReason.NoInstallation,
    });
    const expiresAt = created.data.expiresAt as Date;
    const checkedAt = created.data.checkedAt as Date;
    expect(expiresAt.getTime() - checkedAt.getTime()).toBe(
      GITHUB_SYNC_REPO_VERDICT_TTL_MS
    );
  });

  it("marks a 401 through the drawn client unhealthy and names the user", async () => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const result = await getGitHubSyncClient(POOL_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The reconnect prompt needs to name whose token died.
    expect(result.value.actingAs).toEqual({
      githubUserId: "gh-a",
      login: "alice",
    });

    await expect(
      result.value.octokit.rest.repos.get({ owner: "Acme", repo: "widgets" })
    ).rejects.toMatchObject({ status: 401 });

    expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "a",
        organizationId: "org-1",
        revokedAt: null,
        accessTokenEncrypted: "encrypted-a",
      },
      data: {
        revokedAt: expect.any(Date),
        healthState: GitHubSyncHealthState.Unhealthy,
      },
    });
    expect(db.gitHubAccessCapability.deleteMany).toHaveBeenCalledWith({
      where: { githubUserConnectionId: "a", organizationId: "org-1" },
    });
  });

  it("puts a rate-limited token into backoff via the client observer", async () => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ message: "API rate limit exceeded for user" }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "retry-after": "120",
            },
          }
        )
      )
    );

    const result = await getGitHubSyncClient(POOL_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    await expect(
      result.value.octokit.rest.repos.get({ owner: "Acme", repo: "widgets" })
    ).rejects.toMatchObject({ status: 403 });

    const backoffWrite = db.gitHubUserConnection.updateMany.mock.calls.find(
      (call) => call[0]?.data?.healthState === GitHubSyncHealthState.Backoff
    );
    expect(backoffWrite?.[0]).toMatchObject({
      where: { id: "a", revokedAt: null },
      data: {
        healthState: GitHubSyncHealthState.Backoff,
        backoffUntil: expect.any(Date),
      },
    });
    const backoffUntil: Date = backoffWrite?.[0]?.data?.backoffUntil;
    expect(backoffUntil.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("accumulates same-window spend monotonically and resets on a new window", async () => {
    const db = makePoolDb([
      poolConnectionFixture({ id: "a", login: "alice", windowSpend: 100 }),
    ]);
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // Same window, in-order: the advance guard misses, the monotonic merge
    // (stored remaining above incoming) lands remaining + spend increment.
    db.gitHubUserConnection.updateMany.mockResolvedValueOnce({ count: 0 });
    await result.value.recordRateLimit({
      limit: 10_000,
      cost: 40,
      remaining: 8000,
      resetAt: FUTURE_RESET.toISOString(),
    });
    const mergeWrite = db.gitHubUserConnection.updateMany.mock.calls.at(-1);
    expect(mergeWrite?.[0]).toMatchObject({
      where: {
        id: "a",
        organizationId: "org-1",
        revokedAt: null,
        observedResetAt: FUTURE_RESET,
        observedRemaining: { gt: 8000 },
      },
      data: {
        observedRemaining: 8000,
        windowSpend: { increment: 40 },
        healthState: GitHubSyncHealthState.Healthy,
        backoffUntil: null,
      },
    });

    // New window: the advance guard matches and replaces the spend outright.
    await result.value.recordRateLimit({
      limit: 10_000,
      cost: 25,
      remaining: 9975,
      resetAt: new Date("2026-07-30T13:40:00.000Z").toISOString(),
    });
    const resetWrite = db.gitHubUserConnection.updateMany.mock.calls.at(-1);
    expect(resetWrite?.[0]).toMatchObject({
      data: { windowSpend: 25, observedRemaining: 9975 },
    });
    expect(resetWrite?.[0]?.where).toMatchObject({
      OR: [
        { observedResetAt: null },
        { observedResetAt: { lt: new Date("2026-07-30T13:40:00.000Z") } },
      ],
    });
  });

  it("counts an out-of-order same-window response's spend without raising remaining", async () => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    db.gitHubUserConnection.updateMany.mockClear();

    // Advance guard misses (same window), monotonic merge misses (stored
    // remaining is already lower) — only the spend-count write lands, with
    // no remaining/resetAt movement.
    db.gitHubUserConnection.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await result.value.recordRateLimit({
      limit: 10_000,
      cost: 15,
      remaining: 9500,
      resetAt: FUTURE_RESET.toISOString(),
    });

    const spendWrite = db.gitHubUserConnection.updateMany.mock.calls.at(-1);
    expect(spendWrite?.[0]).toMatchObject({
      where: { observedResetAt: FUTURE_RESET },
      data: { windowSpend: { increment: 15 } },
    });
    expect(spendWrite?.[0]?.data?.observedRemaining).toBeUndefined();
    expect(spendWrite?.[0]?.data?.observedResetAt).toBeUndefined();
  });

  it("drops a late response from an older window entirely", async () => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    db.gitHubUserConnection.updateMany.mockClear();
    db.gitHubUserConnection.updateMany.mockResolvedValue({ count: 0 });

    const olderReset = new Date("2026-07-30T11:40:00.000Z").toISOString();
    await result.value.recordRateLimit({
      limit: 10_000,
      cost: 15,
      remaining: 9900,
      resetAt: olderReset,
    });

    // Every attempted write was window-guarded — an older window can match
    // none of them, so nothing is rewound.
    for (const call of db.gitHubUserConnection.updateMany.mock.calls) {
      const where = call[0]?.where ?? {};
      expect("OR" in where || "observedResetAt" in where).toBe(true);
    }
  });
});
