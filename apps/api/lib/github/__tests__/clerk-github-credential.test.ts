import { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { clerkClient } from "@repo/auth/server";
import { withDb } from "@repo/database";
import { resolveClerkGitHubCredential } from "@/lib/github/clerk-github-credential";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
const mockClerkClient = clerkClient as unknown as ReturnType<typeof vi.fn>;

const ORGANIZATION_ID = "org-1";

/** A distinct user per case: the single-flight map is keyed on (org, user). */
let userSeq = 0;
function nextInput() {
  userSeq += 1;
  return { organizationId: ORGANIZATION_ID, userId: `user-${userSeq}` };
}

function wireClerkTokens(getUserOauthAccessToken: ReturnType<typeof vi.fn>) {
  mockClerkClient.mockResolvedValue({
    users: { getUserOauthAccessToken },
  });
  return getUserOauthAccessToken;
}

function wireUser(clerkId: string | null) {
  const findUnique = vi
    .fn()
    .mockResolvedValue(clerkId === null ? null : { clerkId });
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ user: { findUnique } })
  );
  return findUnique;
}

describe("resolveClerkGitHubCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireUser("clerk_user_1");
  });

  it("returns the first Clerk token when the grant carries repo", async () => {
    wireClerkTokens(
      vi.fn().mockResolvedValue({
        data: [
          {
            token: "gho_live",
            scopes: ["repo", "read:org"],
            externalAccountId: "eac_1",
          },
          {
            token: "gho_second",
            scopes: ["repo"],
            externalAccountId: "eac_2",
          },
        ],
      })
    );

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: true,
      credential: {
        token: "gho_live",
        scopes: ["repo", "read:org"],
        externalAccountId: "eac_1",
      },
    });
  });

  it("asks Clerk with the bare provider name, not the deprecated prefix", async () => {
    const getToken = wireClerkTokens(
      vi.fn().mockResolvedValue({
        data: [{ token: "t", scopes: ["repo"], externalAccountId: "eac" }],
      })
    );

    await resolveClerkGitHubCredential(nextInput());

    expect(getToken).toHaveBeenCalledWith("clerk_user_1", "github");
  });

  it("denies not_connected when the user has no linked GitHub account", async () => {
    wireClerkTokens(vi.fn().mockResolvedValue({ data: [] }));

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: false,
      reason: GitHubAccessDenialReason.NotConnected,
    });
  });

  it("denies not_connected when Clerk answers 404 for the external account", async () => {
    wireClerkTokens(
      vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("nope"), { status: 404 }))
    );

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: false,
      reason: GitHubAccessDenialReason.NotConnected,
    });
  });

  it("denies not_connected when the user row carries no Clerk identity", async () => {
    const getToken = wireClerkTokens(vi.fn());
    wireUser(null);

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: false,
      reason: GitHubAccessDenialReason.NotConnected,
    });
    expect(getToken).not.toHaveBeenCalled();
  });

  it("denies insufficient_scope when the grant lacks repo", async () => {
    wireClerkTokens(
      vi.fn().mockResolvedValue({
        data: [
          {
            token: "gho_narrow",
            scopes: ["read:user", "user:email"],
            externalAccountId: "eac_1",
          },
        ],
      })
    );

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });
  });

  it("denies insufficient_scope when Clerk reports no scopes at all", async () => {
    // `scopes` is optional on Clerk's OauthAccessToken. An unproven grant must
    // fail closed rather than be waved through as repo-capable.
    wireClerkTokens(
      vi.fn().mockResolvedValue({
        data: [{ token: "gho_unknown", externalAccountId: "eac_1" }],
      })
    );

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });
  });

  it("denies unavailable on a Clerk 5xx", async () => {
    wireClerkTokens(
      vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("boom"), { status: 503 }))
    );

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: false,
      reason: GitHubAccessDenialReason.Unavailable,
    });
  });

  it("denies unavailable on a transport failure carrying no status", async () => {
    wireClerkTokens(vi.fn().mockRejectedValue(new Error("socket hang up")));

    const result = await resolveClerkGitHubCredential(nextInput());

    expect(result).toEqual({
      ok: false,
      reason: GitHubAccessDenialReason.Unavailable,
    });
  });

  it("single-flights concurrent resolutions for the same user", async () => {
    // The fan-out this exists to stop: a 20-row branch list resolving a
    // credential per row must cost one Clerk round-trip, not twenty.
    let release: (value: { data: unknown[] }) => void = () => {
      // replaced synchronously by the promise executor below
    };
    const pending = new Promise<{ data: unknown[] }>((resolve) => {
      release = resolve;
    });
    const getToken = wireClerkTokens(vi.fn().mockReturnValue(pending));
    const input = nextInput();

    const inflight = [
      resolveClerkGitHubCredential(input),
      resolveClerkGitHubCredential(input),
      resolveClerkGitHubCredential(input),
    ];
    release({
      data: [{ token: "gho_one", scopes: ["repo"], externalAccountId: "eac" }],
    });
    const results = await Promise.all(inflight);

    expect(getToken).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.ok).toBe(true);
    }
  });

  it("releases the single-flight entry so a later resolution refetches", async () => {
    const getToken = wireClerkTokens(
      vi.fn().mockResolvedValue({
        data: [{ token: "gho", scopes: ["repo"], externalAccountId: "eac" }],
      })
    );
    const input = nextInput();

    await resolveClerkGitHubCredential(input);
    await resolveClerkGitHubCredential(input);

    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
