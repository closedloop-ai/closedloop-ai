import {
  GitHubDataConnectionSource,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { describe, expect, it, vi } from "vitest";
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

  it("treats a valid user OAuth grant as connected without an App installation", async () => {
    const db = createDb({ userGrant: createUserGrant() });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: true,
      sources: [GitHubDataConnectionSource.UserOAuth],
      oauthRequiredReasons: [],
    });
  });

  it("keeps both sources when the App and user OAuth grant are usable", async () => {
    const db = createDb({
      activeInstallation: { id: "installation-1" },
      userGrant: createUserGrant(),
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

  it("reports expired user grants as an OAuth recovery state", async () => {
    const db = createDb({
      userGrant: createUserGrant({
        tokenExpiresAt: new Date("2026-07-06T11:59:59.000Z"),
      }),
    });

    await expect(resolveStatus(db)).resolves.toMatchObject({
      connected: false,
      oauthRequiredReasons: [
        GitHubOAuthRequiredReason.NoAppInstallation,
        GitHubOAuthRequiredReason.CredentialExpired,
      ],
    });
  });

  it("treats GitHub App user-token grants as connected even with empty scopes", async () => {
    const db = createDb({ userGrant: createUserGrant() });

    await expect(resolveStatus(db)).resolves.toEqual({
      connected: true,
      sources: [GitHubDataConnectionSource.UserOAuth],
      oauthRequiredReasons: [],
    });
  });
});

function resolveStatus(db: ReturnType<typeof createDb>) {
  return resolveGitHubDataConnectionStatus(db, {
    now,
    organizationId,
    userId,
  });
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

function createUserGrant(
  overrides: Partial<{
    revokedAt: Date | null;
    tokenExpiresAt: Date | null;
  }> = {}
) {
  return {
    revokedAt: overrides.revokedAt ?? null,
    tokenExpiresAt: overrides.tokenExpiresAt ?? null,
  };
}
