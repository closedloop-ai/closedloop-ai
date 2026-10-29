import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbAll,
} from "../../../../__tests__/utils/db-helpers";

vi.mock("server-only", () => ({}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

const mocks = vi.hoisted(() => ({
  findInstallationByInstallationId: vi.fn(),
  syncRepositories: vi.fn(),
  resolveClerkCredential: vi.fn(),
  fetchAuthenticatedGitHubUser: vi.fn(),
  fetchOrgMembershipState: vi.fn(),
  fetchInstallationRepositories: vi.fn(),
  persistIncompleteInstallationRepositoryObservation: vi.fn(),
  emitRepositoryArtifactRelinkFailedMetric: vi.fn(),
  bulkUpsertInstallationRepositories: vi.fn(),
  tombstoneRepositoriesAbsentFrom: vi.fn(),
  reconcileOrgRepoSyncStatesBestEffort: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/github/clerk-github-credential", () => ({
  resolveClerkGitHubCredential: vi.fn(),
}));

vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: vi.fn(),
}));

vi.mock("./incomplete-repository-observation", () => ({
  persistIncompleteInstallationRepositoryObservation:
    mocks.persistIncompleteInstallationRepositoryObservation,
}));

vi.mock("./installation-repositories-fetch", () => ({
  fetchInstallationRepositories: mocks.fetchInstallationRepositories,
}));

vi.mock("./repository-relink-telemetry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitRepositoryArtifactRelinkFailedMetric:
    mocks.emitRepositoryArtifactRelinkFailedMetric,
}));

vi.mock("./repository-sync", () => ({
  bulkUpsertInstallationRepositories: mocks.bulkUpsertInstallationRepositories,
  tombstoneRepositoriesAbsentFrom: mocks.tombstoneRepositoriesAbsentFrom,
}));

vi.mock("@/lib/github/github-repo-sync-state", () => ({
  reconcileOrgRepoSyncStatesBestEffort:
    mocks.reconcileOrgRepoSyncStatesBestEffort,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

import {
  type GitHubAppInstallation,
  GitHubAppInstallationLookupStatus,
} from "@repo/github/app-installation";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import {
  type ClaimGitHubInstallationDeps,
  claimGitHubInstallation,
} from "./installation-claim";
import {
  RepositoryArtifactRelinkFailureReason,
  RepositoryArtifactRelinkFailureStage,
} from "./repository-relink-telemetry";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const INSTALLATION_RECORD_ID = "rec-1";

const RESOLVED: GitHubAppInstallation = {
  id: 100,
  account: { id: 7, login: "acme", type: "Organization" },
  permissions: { contents: "read" },
  events: ["push"],
  repositorySelection: "all",
};

const REPO_INPUT = {
  githubRepoId: "9001",
  fullName: "acme/repo",
  name: "repo",
  owner: "acme",
  private: false,
};

function foundLookup(installation: GitHubAppInstallation = RESOLVED) {
  return () =>
    Promise.resolve({
      status: GitHubAppInstallationLookupStatus.Found,
      installation,
    });
}

function makeMockDb(
  overrides: {
    priorUninstalled?: Record<string, unknown> | null;
    claimCount?: number;
  } = {}
) {
  return {
    gitHubInstallation: {
      findFirst: vi.fn().mockResolvedValue(overrides.priorUninstalled ?? null),
      create: vi.fn().mockResolvedValue({
        id: INSTALLATION_RECORD_ID,
        organizationId: null,
        status: "PENDING_CLAIM",
      }),
      update: vi.fn().mockResolvedValue({ id: "prior-1" }),
      updateMany: vi
        .fn()
        .mockResolvedValue({ count: overrides.claimCount ?? 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gitHubInstallationRepository: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function claim(overrides: Partial<ClaimGitHubInstallationDeps> = {}) {
  return claimGitHubInstallation(
    { installationId: "100", organizationId: ORG_ID, userId: USER_ID },
    {
      findInstallationByInstallationId: mocks.findInstallationByInstallationId,
      syncRepositories: mocks.syncRepositories,
      resolveClerkCredential: mocks.resolveClerkCredential,
      fetchAuthenticatedGitHubUser: mocks.fetchAuthenticatedGitHubUser,
      fetchOrgMembershipState: mocks.fetchOrgMembershipState,
      ...overrides,
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMockWithDb().mockReset();
  getMockWithDb().tx.mockReset();
  mocks.fetchInstallationRepositories.mockResolvedValue({
    ok: true,
    repositories: [REPO_INPUT],
  });
  mocks.syncRepositories.mockResolvedValue([]);
  mocks.reconcileOrgRepoSyncStatesBestEffort.mockResolvedValue(undefined);
  mocks.findInstallationByInstallationId.mockResolvedValue({
    id: INSTALLATION_RECORD_ID,
    organizationId: null,
    status: "PENDING_CLAIM",
  });
  // cr-66737 access proof: default to a Clerk-linked caller with an active
  // membership in the installation's org, so each test's subject stays the
  // claim behavior it names.
  mocks.resolveClerkCredential.mockResolvedValue({
    ok: true,
    credential: {
      token: "clerk-token",
      scopes: ["repo"],
      externalAccountId: "ea-1",
    },
  });
  mocks.fetchAuthenticatedGitHubUser.mockResolvedValue({ id: 4242 });
  mocks.fetchOrgMembershipState.mockResolvedValue({
    status: "confirmed",
    state: "active",
    role: "admin",
  });
});

describe("claimGitHubInstallation", () => {
  it("claims an unclaimed installation and syncs its repositories", async () => {
    const mockDb = makeMockDb();
    mockWithDbAll(mockDb);

    const result = await claim({ getInstallation: foundLookup() });

    expect(result).toEqual({ status: "connected" });
    expect(mockDb.gitHubInstallation.updateMany).toHaveBeenCalledWith({
      where: {
        id: INSTALLATION_RECORD_ID,
        OR: [{ organizationId: null }, { organizationId: ORG_ID }],
      },
      data: expect.objectContaining({
        status: "ACTIVE",
        organizationId: ORG_ID,
        claimedByUserId: USER_ID,
      }),
    });
    expect(mocks.syncRepositories).toHaveBeenCalledWith(
      INSTALLATION_RECORD_ID,
      [REPO_INPUT]
    );
    // Tier reconcile is scheduled off the response path.
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileOrgRepoSyncStatesBestEffort).toHaveBeenCalledWith(
      ORG_ID
    );
  });

  it("creates the installation record from the lookup when the webhook has not arrived", async () => {
    const mockDb = makeMockDb();
    mockWithDbAll(mockDb);
    mocks.findInstallationByInstallationId.mockResolvedValue(null);

    const result = await claim({ getInstallation: foundLookup() });

    expect(result).toEqual({ status: "connected" });
    expect(mockDb.gitHubInstallation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        installationId: "100",
        accountId: "7",
        accountLogin: "acme",
        accountType: "Organization",
        // No OAuth user anymore — the installation account stands in.
        senderLogin: "acme",
        senderId: "7",
        status: "PENDING_CLAIM",
      }),
    });
  });

  it("adopts the webhook's row when creation loses the race (P2002)", async () => {
    const mockDb = makeMockDb();
    mockDb.gitHubInstallation.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" })
    );
    mockWithDbAll(mockDb);
    mocks.findInstallationByInstallationId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: INSTALLATION_RECORD_ID,
        organizationId: null,
        status: "PENDING_CLAIM",
      });

    const result = await claim({ getInstallation: foundLookup() });

    expect(result).toEqual({ status: "connected" });
    expect(mocks.findInstallationByInstallationId).toHaveBeenCalledTimes(2);
  });

  it("blocks claiming an installation owned by another org", async () => {
    const mockDb = makeMockDb();
    mockWithDbAll(mockDb);
    mocks.findInstallationByInstallationId.mockResolvedValue({
      id: INSTALLATION_RECORD_ID,
      organizationId: "other-org",
      status: "ACTIVE",
    });

    const result = await claim({ getInstallation: foundLookup() });

    expect(result).toEqual({
      status: "error",
      error:
        "This GitHub installation is already connected to another organization",
    });
    expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
  });

  it("fails when ownership changes between the check and the claim write", async () => {
    const mockDb = makeMockDb({ claimCount: 0 });
    mockWithDbAll(mockDb);

    const result = await claim({ getInstallation: foundLookup() });

    expect(result).toEqual({
      status: "error",
      error:
        "This GitHub installation is already connected to another organization",
    });
    expect(mocks.syncRepositories).not.toHaveBeenCalled();
  });

  it("connects anyway when the repository walk fails, recording the observation", async () => {
    const mockDb = makeMockDb();
    mockWithDbAll(mockDb);
    mocks.fetchInstallationRepositories.mockResolvedValue({
      ok: false,
      repositories: [],
      unavailable: true,
      error: RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed,
    });

    const result = await claim({ getInstallation: foundLookup() });

    expect(result).toEqual({ status: "connected" });
    expect(
      mocks.persistIncompleteInstallationRepositoryObservation
    ).toHaveBeenCalledWith(INSTALLATION_RECORD_ID, [], true);
    expect(mocks.emitRepositoryArtifactRelinkFailedMetric).toHaveBeenCalledWith(
      RepositoryArtifactRelinkFailureStage.OAuthClaim,
      RepositoryArtifactRelinkFailureReason.RepositoryFetchFailed
    );
    expect(mocks.syncRepositories).not.toHaveBeenCalled();
  });

  it("maps a not_found lookup onto a user-facing error", async () => {
    const mockDb = makeMockDb();
    mockWithDbAll(mockDb);

    const result = await claim({
      getInstallation: async () => ({
        status: GitHubAppInstallationLookupStatus.NotFound,
      }),
    });

    expect(result).toEqual({
      status: "error",
      error:
        "GitHub installation not found. Please install the GitHub App first.",
    });
    expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    expect(mocks.fetchInstallationRepositories).not.toHaveBeenCalled();
  });

  it("maps a lookup provider failure onto a generic error", async () => {
    const mockDb = makeMockDb();
    mockWithDbAll(mockDb);

    const result = await claim({
      getInstallation: async () => ({
        status: GitHubAppInstallationLookupStatus.Error,
      }),
    });

    expect(result).toEqual({
      status: "error",
      error: "Failed to verify the GitHub installation",
    });
  });

  // cr-66737 (BLOCKING): installation ids are enumerable and PENDING_CLAIM
  // rows are org-less — without the access proof any authenticated org could
  // claim any freshly installed app and sync the victim's private repos.
  describe("per-caller access proof", () => {
    it("refuses a caller with no Clerk-linked GitHub account", async () => {
      const mockDb = makeMockDb();
      mockWithDbAll(mockDb);
      mocks.resolveClerkCredential.mockResolvedValue({
        ok: false,
        reason: "not_connected",
      });

      const result = await claim({ getInstallation: foundLookup() });

      expect(result).toEqual({
        status: "error",
        error: "Connect your GitHub account before claiming this installation.",
        // The web callback routes this code to the linking page instead of
        // the generic "Failed to connect" dead end.
        code: "github_link_required",
      });
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
      expect(mocks.fetchInstallationRepositories).not.toHaveBeenCalled();
    });

    it("refuses a caller who is not a member of the installation's org", async () => {
      const mockDb = makeMockDb();
      mockWithDbAll(mockDb);
      mocks.fetchOrgMembershipState.mockResolvedValue({ status: "refused" });

      const result = await claim({ getInstallation: foundLookup() });

      expect(result).toEqual({
        status: "error",
        error:
          "You must be an owner of the acme GitHub organization to claim this installation.",
      });
      expect(mocks.fetchOrgMembershipState).toHaveBeenCalledWith(
        "clerk-token",
        "acme"
      );
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("refuses an ordinary member of the installation's org", async () => {
      // GitHub only lets org OWNERS install an App, so a member-level proof
      // would let any member of a victim org bind that org's fresh
      // installation to their own Closedloop org.
      const mockDb = makeMockDb();
      mockWithDbAll(mockDb);
      mocks.fetchOrgMembershipState.mockResolvedValue({
        status: "confirmed",
        state: "active",
        role: "member",
      });

      const result = await claim({ getInstallation: foundLookup() });

      expect(result).toEqual({
        status: "error",
        error:
          "You must be an owner of the acme GitHub organization to claim this installation.",
      });
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("refuses a pending invitation rather than treating it as ownership", async () => {
      const mockDb = makeMockDb();
      mockWithDbAll(mockDb);
      mocks.fetchOrgMembershipState.mockResolvedValue({
        status: "confirmed",
        state: "pending",
        role: "admin",
      });

      const result = await claim({ getInstallation: foundLookup() });

      expect(result.status).toBe("error");
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("says the membership check failed when GitHub is unavailable", async () => {
      // A 5xx is not an authorization fact: telling the real installer they
      // are not an owner sends them to fix a permission they already hold.
      const mockDb = makeMockDb();
      mockWithDbAll(mockDb);
      mocks.fetchOrgMembershipState.mockResolvedValue({
        status: "unavailable",
      });

      const result = await claim({ getInstallation: foundLookup() });

      expect(result).toEqual({
        status: "error",
        error:
          "Couldn't check your membership of the acme GitHub organization right now. Try again in a moment.",
      });
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("refuses to pin a different-account reconnect for a non-member", async () => {
      // The proof must run BEFORE reconnect detection, or an attacker could
      // plant the pendingNewInstallationId pin on the victim's prior row.
      const mockDb = makeMockDb({
        priorUninstalled: {
          id: "prior-1",
          accountId: "999",
          accountLogin: "legacy-org",
        },
      });
      mockWithDbAll(mockDb);
      mocks.fetchOrgMembershipState.mockResolvedValue({ status: "refused" });

      const result = await claim({ getInstallation: foundLookup() });

      expect(result.status).toBe("error");
      expect(mockDb.gitHubInstallation.update).not.toHaveBeenCalled();
    });

    it("splits a GitHub outage from a refusal in the real membership read", async () => {
      // The default wiring is what production runs; a bare catch here is how
      // a 5xx becomes "you must be an owner", which is a lie about access.
      const mockDb = makeMockDb();
      mockWithDbAll(mockDb);
      const getMembershipForAuthenticatedUser = vi.fn();
      vi.mocked(getUserTokenOctokit).mockReturnValue({
        rest: { orgs: { getMembershipForAuthenticatedUser } },
      } as unknown as ReturnType<typeof getUserTokenOctokit>);

      getMembershipForAuthenticatedUser.mockRejectedValue(
        Object.assign(new Error("not a member"), { status: 404 })
      );
      const refused = await claim({
        getInstallation: foundLookup(),
        fetchOrgMembershipState: undefined,
      });
      expect(refused).toEqual({
        status: "error",
        error:
          "You must be an owner of the acme GitHub organization to claim this installation.",
      });

      getMembershipForAuthenticatedUser.mockRejectedValue(
        Object.assign(new Error("bad gateway"), { status: 502 })
      );
      const unavailable = await claim({
        getInstallation: foundLookup(),
        fetchOrgMembershipState: undefined,
      });
      expect(unavailable).toEqual({
        status: "error",
        error:
          "Couldn't check your membership of the acme GitHub organization right now. Try again in a moment.",
      });

      getMembershipForAuthenticatedUser.mockResolvedValue({
        data: { state: "active", role: "admin" },
      });
      const granted = await claim({
        getInstallation: foundLookup(),
        fetchOrgMembershipState: undefined,
      });
      expect(granted).toEqual({ status: "connected" });
    });

    it("claims a personal installation only for the matching GitHub user", async () => {
      const mockDb = makeMockDb();
      mockWithDbAll(mockDb);
      const personal = foundLookup({
        ...RESOLVED,
        account: { id: 4242, login: "octocat", type: "User" },
      });

      const granted = await claim({ getInstallation: personal });
      expect(granted).toEqual({ status: "connected" });
      // A personal install never consults org membership.
      expect(mocks.fetchOrgMembershipState).not.toHaveBeenCalled();

      mocks.fetchAuthenticatedGitHubUser.mockResolvedValue({ id: 9999 });
      const denied = await claim({ getInstallation: personal });
      expect(denied).toEqual({
        status: "error",
        error:
          "This GitHub App installation belongs to a different GitHub account.",
      });
    });
  });

  describe("reconnect detection (PLN-634)", () => {
    const PRIOR_SAME_ACCOUNT = {
      id: "prior-1",
      accountId: "7",
      accountLogin: "acme",
    };
    const PRIOR_OTHER_ACCOUNT = {
      id: "prior-1",
      accountId: "999",
      accountLogin: "legacy-org",
    };

    it("reuses the prior row in place on a same-account reinstall", async () => {
      const mockDb = makeMockDb({ priorUninstalled: PRIOR_SAME_ACCOUNT });
      mockWithDbAll(mockDb);

      const result = await claim({ getInstallation: foundLookup() });

      expect(result).toEqual({ status: "connected" });
      // The webhook-raced PENDING_CLAIM sibling is dropped, never a claimed row.
      expect(mockDb.gitHubInstallation.deleteMany).toHaveBeenCalledWith({
        where: {
          installationId: "100",
          id: { not: "prior-1" },
          organizationId: null,
          status: "PENDING_CLAIM",
        },
      });
      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: "prior-1" },
        data: expect.objectContaining({
          installationId: "100",
          status: "ACTIVE",
          claimedByUserId: USER_ID,
          senderLogin: "acme",
          senderId: "7",
          pendingNewInstallationId: null,
        }),
        select: { id: true },
      });
      expect(mocks.bulkUpsertInstallationRepositories).toHaveBeenCalledWith(
        expect.anything(),
        "prior-1",
        [REPO_INPUT]
      );
      // ISS-4618: absent repositories are swept through the shared chunked
      // helper, not an inline `id: { in: [...] }` that binds one parameter
      // per removed repository.
      expect(mocks.tombstoneRepositoriesAbsentFrom).toHaveBeenCalledWith(
        expect.anything(),
        "prior-1",
        new Set([REPO_INPUT.githubRepoId])
      );
      // The regular claim path must not also run.
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
    });

    it("fails closed when the reconnect repository walk is incomplete", async () => {
      const mockDb = makeMockDb({ priorUninstalled: PRIOR_SAME_ACCOUNT });
      mockWithDbAll(mockDb);
      mocks.fetchInstallationRepositories.mockResolvedValue({
        ok: false,
        repositories: [REPO_INPUT],
        unavailable: false,
        error: RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial,
      });

      const result = await claim({ getInstallation: foundLookup() });

      expect(result).toEqual({
        status: "error",
        error:
          "GitHub returned an incomplete repository list. Please try reconnecting.",
      });
      expect(
        mocks.persistIncompleteInstallationRepositoryObservation
      ).toHaveBeenCalledWith("prior-1", [REPO_INPUT], false);
      expect(
        mocks.emitRepositoryArtifactRelinkFailedMetric
      ).toHaveBeenCalledWith(
        RepositoryArtifactRelinkFailureStage.OAuthReconnect,
        RepositoryArtifactRelinkFailureReason.RepositoryFetchPartial
      );
      expect(mockDb.gitHubInstallation.update).not.toHaveBeenCalled();
    });

    it("pins the candidate and requires confirmation on a different account", async () => {
      const mockDb = makeMockDb({ priorUninstalled: PRIOR_OTHER_ACCOUNT });
      mockWithDbAll(mockDb);

      const result = await claim({ getInstallation: foundLookup() });

      expect(result).toEqual({
        status: "requires_confirmation",
        priorAccount: { accountId: "999", accountLogin: "legacy-org" },
        newAccount: { accountId: "7", accountLogin: "acme" },
        newInstallationId: "100",
      });
      expect(mockDb.gitHubInstallation.update).toHaveBeenCalledWith({
        where: { id: "prior-1" },
        data: { pendingNewInstallationId: "100" },
        select: { id: true },
      });
      // Nothing is claimed until the admin confirms.
      expect(mockDb.gitHubInstallation.updateMany).not.toHaveBeenCalled();
      expect(mocks.syncRepositories).not.toHaveBeenCalled();
    });
  });
});
