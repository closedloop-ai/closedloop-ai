import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn() },
}));

const { mockGetAuthenticated, mockGetUserTokenOctokit } = vi.hoisted(() => {
  const getAuthenticated = vi.fn();
  return {
    mockGetAuthenticated: getAuthenticated,
    mockGetUserTokenOctokit: vi.fn(() => ({
      rest: { users: { getAuthenticated } },
    })),
  };
});

vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: mockGetUserTokenOctokit,
}));

// PLN-1742 M5 tail: Clerk is the ONLY user-credential source, so every case
// wires the Clerk answer it means to exercise.
vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

import { clerkClient } from "@repo/auth/server";
import { withDb } from "@repo/database";
import {
  resolveGitHubUserCredential,
  resolveGitHubUserIdentity,
} from "@/lib/github/github-user-credential";

/**
 * `resolveGitHubUserIdentity` is the token-free twin of
 * `resolveGitHubUserCredential`: the Clerk link flow (`clerk-link-service.ts`)
 * asks it which GitHub account a user holds without spending the credential.
 * Its callers mock it, so these cases drive its real body, and each denial is
 * checked against the credential path on the same wiring so the two answers
 * cannot drift apart.
 */

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-05-20T12:00:00.000Z");

const REGISTRY_ROW = {
  id: "connection-1",
  githubUserId: "123",
  login: "octocat",
  rateLimitTier: null,
  lastUsedAt: NOW,
  capabilities: [],
};

const INPUT = { organizationId: "org-1", userId: "user-1", now: NOW };

/**
 * The registry read/write the Clerk lane performs on its own `withDb`, and
 * the user row its Clerk id comes from.
 */
function wireDb(connection: typeof REGISTRY_ROW | null = REGISTRY_ROW) {
  const db = {
    user: { findUnique: vi.fn().mockResolvedValue({ clerkId: "c_1" }) },
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue(connection),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi
        .fn()
        .mockResolvedValue({ id: "connection-1", rateLimitTier: null }),
    },
    gitHubAccessCapability: { deleteMany: vi.fn().mockResolvedValue({}) },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  mockWithDb.tx = vi.fn((fn: (client: unknown) => unknown) => fn(db));
  return db;
}

function wireClerkToken(scopes: string[] = ["repo"]) {
  mockClerkClient.mockResolvedValue({
    users: {
      getUserOauthAccessToken: vi.fn().mockResolvedValue({
        data: [{ token: "clerk-token", scopes, externalAccountId: "ea-1" }],
      }),
    },
  });
}

function wireClerkNoAccount() {
  mockClerkClient.mockResolvedValue({
    users: { getUserOauthAccessToken: vi.fn().mockResolvedValue({ data: [] }) },
  });
}

function wireClerkOutage() {
  mockClerkClient.mockResolvedValue({
    users: {
      getUserOauthAccessToken: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("clerk"), { status: 503 })),
    },
  });
}

describe("resolveGitHubUserIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthenticated.mockResolvedValue({
      data: { id: 123, login: "octocat" },
    });
  });

  it("returns the registry identity for a caller Clerk can serve", async () => {
    wireDb();
    wireClerkToken();

    await expect(resolveGitHubUserIdentity(INPUT)).resolves.toEqual({
      ok: true,
      identity: { githubUserId: "123", login: "octocat" },
    });
  });

  it.each([
    ["no linked account", wireClerkNoAccount],
    ["a grant without repo", () => wireClerkToken(["read:user"])],
  ])(
    "returns the same denial the credential path returns for %s",
    async (_name, wireClerk) => {
      wireDb();
      wireClerk();
      const identity = await resolveGitHubUserIdentity(INPUT);
      wireDb();
      wireClerk();
      const credential = await resolveGitHubUserCredential(INPUT);

      expect(identity.ok).toBe(false);
      expect(credential.ok).toBe(false);
      if (identity.ok || credential.ok) {
        return;
      }
      expect(identity.denial).not.toBe(GitHubAccessDenialReason.Unavailable);
      expect(identity.denial).toBe(credential.denial);
    }
  );

  it("answers a Clerk outage as unavailable without building a token client", async () => {
    wireDb();
    wireClerkOutage();

    await expect(resolveGitHubUserIdentity(INPUT)).resolves.toEqual({
      ok: false,
      denial: GitHubAccessDenialReason.Unavailable,
    });
    expect(mockGetUserTokenOctokit).not.toHaveBeenCalled();
  });

  it("answers unavailable when GitHub will not confirm whose token it is", async () => {
    wireDb(null);
    wireClerkToken();
    mockGetAuthenticated.mockRejectedValue(
      Object.assign(new Error("github"), { status: 502 })
    );

    await expect(resolveGitHubUserIdentity(INPUT)).resolves.toEqual({
      ok: false,
      denial: GitHubAccessDenialReason.Unavailable,
    });
  });
});
