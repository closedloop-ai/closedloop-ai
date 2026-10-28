import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { clerkClient } from "@repo/auth/server";

// This suite is the pool's write-back half; every case draws a USER token, so
// tier 1 must stay uncovered. Mocked rather than answered through the db stub
// because the lookup is raw SQL (ISS-6578) with nothing for a delegate double
// to intercept.
vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findCoveringInstallation: vi.fn().mockResolvedValue(null),
}));

import { withDb } from "@repo/database";
import {
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubSyncHealthState,
} from "@/lib/github/github-access";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import {
  GITHUB_SYNC_DEFAULT_BACKOFF_MS,
  GitHubSyncRepoAccessOutcome,
} from "@/lib/github/github-sync-pool-observations";
import {
  drawnLogin,
  FUTURE_RESET,
  makePoolDb,
  NOW,
  POOL_INPUT,
  poolConnectionFixture,
  type WithDbMock,
  wireClerkServedToken,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.useRealTimers();
});

// The write-back half of the pool, exercised through a drawn client (the
// production path): rate-limit window merges, backoff, 401 revocation, and
// lazy repo-access discovery. Selection and draw are covered by
// github-sync-client-pool.test.ts.
describe("sync pool observations (via the drawn client)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireClerkServedToken(mockClerkClient);
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

  it("keeps a successful repo-access observation drawable", async () => {
    const connection = poolConnectionFixture({ id: "a", login: "alice" });
    const db = makePoolDb([connection]);
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    await result.value.recordRepoAccess(GitHubSyncRepoAccessOutcome.Ok);

    const created = db.gitHubAccessCapability.create.mock.calls[0]?.[0] as {
      data: { credentialKind: string; denialReason: string | null };
    };
    expect(created.data.denialReason).toBeNull();

    connection.capabilities = [created.data];
    expect(
      drawnLogin(await getGitHubSyncClient(POOL_INPUT, { now: NOW }))
    ).toBe("alice");
  });

  it("backs a 401 off through the drawn client and names the user", async () => {
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

    // Revocation was a compare-and-set on the stored cipher, which the M5
    // tail removed — Clerk's token is not ours to revoke. The row is backed
    // off instead, so a broken credential stops being redrawn every sweep
    // without disabling a pool row we cannot repair.
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "a", organizationId: "org-1" }),
        data: expect.objectContaining({ backoffUntil: expect.any(Date) }),
      })
    );
    expect(db.gitHubAccessCapability.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a 500", 500],
    ["a 404", 404],
    ["a transport error", null],
  ])("does not back off the token for %s", async (_label, status) => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() => {
      if (status !== null) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "provider failure" }), {
            status,
            headers: { "content-type": "application/json" },
          })
        );
      }
      return Promise.reject(new TypeError("transport failure"));
    });

    const result = await getGitHubSyncClient(POOL_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    db.gitHubUserConnection.updateMany.mockClear();

    await expect(
      result.value.octokit.rest.repos.get({ owner: "Acme", repo: "widgets" })
    ).rejects.toBeDefined();
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
  });

  it("puts a rate-limited token into backoff via the client observer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
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
    expect(backoffUntil.getTime()).toBe(NOW.getTime() + 120_000);
  });

  it("uses the default backoff when GitHub omits retry-after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ message: "API rate limit exceeded for user" }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
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
    const backoffUntil: Date = backoffWrite?.[0]?.data?.backoffUntil;
    expect(backoffUntil.getTime()).toBe(
      NOW.getTime() + GITHUB_SYNC_DEFAULT_BACKOFF_MS
    );
  });

  it("counts spend without moving an unanchored rate-limit window", async () => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    db.gitHubUserConnection.updateMany.mockClear();

    await result.value.recordRateLimit({
      limit: 10_000,
      cost: 15,
      remaining: 9876,
      resetAt: null,
    });

    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledTimes(1);
    const write = db.gitHubUserConnection.updateMany.mock.calls[0]?.[0];
    expect(write).toMatchObject({
      where: { id: "a", organizationId: "org-1", revokedAt: null },
      data: {
        healthState: GitHubSyncHealthState.Healthy,
        backoffUntil: null,
        windowSpend: { increment: 15 },
      },
    });
    expect(write?.data?.observedLimit).toBeUndefined();
    expect(write?.data?.observedRemaining).toBeUndefined();
    expect(write?.data?.observedResetAt).toBeUndefined();
  });

  it("omits a null observed limit from an anchored window write", async () => {
    const db = makePoolDb([
      poolConnectionFixture({
        id: "a",
        login: "alice",
        observedResetAt: null,
      }),
    ]);
    wireDb(mockWithDb, db);
    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    db.gitHubUserConnection.updateMany.mockClear();

    await result.value.recordRateLimit({
      limit: null,
      cost: 25,
      remaining: 9975,
      resetAt: FUTURE_RESET.toISOString(),
    });

    const write = db.gitHubUserConnection.updateMany.mock.calls[0]?.[0];
    expect(write?.data).toHaveProperty("observedLimit", undefined);
    expect(write?.data).toMatchObject({
      observedRemaining: 9975,
      observedResetAt: FUTURE_RESET,
    });
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
