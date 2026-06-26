import {
  BranchViewCommentActionResultCode,
  BranchViewCommentWriteIdentityStatus,
} from "@repo/api/src/types/branch-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/integration-encryption", () => ({
  decryptIntegrationToken: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  getGitHubWriteIdentityStatus,
  requireGitHubWriteIdentity,
} from "@/app/comments/github-identity";
import { decryptIntegrationToken } from "@/lib/integration-encryption";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
const mockDecryptIntegrationToken = decryptIntegrationToken as ReturnType<
  typeof vi.fn
>;

const NOW = new Date("2026-05-20T12:00:00.000Z");
type GitHubUserConnectionFixture = {
  id: string;
  organizationId: string;
  userId: string;
  githubUserId: string;
  login: string;
  accessTokenEncrypted: string;
  revokedAt: Date | null;
  tokenExpiresAt: Date | null;
  scopes: string[];
};

const CONNECTION: GitHubUserConnectionFixture = {
  id: "connection-1",
  organizationId: "org-1",
  userId: "user-1",
  githubUserId: "123",
  login: "octocat",
  accessTokenEncrypted: "encrypted-token",
  revokedAt: null,
  tokenExpiresAt: new Date("2026-05-20T13:00:00.000Z"),
  scopes: ["repo"],
};

describe("requireGitHubWriteIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptIntegrationToken.mockResolvedValue("decrypted-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decrypts an active token and updates lastUsedAt after decryption", async () => {
    const db = makeDb(CONNECTION);

    const result = await requireGitHubWriteIdentity({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      db: db as never,
    });

    expect(mockDecryptIntegrationToken).toHaveBeenCalledWith("encrypted-token");
    expect(db.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        organizationId: "org-1",
        userId: "user-1",
        revokedAt: null,
      },
      data: { lastUsedAt: NOW },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        userId: "user-1",
        organizationId: "org-1",
        githubUserConnectionId: "connection-1",
        githubUserId: "123",
        login: "octocat",
        token: "decrypted-token",
        scopes: ["repo"],
      },
    });
  });

  it("uses withDb when no client is provided", async () => {
    const db = makeDb(CONNECTION);
    mockWithDb.mockImplementation((callback: (client: typeof db) => unknown) =>
      callback(db)
    );

    await requireGitHubWriteIdentity({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
    });

    expect(mockWithDb).toHaveBeenCalled();
  });

  it("returns identity_required when no active connection exists", async () => {
    const db = makeDb(null);

    const result = await requireGitHubWriteIdentity({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      db: db as never,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: BranchViewCommentActionResultCode.GithubIdentityRequired,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Missing,
        },
      },
    });
    expect(mockDecryptIntegrationToken).not.toHaveBeenCalled();
    expect(db.gitHubUserConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_userId: {
            organizationId: "org-1",
            userId: "user-1",
          },
        },
      })
    );
  });

  it("returns identity_expired without decrypting expired tokens", async () => {
    const db = makeDb({
      ...CONNECTION,
      tokenExpiresAt: new Date("2026-05-20T12:00:00.000Z"),
    });

    const result = await requireGitHubWriteIdentity({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      db: db as never,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: BranchViewCommentActionResultCode.GithubIdentityExpired,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Expired,
        },
      },
    });
    expect(mockDecryptIntegrationToken).not.toHaveBeenCalled();
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when decryption fails", async () => {
    const db = makeDb(CONNECTION);
    mockDecryptIntegrationToken.mockRejectedValueOnce(new Error("kms denied"));

    const result = await requireGitHubWriteIdentity({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      db: db as never,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: BranchViewCommentActionResultCode.GithubIdentityExpired,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.DecryptionFailed,
        },
      },
    });
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when the row is revoked before lastUsedAt is written", async () => {
    const db = makeDb(CONNECTION, { updateCount: 0 });

    const result = await requireGitHubWriteIdentity({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      db: db as never,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: BranchViewCommentActionResultCode.GithubIdentityExpired,
        identityBlocker: {
          status: BranchViewCommentWriteIdentityStatus.Revoked,
        },
      },
    });
  });

  it("reads active status with findUnique and without selecting or decrypting token material", async () => {
    const db = makeDb(CONNECTION);

    const result = await getGitHubWriteIdentityStatus({
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      db: db as never,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: BranchViewCommentWriteIdentityStatus.Active,
        githubUserId: "123",
        login: "octocat",
      },
    });
    expect(db.gitHubUserConnection.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_userId: {
          organizationId: "org-1",
          userId: "user-1",
        },
      },
      select: {
        githubUserId: true,
        login: true,
        revokedAt: true,
        tokenExpiresAt: true,
      },
    });
    expect(mockDecryptIntegrationToken).not.toHaveBeenCalled();
    expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
  });

  it("classifies revoked and expired read statuses without decrypting", async () => {
    for (const [connection, status] of [
      [
        { ...CONNECTION, revokedAt: new Date("2026-05-20T11:00:00.000Z") },
        BranchViewCommentWriteIdentityStatus.Revoked,
      ],
      [
        { ...CONNECTION, tokenExpiresAt: new Date("2026-05-20T12:00:00.000Z") },
        BranchViewCommentWriteIdentityStatus.Expired,
      ],
    ] as const) {
      vi.clearAllMocks();
      const db = makeDb(connection);

      const result = await getGitHubWriteIdentityStatus({
        organizationId: "org-1",
        userId: "user-1",
        now: NOW,
        db: db as never,
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: BranchViewCommentActionResultCode.GithubIdentityExpired,
          identityBlocker: { status },
        },
      });
      expect(mockDecryptIntegrationToken).not.toHaveBeenCalled();
      expect(db.gitHubUserConnection.updateMany).not.toHaveBeenCalled();
    }
  });
});

function makeDb(
  connection: GitHubUserConnectionFixture | null,
  options?: { updateCount?: number }
) {
  return {
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue(connection),
      updateMany: vi.fn().mockResolvedValue({
        count: options?.updateCount ?? 1,
      }),
    },
  };
}
