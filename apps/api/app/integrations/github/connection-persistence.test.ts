import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    join: vi.fn(),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    })),
  },
  ArtifactType: {},
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/github", () => ({
  deleteInstallation: vi.fn(),
  getInstallationAccessToken: vi.fn(),
  verifyWebhookSignature: vi.fn(),
}));

vi.mock("@repo/github/keys", () => ({
  keys: vi.fn(() => ({})),
}));

import { GitHubSyncHealthState } from "@/lib/github/github-access";
import { persistGitHubUserConnection } from "./service";

const ISSUED_AT = new Date("2026-07-30T12:00:00.000Z");

function makeTx() {
  return {
    gitHubUserConnection: {
      upsert: vi.fn().mockResolvedValue({ id: "conn-1" }),
    },
    gitHubAccessCapability: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
}

describe("persistGitHubUserConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets sync-pool credential state and drops stale verdicts on a fresh grant", async () => {
    // PLN-1525: without this reset, a 401-revoked connection stays
    // `unhealthy` forever after reconnect and the sync pool never draws the
    // replacement token; without the verdict drop, reach earned by the
    // replaced credential (possibly the other credential family) survives.
    const tx = makeTx();

    await persistGitHubUserConnection(tx as never, {
      organizationId: "org-1",
      userId: "user-1",
      githubUser: { id: 9001, login: "octocat" },
      token: {
        accessToken: "raw-token",
        refreshToken: null,
        expiresInSeconds: null,
        refreshTokenExpiresInSeconds: null,
        scopes: [],
      },
      encryptedAccessToken: "cipher-new",
      encryptedRefreshToken: null,
      issuedAt: ISSUED_AT,
    });

    const upsertArg = tx.gitHubUserConnection.upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(upsertArg.update).toMatchObject({
      accessTokenEncrypted: "cipher-new",
      revokedAt: null,
      healthState: GitHubSyncHealthState.Healthy,
      backoffUntil: null,
      windowSpend: 0,
      observedLimit: null,
      observedRemaining: null,
      observedResetAt: null,
    });
    expect(tx.gitHubAccessCapability.deleteMany).toHaveBeenCalledWith({
      where: { githubUserConnectionId: "conn-1", organizationId: "org-1" },
    });
  });
});
