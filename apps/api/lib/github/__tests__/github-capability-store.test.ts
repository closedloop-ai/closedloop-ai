import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { withDb } from "@repo/database";
import {
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubCapabilityTtlMs,
  GitHubSyncHealthState,
} from "@/lib/github/github-access";
import {
  activeRepoVerdictWhere,
  type GitHubCapabilityVerdict,
  type GitHubRepoVerdictRow,
  hasActiveNoAccessVerdict,
  hasDurableNoAccessVerdict,
  markGitHubConnectionRevoked,
  saveCapabilityVerdict,
} from "@/lib/github/github-capability-store";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};

const NOW = new Date("2026-07-30T12:00:00.000Z");

const VERDICT: GitHubCapabilityVerdict = {
  organizationId: "org-1",
  githubUserConnectionId: "connection-1",
  targetOwner: "Acme",
  normalizedTargetOwner: "acme",
  targetRepo: null,
  credentialKind: GitHubCredentialKind.GithubAppUser,
  denialReason: null,
  installationId: null,
  checkedAt: NOW,
  expiresAt: new Date("2026-07-30T12:15:00.000Z"),
};

// Identity is org-scoped; both update paths carry the freshness guard so a
// slower older probe can never move the cache backward.
const GUARDED_IDENTITY = {
  organizationId: "org-1",
  githubUserConnectionId: "connection-1",
  normalizedTargetOwner: "acme",
  targetRepo: null,
  checkedAt: { lte: NOW },
};

const DATA = {
  targetOwner: "Acme",
  credentialKind: GitHubCredentialKind.GithubAppUser,
  denialReason: null,
  installationId: null,
  checkedAt: NOW,
  expiresAt: new Date("2026-07-30T12:15:00.000Z"),
};

function makeDb() {
  return {
    gitHubAccessCapability: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe("saveCapabilityVerdict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the existing row without creating", async () => {
    const db = makeDb();
    db.gitHubAccessCapability.updateMany.mockResolvedValue({ count: 1 });

    await saveCapabilityVerdict(db, VERDICT);

    expect(db.gitHubAccessCapability.updateMany).toHaveBeenCalledWith({
      where: GUARDED_IDENTITY,
      data: DATA,
    });
    expect(db.gitHubAccessCapability.create).not.toHaveBeenCalled();
  });

  it("creates the row when none exists", async () => {
    const db = makeDb();

    await saveCapabilityVerdict(db, VERDICT);

    expect(db.gitHubAccessCapability.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        githubUserConnectionId: "connection-1",
        normalizedTargetOwner: "acme",
        targetRepo: null,
        ...DATA,
      },
    });
  });

  it("recovers from a create race by updating the winner's row", async () => {
    const db = makeDb();
    db.gitHubAccessCapability.create.mockRejectedValueOnce({ code: "P2002" });

    await saveCapabilityVerdict(db, {
      ...VERDICT,
      denialReason: GitHubAccessDenialReason.NoInstallation,
    });

    expect(db.gitHubAccessCapability.updateMany).toHaveBeenCalledTimes(2);
    expect(db.gitHubAccessCapability.updateMany).toHaveBeenLastCalledWith({
      where: GUARDED_IDENTITY,
      data: {
        ...DATA,
        denialReason: GitHubAccessDenialReason.NoInstallation,
      },
    });
  });

  it("drops a stale write when the stored verdict is newer", async () => {
    // Update misses (row exists but is newer), create collides, and the
    // guarded fallback update also misses — the stale probe writes nothing
    // and does not throw.
    const db = makeDb();
    db.gitHubAccessCapability.create.mockRejectedValueOnce({ code: "P2002" });
    db.gitHubAccessCapability.updateMany.mockResolvedValue({ count: 0 });

    await expect(saveCapabilityVerdict(db, VERDICT)).resolves.toBeUndefined();

    for (const call of db.gitHubAccessCapability.updateMany.mock.calls) {
      expect(call[0].where).toMatchObject({ checkedAt: { lte: NOW } });
    }
  });

  it("rethrows non-unique-constraint create failures", async () => {
    const db = makeDb();
    const failure = new Error("connection reset");
    db.gitHubAccessCapability.create.mockRejectedValueOnce(failure);

    await expect(saveCapabilityVerdict(db, VERDICT)).rejects.toThrow(
      "connection reset"
    );
    expect(db.gitHubAccessCapability.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("markGitHubConnectionRevoked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTx(revokeCount: number) {
    return {
      gitHubUserConnection: {
        updateMany: vi.fn().mockResolvedValue({ count: revokeCount }),
      },
      gitHubAccessCapability: {
        deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
    };
  }

  it("revokes the failing credential and drops its capabilities in one transaction", async () => {
    const tx = makeTx(1);
    mockWithDb.tx.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx)
    );

    await markGitHubConnectionRevoked({
      organizationId: "org-1",
      githubUserConnectionId: "connection-1",
      accessTokenEncrypted: "cipher-a",
      now: NOW,
    });

    expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
    expect(tx.gitHubUserConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-1",
        organizationId: "org-1",
        revokedAt: null,
        accessTokenEncrypted: "cipher-a",
      },
      data: { revokedAt: NOW, healthState: GitHubSyncHealthState.Unhealthy },
    });
    expect(tx.gitHubAccessCapability.deleteMany).toHaveBeenCalledWith({
      where: {
        githubUserConnectionId: "connection-1",
        organizationId: "org-1",
      },
    });
  });

  it("does nothing when the stored credential no longer matches (post-reconnect 401)", async () => {
    // A late 401 from a client built on the replaced token: the CAS misses,
    // and neither the replacement credential nor its capability rows are
    // touched.
    const tx = makeTx(0);
    mockWithDb.tx.mockImplementation((fn: (client: typeof tx) => unknown) =>
      fn(tx)
    );

    await markGitHubConnectionRevoked({
      organizationId: "org-1",
      githubUserConnectionId: "connection-1",
      accessTokenEncrypted: "cipher-old",
      now: NOW,
    });

    expect(tx.gitHubAccessCapability.deleteMany).not.toHaveBeenCalled();
  });
});

describe("activeRepoVerdictWhere", () => {
  it("normalizes mixed-case owner and repo to lowercase and gates on expiresAt > now", () => {
    const result = activeRepoVerdictWhere(
      [{ owner: "Acme", repo: "Widgets" }],
      NOW
    );
    expect(result).toEqual({
      OR: [{ normalizedTargetOwner: "acme", targetRepo: "widgets" }],
      expiresAt: { gt: NOW },
    });
  });

  it("produces one OR branch per target when called with two repos", () => {
    const result = activeRepoVerdictWhere(
      [
        { owner: "Acme", repo: "Widgets" },
        { owner: "OtherOrg", repo: "Backend" },
      ],
      NOW
    );
    expect(result.OR).toHaveLength(2);
    expect(result.OR[0]).toEqual({
      normalizedTargetOwner: "acme",
      targetRepo: "widgets",
    });
    expect(result.OR[1]).toEqual({
      normalizedTargetOwner: "otherorg",
      targetRepo: "backend",
    });
  });
});

describe("hasActiveNoAccessVerdict", () => {
  // scopes [GITHUB_REPO_SCOPE] -> OauthUser; scopes [] -> GithubAppUser
  it("returns true when a row of the matching credential kind carries a non-null denial", () => {
    const oauthScopes = [GITHUB_REPO_SCOPE];
    const row: GitHubRepoVerdictRow = {
      credentialKind: GitHubCredentialKind.OauthUser,
      denialReason: GitHubAccessDenialReason.NoInstallation,
      checkedAt: NOW,
      expiresAt: new Date(NOW.getTime() + GitHubCapabilityTtlMs.Negative),
    };
    expect(hasActiveNoAccessVerdict([row], oauthScopes)).toBe(true);
  });

  it("ignores a verdict row from the other credential family", () => {
    // scopes [GITHUB_REPO_SCOPE] identifies an OAuth connection; an App-family row on
    // the same connection says nothing about whether the OAuth token can reach
    // the target.
    const oauthScopes = [GITHUB_REPO_SCOPE];
    const row: GitHubRepoVerdictRow = {
      credentialKind: GitHubCredentialKind.GithubAppUser,
      denialReason: GitHubAccessDenialReason.NoInstallation,
      checkedAt: NOW,
      expiresAt: new Date(NOW.getTime() + GitHubCapabilityTtlMs.Negative),
    };
    expect(hasActiveNoAccessVerdict([row], oauthScopes)).toBe(false);
  });

  it("returns false when the denial reason is null (positive verdict)", () => {
    const oauthScopes = [GITHUB_REPO_SCOPE];
    const row: GitHubRepoVerdictRow = {
      credentialKind: GitHubCredentialKind.OauthUser,
      denialReason: null,
      checkedAt: NOW,
      expiresAt: new Date(NOW.getTime() + GitHubCapabilityTtlMs.Positive),
    };
    expect(hasActiveNoAccessVerdict([row], oauthScopes)).toBe(false);
  });
});

describe("hasDurableNoAccessVerdict", () => {
  const oauthScopes = [GITHUB_REPO_SCOPE];

  it("a 5-minute interactive denial does not demote a repo", () => {
    // The interactive resolver writes short-lived negatives. Letting one
    // suppress tier-2 would turn a transient branch-view 403 into a 6+ hour
    // sync outage. The lifetime MUST be < GITHUB_SYNC_REPO_VERDICT_TTL_MS.
    const row: GitHubRepoVerdictRow = {
      credentialKind: GitHubCredentialKind.OauthUser,
      denialReason: GitHubAccessDenialReason.NoInstallation,
      checkedAt: NOW,
      expiresAt: new Date(NOW.getTime() + GitHubCapabilityTtlMs.Negative),
    };
    expect(hasDurableNoAccessVerdict([row], oauthScopes)).toBe(false);
  });

  it("a sync-lane 6-hour denial is durable and correctly demotes the repo", () => {
    const row: GitHubRepoVerdictRow = {
      credentialKind: GitHubCredentialKind.OauthUser,
      denialReason: GitHubAccessDenialReason.NoInstallation,
      checkedAt: NOW,
      expiresAt: new Date(NOW.getTime() + GITHUB_SYNC_REPO_VERDICT_TTL_MS),
    };
    expect(hasDurableNoAccessVerdict([row], oauthScopes)).toBe(true);
  });
});
