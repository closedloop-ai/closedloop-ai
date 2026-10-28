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

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { clerkClient } from "@repo/auth/server";
import { withDb } from "@repo/database";
import { GitHubSyncHealthState } from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";
import {
  APP_USER_CONNECTION,
  type GitHubAccessDbStub,
  makeResolverDb,
  NOW,
  type ResolverConnectionFixture,
  USER_TARGET_INPUT,
  type WithDbMock,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;

/** Answers both the registry's `GET /user` and the resolver's target probe. */
function githubFetch() {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: 4242, login: "octocat" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  );
}

function wireClerkToken(scopes: string[]) {
  const getUserOauthAccessToken = vi.fn().mockResolvedValue({
    data: [{ token: "gho_from_clerk", scopes, externalAccountId: "eac_1" }],
  });
  mockClerkClient.mockResolvedValue({ users: { getUserOauthAccessToken } });
  return getUserOauthAccessToken;
}

function wireClerkNoAccount() {
  const getUserOauthAccessToken = vi.fn().mockResolvedValue({ data: [] });
  mockClerkClient.mockResolvedValue({ users: { getUserOauthAccessToken } });
  return getUserOauthAccessToken;
}

function wireClerkFailure(status: number) {
  const getUserOauthAccessToken = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("clerk"), { status }));
  mockClerkClient.mockResolvedValue({ users: { getUserOauthAccessToken } });
  return getUserOauthAccessToken;
}

function makeClerkDb(
  connection: ResolverConnectionFixture | null
): GitHubAccessDbStub {
  const db = makeResolverDb(connection);
  db.gitHubUserConnection.create = vi
    .fn()
    .mockResolvedValue({ id: "connection-new", rateLimitTier: null });
  return db;
}

/**
 * A registry row for the SAME GitHub account `githubFetch` reports. The row's
 * identity is re-anchored to whatever account Clerk hands a token for, so a
 * fixture whose row disagrees is exercising the rebound path, not the
 * steady state.
 */
const CLERK_REGISTRY_CONNECTION: ResolverConnectionFixture = {
  ...APP_USER_CONNECTION,
  githubUserId: "4242",
};

// PLN-1742 M1/M5: Clerk as the primary credential source, unconditionally —
// the `github-clerk-credentials` rollout flag was retired in M5.
describe("getGitHubClient (Clerk credential source)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves an oauth_user client from Clerk", async () => {
    wireClerkToken(["repo", "read:org"]);
    const db = makeClerkDb({ ...CLERK_REGISTRY_CONNECTION });
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a resolved client");
    }
    // The whole point of the milestone: `oauth_user` becomes reachable, which
    // is what makes the resolver's scope floor live for the first time.
    expect(result.value.kind).toBe(GitHubCredentialKind.OauthUser);
    expect(result.value.actingAs).toEqual({
      githubUserId: "4242",
      login: "octocat",
    });
  });

  it("mirrors Clerk's scopes onto the registry row so tier-2 filters can match", async () => {
    wireClerkToken(["repo", "read:org"]);
    const db = makeClerkDb({ ...CLERK_REGISTRY_CONNECTION });
    wireDb(mockWithDb, db);

    await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        organizationId: "org-1",
        userId: "user-1",
      },
      data: { scopes: ["repo", "read:org"], lastUsedAt: NOW },
    });
  });

  it("re-anchors identity and drops stale verdicts when the linked account changes", async () => {
    // A user can relink a different GitHub account in Clerk under the same
    // Clerk id. Reporting the old account would attribute every read and every
    // comment write to an account that did not make it, and the old account's
    // capability verdicts describe access the new one may not have.
    wireClerkToken(["repo"]);
    const db = makeClerkDb({ ...APP_USER_CONNECTION, githubUserId: "9001" });
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(result.ok && result.value.actingAs).toEqual({
      githubUserId: "4242",
      login: "octocat",
    });
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        organizationId: "org-1",
        userId: "user-1",
      },
      data: {
        scopes: ["repo"],
        githubUserId: "4242",
        login: "octocat",
        normalizedLogin: "octocat",
        lastUsedAt: NOW,
      },
    });
    expect(db.gitHubAccessCapability.deleteMany).toHaveBeenCalledWith({
      where: {
        githubUserConnectionId: "connection-1",
        organizationId: "org-1",
      },
    });
  });

  it("skips the registry write inside the sample interval", async () => {
    wireClerkToken(["repo"]);
    const db = makeClerkDb({
      ...APP_USER_CONNECTION,
      lastUsedAt: new Date("2026-07-30T11:59:00.000Z"),
    });
    wireDb(mockWithDb, db);

    await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
  });

  it("creates a token-less registry row from GitHub identity on first use", async () => {
    wireClerkToken(["repo"]);
    const db = makeClerkDb(null);
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(result.ok).toBe(true);
    expect(db.gitHubUserConnection.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        userId: "user-1",
        githubUserId: "4242",
        login: "octocat",
        normalizedLogin: "octocat",
        scopes: ["repo"],
        lastUsedAt: NOW,
      },
      select: { id: true, rateLimitTier: true },
    });
  });

  it("reports not_connected when the user has no Clerk-linked account", async () => {
    // There is no stored credential to fall through to since the M5 tail, so
    // Clerk's answer IS the answer: connect GitHub.
    wireClerkNoAccount();
    const db = makeClerkDb({ ...APP_USER_CONNECTION });
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NotConnected },
    });
  });

  it("reports unavailable — not not_connected — when Clerk is down", async () => {
    // The distinction is the whole reason the denial vocabulary is the wire
    // one now: an outage must not read as "you never linked GitHub", which is
    // what the stored fallback used to flatten it into.
    wireClerkFailure(503);
    const db = makeClerkDb({ ...APP_USER_CONNECTION });
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });
  });

  it("reports insufficient_scope for a grant without repo", async () => {
    wireClerkToken(["read:user"]);
    const db = makeClerkDb({ ...APP_USER_CONNECTION });
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.InsufficientScope },
    });
  });

  it("retires the registry row when Clerk reports the link is gone", async () => {
    // `revokedAt` is what the integration status card, insights provenance and
    // the pool's Unhealthy exclusion all read. Without this write the row
    // outlives the grant and every one of them keeps claiming a connection.
    wireClerkNoAccount();
    const db = makeClerkDb({ ...APP_USER_CONNECTION });
    wireDb(mockWithDb, db);

    await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    // The lastUsedAt clause is the compare-and-set the old 401 hook got from
    // its guard on the stored cipher: a row used since this resolution began
    // belongs to a link that came back while the denial was in flight.
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        organizationId: "org-1",
        revokedAt: null,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: NOW } }],
      },
      data: {
        revokedAt: NOW,
        healthState: GitHubSyncHealthState.Unhealthy,
      },
    });
    expect(db.gitHubAccessCapability.deleteMany).toHaveBeenCalledWith({
      where: {
        githubUserConnectionId: "connection-1",
        organizationId: "org-1",
      },
    });
  });

  it("clears the retirement on the next resolution Clerk can serve", async () => {
    // Relink has to be self-healing: the sampled registry write is the only
    // thing that runs on a successful resolution, so it is what must undo the
    // marker — otherwise a reconnected user stays reported as revoked.
    wireClerkToken(["repo"]);
    const db = makeClerkDb({
      ...CLERK_REGISTRY_CONNECTION,
      revokedAt: new Date("2026-07-29T12:00:00.000Z"),
      lastUsedAt: NOW,
    });
    wireDb(mockWithDb, db);

    await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revokedAt: null,
          healthState: GitHubSyncHealthState.Healthy,
        }),
      })
    );
  });

  it("keeps the verdicts when the retirement loses to a concurrent relink", async () => {
    // CAS lost: another resolution refreshed the row between this denial and
    // this write. Deleting the capability rows anyway would punish the link
    // that came back — the delete must ride on the same guarded update.
    wireClerkNoAccount();
    const db = makeClerkDb({ ...APP_USER_CONNECTION });
    db.gitHubUserConnection.updateMany = vi
      .fn()
      .mockResolvedValue({ count: 0 });
    wireDb(mockWithDb, db);

    await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalled();
    expect(db.gitHubAccessCapability.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves the registry row alone when Clerk is merely unreachable", async () => {
    // An outage is not evidence the user unlinked. Marking here would carve a
    // transient failure into a persistent reconnect prompt for the whole org.
    wireClerkFailure(503);
    const db = makeClerkDb({ ...APP_USER_CONNECTION });
    wireDb(mockWithDb, db);

    await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: githubFetch(),
    });

    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
    expect(db.gitHubAccessCapability.deleteMany).not.toHaveBeenCalled();
  });
});
