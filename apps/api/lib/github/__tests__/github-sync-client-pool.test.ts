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

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const poolObservationMocks = vi.hoisted(() => ({
  observePoolRequestFailure: vi.fn(),
}));

vi.mock(
  "@/lib/github/github-sync-pool-observations",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/lib/github/github-sync-pool-observations")
      >();
    return {
      ...original,
      observePoolRequestFailure: poolObservationMocks.observePoolRequestFailure,
    };
  }
);

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findCoveringInstallation: vi.fn(),
}));

import { clerkClient } from "@repo/auth/server";
import { withDb } from "@repo/database";
import { GitHubSyncHealthState } from "@/lib/github/github-access";
import {
  GITHUB_SYNC_WINDOW_SPEND_CAP,
  getGitHubSyncClient,
} from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import { findCoveringInstallation } from "@/lib/github/installation-repository-lookup";
import {
  drawnLogin,
  makePoolDb,
  mockGetInstallationOctokit,
  NOW,
  POOL_INPUT,
  poolConnectionFixture,
  type WithDbMock,
  wireClerkServedToken,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;
const mockFindCoveringInstallation =
  findCoveringInstallation as unknown as ReturnType<typeof vi.fn>;

// Selection and draw: tier-1 installation short-circuit, pool qualification,
// ordering, and the CAS draw claim. The write-back half (rate-limit windows,
// backoff, 401 revocation, lazy access discovery) is covered by
// github-sync-pool-observations.test.ts.
describe("getGitHubSyncClient (selection and draw)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCoveringInstallation.mockResolvedValue(null);
    wireClerkServedToken(mockClerkClient);
  });

  it("uses the org installation when it covers the target repo (tier 1)", async () => {
    const db = makePoolDb([]);
    mockFindCoveringInstallation.mockResolvedValue({
      installationId: "install-77",
    });
    wireDb(mockWithDb, db);
    const octokit = { rest: {} };
    mockGetInstallationOctokit.mockResolvedValue(octokit);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe(GitHubCredentialKind.Installation);
      expect(result.value.actingAs).toEqual({ installationId: "install-77" });
      // ISS-6578: the tier-1 probe is the index-servable lookup, given the
      // target's `owner/repo` verbatim for the reader to normalize.
      expect(mockFindCoveringInstallation).toHaveBeenCalledWith(
        "org-1",
        "Acme/Widgets"
      );
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
    mockFindCoveringInstallation.mockResolvedValue({
      installationId: "install-77",
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

  it("denies with contention, never not_connected, when every claim is lost (ISS-8270)", async () => {
    const db = makePoolDb([
      poolConnectionFixture({
        id: "a",
        login: "alice",
        lastUsedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
    ]);
    db.gitHubUserConnection.updateMany.mockResolvedValue({ count: 0 });
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    // The credential was served — only the LRU claim was lost — so the one
    // reason that would re-tier the repo is the one reason this cannot be.
    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Contention },
    });
  });

  it("gives concurrent draws on a one-connection pool one winner and contention losers (ISS-8270)", async () => {
    const db = makePoolDb([
      poolConnectionFixture({
        id: "a",
        login: "alice",
        lastUsedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
    ]);
    // The CAS these sweeps race: the first claim moves `lastUsedAt`, so every
    // later claim against the same snapshot matches zero rows.
    let claims = 0;
    db.gitHubUserConnection.updateMany.mockImplementation(() => {
      claims += 1;
      return Promise.resolve({ count: claims === 1 ? 1 : 0 });
    });
    wireDb(mockWithDb, db);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        getGitHubSyncClient(POOL_INPUT, { now: NOW })
      )
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .map((result) => (result.ok ? null : result.error.reason))
    ).toEqual([
      GitHubAccessDenialReason.Contention,
      GitHubAccessDenialReason.Contention,
      GitHubAccessDenialReason.Contention,
      GitHubAccessDenialReason.Contention,
    ]);
  });

  it("prefers contention over a peer candidate's Clerk outage (ISS-8270)", async () => {
    const served = wireClerkServedToken(mockClerkClient);
    served.mockRejectedValueOnce(new Error("clerk down"));
    const db = makePoolDb([
      poolConnectionFixture({
        id: "a",
        login: "alice",
        lastUsedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      poolConnectionFixture({
        id: "b",
        login: "bob",
        lastUsedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
    ]);
    db.gitHubUserConnection.updateMany.mockResolvedValue({ count: 0 });
    wireDb(mockWithDb, db);

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    // Alice's owner could not be served; Bob's could, and a peer sweep took
    // him. A live credential exists, so the answer is timing, not an outage.
    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Contention },
    });
  });

  it("preserves the provider error when failure bookkeeping rejects", async () => {
    const db = makePoolDb([poolConnectionFixture({ id: "a", login: "alice" })]);
    wireDb(mockWithDb, db);
    poolObservationMocks.observePoolRequestFailure.mockRejectedValueOnce(
      new Error("bookkeeping failed")
    );
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "provider failed" }), {
          status: 500,
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

    await expect(
      result.value.octokit.rest.repos.get({ owner: "Acme", repo: "widgets" })
    ).rejects.toMatchObject({ status: 500 });
    expect(
      poolObservationMocks.observePoolRequestFailure
    ).toHaveBeenCalledTimes(1);
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
});

// PLN-1742: TOKEN ACQUISITION is Clerk's alone since the M5 tail removed the
// stored fallback. Candidate selection, ranking, the CAS draw claim and the
// budget policy are untouched by where the bytes come from.
describe("getGitHubSyncClient (Clerk token acquisition)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({ user: { findUnique: vi.fn().mockResolvedValue({ clerkId: "c" }) } })
    );
  });

  function wireClerk(answer: { data: unknown[] }) {
    mockClerkClient.mockResolvedValue({
      users: {
        getUserOauthAccessToken: vi.fn().mockResolvedValue(answer),
      },
    });
  }

  it("draws a registry row once Clerk can serve its owner", async () => {
    // The row the in-house OAuth flow never wrote. Before the Clerk source it
    // had no token to decrypt and could never be drawn; that is precisely the
    // pool starvation the Clerk source removes.
    const registryOnly = poolConnectionFixture({
      id: "a",
      login: "alice",
      scopes: ["repo"],
    });
    const db = makePoolDb([registryOnly]);
    db.user = {
      findUnique: vi.fn().mockResolvedValue({ clerkId: "c" }),
    };
    wireDb(mockWithDb, db);
    wireClerk({
      data: [{ token: "gho", scopes: ["repo"], externalAccountId: "eac" }],
    });

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(drawnLogin(result)).toBe("alice");
    // The draw claim is unchanged — still CAS'd on the ranked LRU snapshot.
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "a", organizationId: "org-1", lastUsedAt: null },
      data: { lastUsedAt: NOW },
    });
  });

  it("reports not_connected when Clerk can serve none of the candidates", async () => {
    // Rows exist, so this is not an empty pool — but none of them can produce
    // a token, and telling the caller "revoked" would send them to reconnect
    // a credential we never held.
    const db = makePoolDb([
      poolConnectionFixture({ id: "a", login: "alice" }),
      poolConnectionFixture({ id: "b", login: "bob" }),
    ]);
    wireDb(mockWithDb, db);
    wireClerk({ data: [] });

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NotConnected },
    });
  });

  it("reports unavailable — not not_connected — when Clerk is down for every candidate", async () => {
    // The reconcile cron backs off on `unavailable` but RE-TIERS the repo on
    // `not_connected`, so collapsing a Clerk outage into the durable reason
    // demotes every repo in the org over a transient 503.
    const db = makePoolDb([
      poolConnectionFixture({ id: "a", login: "alice" }),
      poolConnectionFixture({ id: "b", login: "bob" }),
    ]);
    wireDb(mockWithDb, db);
    mockClerkClient.mockResolvedValue({
      users: {
        getUserOauthAccessToken: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("clerk"), { status: 503 })
          ),
      },
    });

    const result = await getGitHubSyncClient(POOL_INPUT, { now: NOW });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });
  });
});
