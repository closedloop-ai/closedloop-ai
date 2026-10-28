import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/github/github-repo-sync-state", () => ({
  selectUnbootstrappedOrgIds: vi.fn(),
  reconcileOrgRepoSyncStates: vi.fn(),
  markOrgRepoSyncBootstrapAttempt: vi.fn(),
}));

// The observed-repository verification pass runs in front of the bootstrap
// loop. These cases are about the bootstrap loop, so the phase is stubbed to a
// quiet result rather than exercised here; `verify-phase.test.ts` owns it.
vi.mock("../verify-phase", () => ({
  runObservedRepositoryVerification: vi.fn(),
}));

import { log } from "@repo/observability/log";
import {
  markOrgRepoSyncBootstrapAttempt,
  reconcileOrgRepoSyncStates,
  selectUnbootstrappedOrgIds,
} from "@/lib/github/github-repo-sync-state";
import {
  BOOTSTRAP_DEADLINE_MS,
  BOOTSTRAP_ORG_BATCH,
  BOOTSTRAP_ORG_WARN_REPOS,
  githubRepoSyncStateBootstrapService,
} from "../service";
import { runObservedRepositoryVerification } from "../verify-phase";

const mockVerifyPhase =
  runObservedRepositoryVerification as unknown as ReturnType<typeof vi.fn>;

const QUIET_VERIFICATION = {
  orgsSelected: 0,
  orgsFailed: 0,
  orgsReconciled: 0,
  repositoriesAttempted: 0,
  repositoriesVerified: 0,
  repositoriesDenied: 0,
  repositoriesDeferred: 0,
  stoppedOnDeadline: false,
};

const mockSelectUnbootstrapped = selectUnbootstrappedOrgIds as ReturnType<
  typeof vi.fn
>;
const mockReconcile = reconcileOrgRepoSyncStates as unknown as ReturnType<
  typeof vi.fn
>;
const mockMarkAttempt =
  markOrgRepoSyncBootstrapAttempt as unknown as ReturnType<typeof vi.fn>;

function pass(repoCount: number, failedRepoCount = 0) {
  return {
    repoCount,
    failedRepoCount,
    settled: failedRepoCount === 0 && repoCount > 0,
  };
}

const NOW = new Date("2026-08-14T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mockVerifyPhase.mockResolvedValue(QUIET_VERIFICATION);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("githubRepoSyncStateBootstrapService", () => {
  it("bootstraps an org with ACTIVE installation repos and zero sync-state rows (AC)", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-1"]);
    mockReconcile.mockResolvedValue(pass(3));

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsSelected).toBe(1);
    expect(summary.orgsBootstrapped).toBe(1);
    expect(summary.reposMaterialized).toBe(3);
    expect(summary.orgsFailed).toBe(0);
    expect(summary.stoppedOnDeadline).toBe(false);
    expect(mockReconcile).toHaveBeenCalledWith("org-1", { now: NOW });
  });

  it("selects projection-only orgs (no installation, PR rows with non-null repositoryFullName)", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-proj"]);
    mockReconcile.mockResolvedValue(pass(2));

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsBootstrapped).toBe(1);
    expect(summary.reposMaterialized).toBe(2);
    expect(mockSelectUnbootstrapped).toHaveBeenCalledWith(BOOTSTRAP_ORG_BATCH);
  });

  it("returns a well-formed summary when no unbootstrapped orgs exist", async () => {
    mockSelectUnbootstrapped.mockResolvedValue([]);

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary).toEqual({
      orgsSelected: 0,
      orgsBootstrapped: 0,
      orgsPartial: 0,
      orgsFailed: 0,
      reposMaterialized: 0,
      reposFailed: 0,
      stoppedOnDeadline: false,
      // The verification pass reports as its own object because it selects its
      // own orgs on its own recurring predicate; folding it into the counters
      // above would make `orgsSelected` name two different populations at once.
      observedRepositoryVerification: QUIET_VERIFICATION,
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("verifies observed repositories before selecting orgs to bootstrap", async () => {
    // Order is kept so both lanes share the route's tick-level deadline and
    // summary contract.
    mockSelectUnbootstrapped.mockResolvedValue([]);

    await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(mockVerifyPhase).toHaveBeenCalledWith({ now: NOW });
    expect(mockVerifyPhase.mock.invocationCallOrder[0] as number).toBeLessThan(
      mockSelectUnbootstrapped.mock.invocationCallOrder[0] as number
    );
  });

  it("reports the verification pass verbatim rather than re-deriving it", async () => {
    mockSelectUnbootstrapped.mockResolvedValue([]);
    const verification = {
      ...QUIET_VERIFICATION,
      orgsSelected: 3,
      orgsReconciled: 2,
      repositoriesAttempted: 12,
      repositoriesVerified: 5,
      repositoriesDenied: 2,
      repositoriesDeferred: 5,
    };
    mockVerifyPhase.mockResolvedValue(verification);

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.observedRepositoryVerification).toEqual(verification);
    // The verify phase is a separate population; it must not move the bootstrap
    // loop's own counters.
    expect(summary.orgsSelected).toBe(0);
  });

  it("isolates per-org failures without aborting the batch", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-1", "org-2", "org-3"]);
    mockReconcile
      .mockResolvedValueOnce(pass(2))
      .mockRejectedValueOnce(new Error("db timeout"))
      .mockResolvedValueOnce(pass(4));

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsBootstrapped).toBe(2);
    expect(summary.orgsFailed).toBe(1);
    expect(summary.reposMaterialized).toBe(6);
    expect(mockReconcile).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("org bootstrap failed"),
      expect.objectContaining({ organizationId: "org-2" })
    );
  });

  it("stops on deadline and reports stoppedOnDeadline", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-1", "org-2", "org-3"]);
    mockReconcile.mockImplementation(() => {
      vi.advanceTimersByTime(BOOTSTRAP_DEADLINE_MS);
      return Promise.resolve(pass(1));
    });

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.stoppedOnDeadline).toBe(true);
    expect(summary.orgsBootstrapped).toBe(1);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it("warns when a single org exceeds the repo threshold", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-large"]);
    mockReconcile.mockResolvedValue(pass(BOOTSTRAP_ORG_WARN_REPOS + 1));

    await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("large org bootstrapped"),
      expect.objectContaining({
        organizationId: "org-large",
        repoCount: BOOTSTRAP_ORG_WARN_REPOS + 1,
      })
    );
  });

  it("does not warn when repo count is at or below the threshold", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-normal"]);
    mockReconcile.mockResolvedValue(pass(BOOTSTRAP_ORG_WARN_REPOS));

    await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("claims the org before reconciling so a mid-org kill cannot re-head the batch (ISS-6590)", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-1"]);
    mockReconcile.mockResolvedValue(pass(2));

    await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(mockMarkAttempt).toHaveBeenCalledWith("org-1", NOW);
    expect(mockMarkAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mockReconcile.mock.invocationCallOrder[0] as number
    );
  });

  it("counts a pass that left repos unwritten as partial, not bootstrapped (ISS-6590)", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-partial", "org-clean"]);
    mockReconcile
      .mockResolvedValueOnce(pass(10, 3))
      .mockResolvedValueOnce(pass(4));

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsPartial).toBe(1);
    expect(summary.orgsBootstrapped).toBe(1);
    expect(summary.orgsFailed).toBe(0);
    // Only the rows that actually landed count as materialized; the rest are
    // reported rather than dropped.
    expect(summary.reposMaterialized).toBe(11);
    expect(summary.reposFailed).toBe(3);
  });

  it("does not warn about a large org whose pass was only partial (ISS-6590)", async () => {
    // The reconciler already warns with the failed-repo detail; a "bootstrapped"
    // line here would assert a completion the marker was withheld for.
    mockSelectUnbootstrapped.mockResolvedValue(["org-large"]);
    mockReconcile.mockResolvedValue(pass(BOOTSTRAP_ORG_WARN_REPOS + 1, 1));

    await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("counts an unsettled zero-candidate pass as partial, never bootstrapped (ISS-6590)", async () => {
    // The reconciler withholds the marker when it derives no repos, so calling
    // it bootstrapped would report a completion the database never recorded.
    mockSelectUnbootstrapped.mockResolvedValue(["org-raced"]);
    mockReconcile.mockResolvedValue(pass(0));

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsBootstrapped).toBe(0);
    expect(summary.orgsPartial).toBe(1);
    expect(summary.reposMaterialized).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("derived no candidate repos"),
      expect.objectContaining({ organizationId: "org-raced" })
    );
  });

  it("records the org as failed, and skips its pass, when the attempt claim itself throws", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-1"]);
    mockMarkAttempt.mockRejectedValueOnce(new Error("db down"));

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsFailed).toBe(1);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("handles empty selection gracefully (selector excludes ineligible orgs)", async () => {
    mockSelectUnbootstrapped.mockResolvedValue([]);

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsSelected).toBe(0);
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
