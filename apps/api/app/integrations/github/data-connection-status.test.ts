import {
  GitHubDataConnectionSource,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { describe, expect, it, vi } from "vitest";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { resolveGitHubDataConnectionStatus } from "./data-connection-status";

const organizationId = "org-1";
const userId = "user-1";
const now = new Date("2026-07-06T12:00:00.000Z");

describe("resolveGitHubDataConnectionStatus", () => {
  it("treats an active GitHub App installation as connected", async () => {
    const db = createDb({ activeInstallation: { id: "installation-1" } });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: true,
      sources: [GitHubDataConnectionSource.GitHubApp],
      oauthRequiredReasons: [],
    });
  });

  it("treats a repo-scoped user OAuth grant as connected without an App installation", async () => {
    const db = createDb({
      userGrant: createUserGrant({ scopes: [GITHUB_REPO_SCOPE] }),
    });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: true,
      sources: [GitHubDataConnectionSource.UserOAuth],
      oauthRequiredReasons: [],
    });
  });

  it("keeps both sources when the App and user OAuth grant are usable", async () => {
    const db = createDb({
      activeInstallation: { id: "installation-1" },
      userGrant: createUserGrant({ scopes: [GITHUB_REPO_SCOPE] }),
    });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: true,
      sources: [
        GitHubDataConnectionSource.GitHubApp,
        GitHubDataConnectionSource.UserOAuth,
      ],
      oauthRequiredReasons: [],
    });
  });

  it("requires OAuth when neither an App nor user grant can serve GitHub data", async () => {
    const db = createDb();

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: false,
      sources: [],
      oauthRequiredReasons: [
        GitHubOAuthRequiredReason.NoAppInstallation,
        GitHubOAuthRequiredReason.NoUserGrant,
      ],
    });
  });

  it("reports revoked user grants as an OAuth recovery state", async () => {
    const db = createDb({
      userGrant: createUserGrant({ revokedAt: now }),
    });

    await expect(resolveStatus(db)).resolves.toMatchObject({
      connected: false,
      oauthRequiredReasons: [
        GitHubOAuthRequiredReason.NoAppInstallation,
        GitHubOAuthRequiredReason.CredentialRevoked,
      ],
    });
  });

  it("refuses a grant that reports no scopes at all", async () => {
    // Reversed deliberately. This case used to assert connected, as the
    // App-family carve-out `meetsGitHubRepoScopeFloor` still makes for the pool
    // and resolver lanes. It does not hold for the credential THIS status
    // describes: `clerk-github-credential.ts` rejects any scope set without
    // `repo`, empty included, and the registry mirrors Clerk's live scopes
    // unconditionally — so an empty array is a row that cannot produce a
    // working token, and calling it connected is the lie ISS-7404 is about.
    const db = createDb({ userGrant: createUserGrant({ scopes: [] }) });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: false,
      sources: [],
      oauthRequiredReasons: [
        GitHubOAuthRequiredReason.NoAppInstallation,
        GitHubOAuthRequiredReason.CredentialInsufficientScope,
      ],
    });
  });

  it("refuses a user OAuth grant whose scopes miss the repo floor", async () => {
    const db = createDb({
      userGrant: createUserGrant({ scopes: ["read:user", "user:email"] }),
    });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: false,
      sources: [],
      oauthRequiredReasons: [
        GitHubOAuthRequiredReason.NoAppInstallation,
        GitHubOAuthRequiredReason.CredentialInsufficientScope,
      ],
    });
  });

  it("keeps an App installation connected alongside an under-scoped grant", async () => {
    const db = createDb({
      activeInstallation: { id: "installation-1" },
      userGrant: createUserGrant({ scopes: ["read:user"] }),
    });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: true,
      sources: [GitHubDataConnectionSource.GitHubApp],
      oauthRequiredReasons: [],
    });
  });

  it("reads the scopes it judges the grant on", async () => {
    const db = createDb({
      userGrant: createUserGrant({ scopes: [GITHUB_REPO_SCOPE] }),
    });

    await resolveStatus(db);

    expect(db.gitHubUserConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { revokedAt: true, scopes: true },
      })
    );
  });
});

function resolveStatus(db: ReturnType<typeof createDb>) {
  return resolveGitHubDataConnectionStatus(db, { organizationId, userId });
}

function createDb({
  activeInstallation = null,
  userGrant = null,
}: {
  activeInstallation?: { id: string } | null;
  userGrant?: ReturnType<typeof createUserGrant> | null;
} = {}) {
  return {
    gitHubInstallation: {
      findFirst: vi.fn(async () => activeInstallation),
    },
    gitHubUserConnection: {
      findUnique: vi.fn(async () => userGrant),
    },
  };
}

/**
 * Scopes default to EMPTY because that is the App-family shape: a GitHub App
 * user-to-server token enumerates no scopes. An OAuth-family grant must name
 * its scopes, so a test asserting the `repo` floor cannot pass by inheriting a
 * permissive default.
 */
function createUserGrant(
  overrides: Partial<{
    revokedAt: Date | null;
    scopes: string[];
  }> = {}
) {
  return {
    revokedAt: overrides.revokedAt ?? null,
    scopes: overrides.scopes ?? [],
  };
}
