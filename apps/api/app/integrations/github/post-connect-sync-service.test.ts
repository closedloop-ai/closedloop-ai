import { beforeEach, describe, expect, it, vi } from "vitest";

const claimOrganizationRunMock = vi.fn();
const releaseOrganizationRunMock = vi.fn();
const verifyObservedRepositoriesMock = vi.fn();
const clearPendingVerificationBackoffMock = vi.fn();
const markOrgRepoSyncBootstrapStaleMock = vi.fn();
const reconcileOrgRepoSyncStatesBestEffortMock = vi.fn();
const runForOrganizationMock = vi.fn();
const logErrorMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock("@repo/observability/log", () => ({
  log: {
    error: logErrorMock,
    warn: logWarnMock,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/organization-run-gate", () => ({
  claimOrganizationRun: claimOrganizationRunMock,
  releaseOrganizationRun: releaseOrganizationRunMock,
}));

vi.mock("@/lib/github/observed-repository-verifier", () => ({
  verifyObservedRepositories: verifyObservedRepositoriesMock,
  clearPendingVerificationBackoff: clearPendingVerificationBackoffMock,
}));

vi.mock("@/lib/github/github-repo-sync-state", () => ({
  markOrgRepoSyncBootstrapStale: markOrgRepoSyncBootstrapStaleMock,
  reconcileOrgRepoSyncStatesBestEffort:
    reconcileOrgRepoSyncStatesBestEffortMock,
}));

vi.mock("@/app/cron/reconcile-pull-requests/service", () => ({
  githubPullRequestReconcilerService: {
    runForOrganization: runForOrganizationMock,
  },
}));

const { POST_CONNECT_REPO_LIMIT, runPostConnectObservedSync } = await import(
  "./post-connect-sync-service"
);

const ORGANIZATION_ID = "org-1";
const NOW = new Date("2026-08-25T10:00:00Z");

function verification(verified: number) {
  return { attempted: verified + 1, verified, denied: 1, deferred: 0 };
}

function sweep(overrides: Record<string, number> = {}) {
  return {
    reposSelected: 2,
    reposSwept: 2,
    reposDeferredBudget: 0,
    reposReclassified: 0,
    reposFailed: 0,
    reposRemaining: 0,
    pullRequestsWritten: 7,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  claimOrganizationRunMock.mockResolvedValue({ claimed: true });
  releaseOrganizationRunMock.mockResolvedValue(undefined);
  verifyObservedRepositoriesMock.mockResolvedValue(verification(1));
  clearPendingVerificationBackoffMock.mockResolvedValue(0);
  markOrgRepoSyncBootstrapStaleMock.mockResolvedValue(undefined);
  reconcileOrgRepoSyncStatesBestEffortMock.mockResolvedValue(undefined);
  runForOrganizationMock.mockResolvedValue(sweep());
});

describe("runPostConnectObservedSync", () => {
  it("verifies, queues targeted sync, reconciles the ladder, then sweeps that org's repos", async () => {
    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    expect(verifyObservedRepositoriesMock).toHaveBeenCalledWith(
      { organizationId: ORGANIZATION_ID },
      { now: NOW }
    );
    expect(markOrgRepoSyncBootstrapStaleMock).toHaveBeenCalledWith(
      ORGANIZATION_ID
    );
    expect(reconcileOrgRepoSyncStatesBestEffortMock).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      { now: NOW }
    );
    expect(runForOrganizationMock).toHaveBeenCalledWith(ORGANIZATION_ID, {
      limit: POST_CONNECT_REPO_LIMIT,
      now: NOW,
    });
    // Order is load-bearing: newly verified observed rows are converted into
    // repo-sync state before the org's due repos are swept.
    expect(
      markOrgRepoSyncBootstrapStaleMock.mock.invocationCallOrder[0]
    ).toBeLessThan(
      reconcileOrgRepoSyncStatesBestEffortMock.mock.invocationCallOrder[0] ?? 0
    );
    expect(
      reconcileOrgRepoSyncStatesBestEffortMock.mock.invocationCallOrder[0]
    ).toBeLessThan(runForOrganizationMock.mock.invocationCallOrder[0] ?? 0);
    expect(summary).toMatchObject({
      claimed: true,
      failed: false,
      repositoriesVerified: 1,
      reposSwept: 2,
      pullRequestsWritten: 7,
    });
  });

  it("reports the repos the bound left for the cron", async () => {
    runForOrganizationMock.mockResolvedValue(
      sweep({ reposSelected: 5, reposSwept: 5, reposRemaining: 12 })
    );

    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    expect(summary.reposRemaining).toBe(12);
  });

  it("reconciles the ladder even when this pass verified nothing new", async () => {
    verifyObservedRepositoriesMock.mockResolvedValue(verification(0));

    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    // A connect changes the credential ladder for every repo the org has, so the
    // reconcile runs regardless. Un-settling is earned only by a newly verified
    // observed row.
    expect(markOrgRepoSyncBootstrapStaleMock).not.toHaveBeenCalled();
    expect(reconcileOrgRepoSyncStatesBestEffortMock).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      { now: NOW }
    );
    expect(runForOrganizationMock).toHaveBeenCalledTimes(1);
    expect(summary.claimed).toBe(true);
  });

  it("re-opens the verification backoff before verifying, not after", async () => {
    await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    // A cron pass that could not draw a credential parks every pending row
    // behind a 6h horizon. This org just replaced that credential, so clearing
    // the horizon AFTER the verify would leave a reconnect verifying nothing.
    expect(clearPendingVerificationBackoffMock).toHaveBeenCalledWith(
      ORGANIZATION_ID
    );
    expect(
      clearPendingVerificationBackoffMock.mock.invocationCallOrder[0]
    ).toBeLessThan(
      verifyObservedRepositoriesMock.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("still verifies and sweeps when re-opening the backoff fails", async () => {
    clearPendingVerificationBackoffMock.mockRejectedValue(
      new Error("settings write")
    );

    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    // Clearing the horizon widens what this pass can see; losing it costs the
    // reconnect some rows, and must not cost the org the whole pass.
    expect(verifyObservedRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(runForOrganizationMock).toHaveBeenCalledTimes(1);
    expect(summary.failed).toBe(false);
    expect(logWarnMock).toHaveBeenCalled();
  });

  it("does no work and takes no credential when the gate refuses the claim", async () => {
    claimOrganizationRunMock.mockResolvedValue({
      claimed: false,
      settings: {},
      blockedUntil: NOW.getTime() + 1000,
    });

    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    expect(clearPendingVerificationBackoffMock).not.toHaveBeenCalled();
    expect(verifyObservedRepositoriesMock).not.toHaveBeenCalled();
    expect(reconcileOrgRepoSyncStatesBestEffortMock).not.toHaveBeenCalled();
    expect(runForOrganizationMock).not.toHaveBeenCalled();
    expect(releaseOrganizationRunMock).not.toHaveBeenCalled();
    expect(summary.claimed).toBe(false);
    expect(summary.failed).toBe(false);
    // No sweep ran, so the eligible population was never counted. A 0 here would
    // report full coverage of a number nobody took.
    expect(summary.reposRemaining).toBeNull();
  });

  it("releases the gate and resolves when a step of the chain throws", async () => {
    verifyObservedRepositoriesMock.mockRejectedValue(new Error("pool down"));

    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    // It runs inside `waitUntil`, where a rejection is nobody's to catch. The
    // lane WAS taken, so the summary says so: reporting `claimed: false` here
    // would read as gate contention and hide that a run failed partway.
    expect(summary.claimed).toBe(true);
    expect(summary.failed).toBe(true);
    expect(releaseOrganizationRunMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("reports an unclaimed lane when the claim itself fails", async () => {
    claimOrganizationRunMock.mockRejectedValue(new Error("settings read"));

    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    // Nothing was taken and nothing ran, so the zeroed counts are the truth.
    expect(summary.claimed).toBe(false);
    expect(summary.failed).toBe(false);
    expect(verifyObservedRepositoriesMock).not.toHaveBeenCalled();
    expect(releaseOrganizationRunMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("swallows a failed release rather than replacing the run's own outcome", async () => {
    releaseOrganizationRunMock.mockRejectedValue(new Error("settings write"));

    const summary = await runPostConnectObservedSync({
      organizationId: ORGANIZATION_ID,
      now: NOW,
    });

    expect(summary.claimed).toBe(true);
    expect(summary.failed).toBe(false);
    expect(logWarnMock).toHaveBeenCalled();
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});
