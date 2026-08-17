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
}));

import { log } from "@repo/observability/log";
import {
  reconcileOrgRepoSyncStates,
  selectUnbootstrappedOrgIds,
} from "@/lib/github/github-repo-sync-state";
import {
  BOOTSTRAP_DEADLINE_MS,
  BOOTSTRAP_ORG_BATCH,
  BOOTSTRAP_ORG_WARN_REPOS,
  githubRepoSyncStateBootstrapService,
} from "../service";

const mockSelectUnbootstrapped = selectUnbootstrappedOrgIds as ReturnType<
  typeof vi.fn
>;
const mockReconcile = reconcileOrgRepoSyncStates as unknown as ReturnType<
  typeof vi.fn
>;

const NOW = new Date("2026-08-14T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("githubRepoSyncStateBootstrapService", () => {
  it("bootstraps an org with ACTIVE installation repos and zero sync-state rows (AC)", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-1"]);
    mockReconcile.mockResolvedValue(3);

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
    mockReconcile.mockResolvedValue(2);

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
      orgsFailed: 0,
      reposMaterialized: 0,
      stoppedOnDeadline: false,
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("isolates per-org failures without aborting the batch", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-1", "org-2", "org-3"]);
    mockReconcile
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(new Error("db timeout"))
      .mockResolvedValueOnce(4);

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
      return Promise.resolve(1);
    });

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.stoppedOnDeadline).toBe(true);
    expect(summary.orgsBootstrapped).toBe(1);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it("warns when a single org exceeds the repo threshold", async () => {
    mockSelectUnbootstrapped.mockResolvedValue(["org-large"]);
    mockReconcile.mockResolvedValue(BOOTSTRAP_ORG_WARN_REPOS + 1);

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
    mockReconcile.mockResolvedValue(BOOTSTRAP_ORG_WARN_REPOS);

    await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("handles empty selection gracefully (selector excludes ineligible orgs)", async () => {
    mockSelectUnbootstrapped.mockResolvedValue([]);

    const summary = await githubRepoSyncStateBootstrapService.run({ now: NOW });

    expect(summary.orgsSelected).toBe(0);
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
