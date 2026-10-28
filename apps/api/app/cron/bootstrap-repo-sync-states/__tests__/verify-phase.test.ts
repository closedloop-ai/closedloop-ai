import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/github/github-repo-sync-state", () => ({
  markOrgRepoSyncBootstrapStale: vi.fn(),
  reconcileOrgRepoSyncStatesBestEffort: vi.fn(),
}));

vi.mock("@/lib/github/observed-repository-discovery", () => ({
  selectOrgIdsWithDueObservedRepositories: vi.fn(),
  VERIFY_ORG_BATCH: 10,
}));

vi.mock("@/lib/github/observed-repository-verifier", () => ({
  verifyObservedRepositories: vi.fn(),
}));

import { log } from "@repo/observability/log";
import {
  markOrgRepoSyncBootstrapStale,
  reconcileOrgRepoSyncStatesBestEffort,
} from "@/lib/github/github-repo-sync-state";
import {
  selectOrgIdsWithDueObservedRepositories,
  VERIFY_ORG_BATCH,
} from "@/lib/github/observed-repository-discovery";
import { verifyObservedRepositories } from "@/lib/github/observed-repository-verifier";
import {
  runObservedRepositoryVerification,
  VERIFY_DEADLINE_MS,
} from "../verify-phase";

const mockSelectOrgs =
  selectOrgIdsWithDueObservedRepositories as unknown as ReturnType<
    typeof vi.fn
  >;
const mockVerify = verifyObservedRepositories as unknown as ReturnType<
  typeof vi.fn
>;
const mockReconcile =
  reconcileOrgRepoSyncStatesBestEffort as unknown as ReturnType<typeof vi.fn>;
const mockMarkStale = markOrgRepoSyncBootstrapStale as unknown as ReturnType<
  typeof vi.fn
>;

const NOW = new Date("2026-08-21T12:00:00.000Z");

function summary(
  overrides: Partial<{
    attempted: number;
    verified: number;
    denied: number;
    deferred: number;
  }> = {}
) {
  return { attempted: 0, verified: 0, denied: 0, deferred: 0, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mockSelectOrgs.mockReset();
  mockVerify.mockReset();
  mockReconcile.mockReset();
  mockMarkStale.mockReset();
  mockSelectOrgs.mockResolvedValue([]);
  mockVerify.mockResolvedValue(summary());
  mockReconcile.mockResolvedValue(undefined);
  mockMarkStale.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runObservedRepositoryVerification", () => {
  it("verifies each selected org against the tick's pinned clock", async () => {
    mockSelectOrgs.mockResolvedValue(["org-1", "org-2"]);
    mockVerify.mockResolvedValue(summary({ attempted: 3, deferred: 3 }));

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(mockSelectOrgs).toHaveBeenCalledWith(VERIFY_ORG_BATCH, NOW);
    expect(mockVerify).toHaveBeenCalledWith(
      { organizationId: "org-1" },
      { now: NOW }
    );
    expect(result.orgsSelected).toBe(2);
    expect(result.repositoriesAttempted).toBe(6);
    expect(result.repositoriesDeferred).toBe(6);
  });

  it("re-tiers an org that gained a verified repository, so targeted sync can queue it", async () => {
    mockSelectOrgs.mockResolvedValue(["org-1"]);
    mockVerify.mockResolvedValue(summary({ attempted: 2, verified: 2 }));

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(mockReconcile).toHaveBeenCalledWith("org-1", { now: NOW });
    expect(result.orgsReconciled).toBe(1);
    expect(result.repositoriesVerified).toBe(2);
  });

  it("un-settles the org before the best-effort re-tier, so a missed pass heals", async () => {
    mockSelectOrgs.mockResolvedValue(["org-1"]);
    mockVerify.mockResolvedValue(summary({ attempted: 1, verified: 1 }));

    await runObservedRepositoryVerification({ now: NOW });

    expect(mockMarkStale).toHaveBeenCalledOnce();
    expect(mockMarkStale).toHaveBeenCalledWith("org-1");
    expect(mockReconcile).toHaveBeenCalledOnce();
    expect(mockMarkStale.mock.invocationCallOrder[0] as number).toBeLessThan(
      mockReconcile.mock.invocationCallOrder[0] as number
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("re-tiers after a failed marker clear, retries the clear afterward, and keeps verification successful", async () => {
    mockSelectOrgs.mockResolvedValue(["org-1"]);
    mockVerify.mockResolvedValue(summary({ attempted: 1, verified: 1 }));
    mockMarkStale
      .mockRejectedValueOnce(new Error("marker write timed out"))
      .mockResolvedValueOnce(undefined);

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(result).toMatchObject({
      orgsFailed: 0,
      orgsReconciled: 1,
      repositoriesVerified: 1,
    });
    expect(mockMarkStale).toHaveBeenCalledTimes(2);
    expect(mockReconcile).toHaveBeenCalledWith("org-1", { now: NOW });
    expect(mockMarkStale.mock.invocationCallOrder[0] as number).toBeLessThan(
      mockReconcile.mock.invocationCallOrder[0] as number
    );
    expect(mockReconcile.mock.invocationCallOrder[0] as number).toBeLessThan(
      mockMarkStale.mock.invocationCallOrder[1] as number
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a marker clear that fails twice and continues with the next org", async () => {
    mockSelectOrgs.mockResolvedValue(["org-bad-marker", "org-good"]);
    mockVerify.mockResolvedValue(summary({ attempted: 1, verified: 1 }));
    mockMarkStale
      .mockRejectedValueOnce(new Error("first marker failure"))
      .mockRejectedValueOnce(new Error("retry marker failure"))
      .mockResolvedValueOnce(undefined);

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(result).toMatchObject({
      orgsFailed: 0,
      orgsReconciled: 2,
      repositoriesVerified: 2,
    });
    expect(mockVerify).toHaveBeenCalledTimes(2);
    expect(mockReconcile).toHaveBeenCalledWith("org-bad-marker", { now: NOW });
    expect(mockReconcile).toHaveBeenCalledWith("org-good", { now: NOW });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("bootstrap marker clear failed after re-tier"),
      {
        organizationId: "org-bad-marker",
        error: "retry marker failure",
      }
    );
  });

  it("does not re-tier an org whose pass verified nothing", async () => {
    mockSelectOrgs.mockResolvedValue(["org-1"]);
    mockVerify.mockResolvedValue(
      summary({ attempted: 3, denied: 1, deferred: 2 })
    );

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(mockReconcile).not.toHaveBeenCalled();
    expect(result.orgsReconciled).toBe(0);
    expect(result.repositoriesDenied).toBe(1);
    expect(result.repositoriesDeferred).toBe(2);
  });

  it("isolates a throwing org so the rest of the batch still runs", async () => {
    mockSelectOrgs.mockResolvedValue(["org-bad", "org-good"]);
    mockVerify
      .mockRejectedValueOnce(new Error("pool acquire timeout"))
      .mockResolvedValueOnce(summary({ attempted: 1, verified: 1 }));

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(result.orgsFailed).toBe(1);
    expect(result.repositoriesVerified).toBe(1);
    expect(mockReconcile).toHaveBeenCalledWith("org-good", { now: NOW });
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("org verification failed"),
      expect.objectContaining({ organizationId: "org-bad" })
    );
  });

  it("stops on its own deadline, leaving budget for the bootstrap pass behind it", async () => {
    mockSelectOrgs.mockResolvedValue(["org-1", "org-2", "org-3"]);
    mockVerify.mockImplementation(() => {
      vi.advanceTimersByTime(VERIFY_DEADLINE_MS);
      return Promise.resolve(summary({ attempted: 1, deferred: 1 }));
    });

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(result.stoppedOnDeadline).toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it("checks its deadline after a verifier rejection instead of continuing past the budget", async () => {
    mockSelectOrgs.mockResolvedValue(["org-slow", "org-next"]);
    mockVerify.mockImplementation(() => {
      vi.advanceTimersByTime(VERIFY_DEADLINE_MS);
      return Promise.reject(new Error("verification timed out"));
    });

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(result.orgsFailed).toBe(1);
    expect(result.stoppedOnDeadline).toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it("returns a quiet summary and draws nothing when no org has due work", async () => {
    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(result).toEqual({
      orgsSelected: 0,
      orgsFailed: 0,
      orgsReconciled: 0,
      repositoriesAttempted: 0,
      repositoriesVerified: 0,
      repositoriesDenied: 0,
      repositoriesDeferred: 0,
      stoppedOnDeadline: false,
    });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("survives a failing due-org selector, so the bootstrap pass behind it still runs", async () => {
    // This phase is the FIRST statement of the bootstrap service. A rejection
    // that escapes it returns 500 before `selectUnbootstrappedOrgIds` is ever
    // reached, letting the M0 observation table — whose scan this read cannot
    // index — take down the older lane for the whole tick.
    mockSelectOrgs.mockRejectedValue(
      new Error("canceling statement due to statement timeout")
    );

    const result = await runObservedRepositoryVerification({ now: NOW });

    expect(result.orgsSelected).toBe(0);
    expect(result.stoppedOnDeadline).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("due-org selection failed"),
      expect.objectContaining({
        error: "canceling statement due to statement timeout",
      })
    );
  });
});
