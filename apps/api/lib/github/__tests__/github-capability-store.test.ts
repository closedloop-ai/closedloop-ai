import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import {
  GITHUB_SYNC_REPO_VERDICT_TTL_MS,
  GitHubCapabilityTtlMs,
} from "@/lib/github/github-access";
import {
  activeRepoVerdictBatchWhere,
  activeRepoVerdictWhere,
  type GitHubCapabilityVerdict,
  type GitHubRepoVerdictRow,
  hasActiveNoAccessVerdict,
  hasDurableNoAccessVerdict,
  saveCapabilityVerdict,
} from "@/lib/github/github-capability-store";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";

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
      // ISS-6322 narrowed this discarded write's RETURNING to the primary key.
      select: { id: true },
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

describe("activeRepoVerdictWhere", () => {
  it("normalizes mixed-case owner and repo to lowercase and gates on expiresAt > now", () => {
    const result = activeRepoVerdictWhere(
      { owner: "Acme", repo: "Widgets" },
      NOW
    );
    expect(result).toEqual({
      normalizedTargetOwner: { in: ["acme"] },
      targetRepo: { in: ["widgets"] },
      expiresAt: { gt: NOW },
    });
  });
});

describe("activeRepoVerdictBatchWhere", () => {
  it("emits two top-level IN lists rather than one OR disjunct per target (ISS-6577)", () => {
    // An OR list costs Postgres the whole expression per scanned row and 2 bind
    // parameters per target. Two hashed IN checks are flat in the repo count and
    // cost one parameter per DISTINCT value.
    const result = activeRepoVerdictBatchWhere(
      [
        { owner: "Acme", repo: "Widgets" },
        { owner: "OtherOrg", repo: "Backend" },
      ],
      NOW
    );
    expect(result).toEqual({
      normalizedTargetOwner: { in: ["acme", "otherorg"] },
      targetRepo: { in: ["widgets", "backend"] },
      expiresAt: { gt: NOW },
    });
    expect(result).not.toHaveProperty("OR");
  });

  it("collapses repeated owners and repo names so the bind-parameter count tracks distinct values", () => {
    const result = activeRepoVerdictBatchWhere(
      [
        { owner: "Acme", repo: "Widgets" },
        { owner: "ACME", repo: "widgets" },
        { owner: "acme", repo: "Backend" },
      ],
      NOW
    );
    expect(result.normalizedTargetOwner).toEqual({ in: ["acme"] });
    expect(result.targetRepo).toEqual({ in: ["widgets", "backend"] });
  });

  it("agrees exactly with the single-target fragment for one repo", () => {
    // Same definition of "active" for both carriers — the drift ISS-5093 exists
    // to remove. A one-element IN list IS an equality, so the batch variant only
    // over-selects once it holds more than one target.
    const target = { owner: "Acme", repo: "Widgets" };
    expect(activeRepoVerdictBatchWhere([target], NOW)).toEqual(
      activeRepoVerdictWhere(target, NOW)
    );
  });

  it("matches nothing when given no targets", () => {
    const result = activeRepoVerdictBatchWhere([], NOW);
    expect(result.normalizedTargetOwner).toEqual({ in: [] });
    expect(result.targetRepo).toEqual({ in: [] });
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
