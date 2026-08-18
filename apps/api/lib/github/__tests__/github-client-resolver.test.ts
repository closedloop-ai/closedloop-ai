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
import { GitHubAccessIntent } from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";
import {
  APP_USER_CONNECTION,
  makeResolverDb,
  mockDecrypt,
  mockGetInstallationOctokit,
  NOW,
  okFetch,
  type ResolverConnectionFixture,
  USER_TARGET_INPUT,
  type WithDbMock,
  wireDb,
} from "./github-access-test-fixtures";

const mockWithDb = withDb as unknown as WithDbMock;

// Lane selection and stored-credential policy: the manage lane's installation
// resolution and the user lane's connection denials + lastUsedAt sampling.
// Verdict-cache read semantics live in github-client-resolver-cache.test.ts;
// probe outcomes in github-client-resolver-probe.test.ts.
describe("getGitHubClient (stored credential policy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockResolvedValue("decrypted-token");
  });

  it("returns not_connected when no connection exists", async () => {
    wireDb(mockWithDb, makeResolverDb(null));
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NotConnected },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("collapses revoked, expired, and undecryptable tokens to revoked", async () => {
    const variants: Partial<ResolverConnectionFixture>[] = [
      { revokedAt: new Date("2026-07-29T00:00:00.000Z") },
      { tokenExpiresAt: new Date("2026-07-30T11:00:00.000Z") },
    ];
    for (const variant of variants) {
      wireDb(
        mockWithDb,
        makeResolverDb({ ...APP_USER_CONNECTION, ...variant })
      );
      const result = await getGitHubClient(USER_TARGET_INPUT, {
        now: NOW,
        fetch: okFetch(),
      });
      expect(result).toEqual({
        ok: false,
        error: { reason: GitHubAccessDenialReason.Revoked },
      });
    }

    wireDb(mockWithDb, makeResolverDb({ ...APP_USER_CONNECTION }));
    mockDecrypt.mockRejectedValueOnce(new Error("kms denied"));
    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: okFetch(),
    });
    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Revoked },
    });
  });

  it("denies OAuth-family tokens missing the repo scope without probing", async () => {
    wireDb(
      mockWithDb,
      makeResolverDb({ ...APP_USER_CONNECTION, scopes: ["read:user"] })
    );
    const fetchMock = okFetch();

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.InsufficientScope },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("samples lastUsedAt: skips the write for a recently used connection", async () => {
    const db = makeResolverDb({
      ...APP_USER_CONNECTION,
      lastUsedAt: new Date("2026-07-30T11:59:00.000Z"),
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          denialReason: null,
          installationId: null,
          checkedAt: new Date("2026-07-30T11:58:00.000Z"),
          expiresAt: new Date("2026-07-30T12:10:00.000Z"),
        },
      ],
    });
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: okFetch(),
    });

    expect(result.ok).toBe(true);
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
  });

  it("samples lastUsedAt: writes it for a stale connection", async () => {
    const db = makeResolverDb({
      ...APP_USER_CONNECTION,
      lastUsedAt: new Date("2026-07-30T11:00:00.000Z"),
      capabilities: [
        {
          credentialKind: GitHubCredentialKind.GithubAppUser,
          denialReason: null,
          installationId: null,
          checkedAt: new Date("2026-07-30T11:58:00.000Z"),
          expiresAt: new Date("2026-07-30T12:10:00.000Z"),
        },
      ],
    });
    wireDb(mockWithDb, db);

    const result = await getGitHubClient(USER_TARGET_INPUT, {
      now: NOW,
      fetch: okFetch(),
    });

    expect(result.ok).toBe(true);
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        organizationId: "org-1",
        userId: "user-1",
        revokedAt: null,
      },
      data: { lastUsedAt: NOW },
    });
  });
});

describe("getGitHubClient (manage lane)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const MANAGE_INPUT = {
    organizationId: "org-1",
    userId: "user-1",
    target: { owner: "Acme" },
    intent: GitHubAccessIntent.Manage,
  } as const;

  it("returns the installation client when the org installation covers the owner", async () => {
    const db = makeResolverDb(null);
    db.gitHubInstallation.findUnique.mockResolvedValue({
      installationId: "install-77",
      accountLogin: "acme",
      status: "ACTIVE",
    });
    wireDb(mockWithDb, db);
    const octokit = { rest: {} };
    mockGetInstallationOctokit.mockResolvedValue(octokit);

    const result = await getGitHubClient(MANAGE_INPUT);

    expect(result).toEqual({
      ok: true,
      value: {
        octokit,
        kind: GitHubCredentialKind.Installation,
        actingAs: { installationId: "install-77" },
        rateLimitTier: null,
      },
    });
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith("install-77");
  });

  it("classifies installation-token acquisition failures instead of throwing", async () => {
    const db = makeResolverDb(null);
    db.gitHubInstallation.findUnique.mockResolvedValue({
      installationId: "install-77",
      accountLogin: "acme",
      status: "ACTIVE",
    });
    wireDb(mockWithDb, db);
    mockGetInstallationOctokit.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 502 })
    );

    const result = await getGitHubClient(MANAGE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });
  });

  it("denies no_installation for inactive or owner-mismatched installations", async () => {
    const variants = [
      null,
      { installationId: "i", accountLogin: "acme", status: "SUSPENDED" },
      { installationId: "i", accountLogin: "other-org", status: "ACTIVE" },
    ];
    for (const installation of variants) {
      const db = makeResolverDb(null);
      db.gitHubInstallation.findUnique.mockResolvedValue(installation);
      wireDb(mockWithDb, db);

      const result = await getGitHubClient(MANAGE_INPUT);

      expect(result).toEqual({
        ok: false,
        error: { reason: GitHubAccessDenialReason.NoInstallation },
      });
    }
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
  });
});
