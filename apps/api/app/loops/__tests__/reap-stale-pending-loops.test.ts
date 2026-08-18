/**
 * The one invariant tying `POST /documents/[id]/run-loop`'s request budget to
 * the age at which `reapStalePendingLoops` declares a PENDING row orphaned.
 *
 * Its own file rather than an addition to `loops/__tests__/service.test.ts`,
 * which is shrink-only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDbTx } = vi.hoisted(() => ({ mockWithDbTx: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: mockWithDbTx }),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/github", () => ({ verifyBranchExists: vi.fn() }));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: vi.fn(),
}));

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: {
    getDocumentBranches: vi.fn(),
    getDocumentPullRequests: vi.fn(),
  },
}));

vi.mock("@/lib/loops/uploaded-plan-artifacts", () => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db-utils", async () => {
  const { dbUtilsModuleMock } = await import(
    "../../../__tests__/fixtures/loops-service-mocks"
  );
  return dbUtilsModuleMock();
});

vi.mock("@/lib/loops/loop-state", () => ({
  generateDownloadUrl: vi.fn(),
  validateKeyBelongsToLoop: vi.fn(),
}));

vi.mock("@/lib/loops/loop-blockers", () => ({
  findNonTerminalBlockers: vi.fn().mockResolvedValue([]),
}));

// --- Imports (after mocks) ---

import { withDb } from "@repo/database";
import {
  LAUNCH_REQUEST_BUDGET_MS,
  STALE_PENDING_THRESHOLD_MS,
} from "@/lib/loops/launch-budget";
import { loopsService } from "../service";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;

describe("loopsService.reapStalePendingLoops — slow launch vs retry race", () => {
  /** Pinned so the cutoff is an exact value, not a wall-clock bound. */
  const NOW = new Date("2026-03-01T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Runs the reaper and returns the `createdAt` cutoff it asked the database
   * for. The cutoff is the whole behaviour: rows newer than it are invisible to
   * the reap, rows older than it are marked FAILED.
   */
  async function captureReapCutoff(): Promise<Date> {
    const mockFindMany = vi.fn().mockResolvedValue([]);
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ loop: { findMany: mockFindMany } })
    );

    await loopsService.reapStalePendingLoops("org-1", "artifact-1", "PLAN");

    return mockFindMany.mock.calls[0][0].where.createdAt.lt as Date;
  }

  it("cannot reap a launch that is still inside the request budget", async () => {
    // The race this closes: `POST /documents/[id]/run-loop` awaits its dispatch
    // for up to `LAUNCH_REQUEST_BUDGET_SECONDS`, and the row is legitimately
    // PENDING that whole time. This reaper runs on every `loopsService.create`
    // for the same (artifactId, command), so a retry from a second tab used to
    // mark the in-flight launch FAILED — and when its dispatch landed,
    // `claimOrPersistRunning` could not go FAILED → CLAIMED, so
    // `cleanupOnLaunchFailure` tore down work the provider had already taken.
    const cutoff = await captureReapCutoff();

    expect(cutoff).toEqual(
      new Date(NOW.getTime() - STALE_PENDING_THRESHOLD_MS)
    );

    // A 59s-old launch — slow, but still within budget and still in flight — is
    // newer than the cutoff, so the query cannot select it.
    const slowLaunchCreatedAt = new Date(NOW.getTime() - 59_000);
    expect(slowLaunchCreatedAt.getTime()).toBeGreaterThan(cutoff.getTime());

    // And the boundary itself: the oldest row the reap can ignore is one that
    // is exactly the request budget old.
    const atBudgetCreatedAt = new Date(
      NOW.getTime() - LAUNCH_REQUEST_BUDGET_MS
    );
    expect(atBudgetCreatedAt.getTime()).toBeGreaterThan(cutoff.getTime());
  });

  it("still reaps a genuinely orphaned row past the threshold", async () => {
    // Positive control on the same predicate: without it, a cutoff pushed
    // arbitrarily far into the past (or a reaper that selected nothing at all)
    // would satisfy the assertion above while never reaping anything.
    const cutoff = await captureReapCutoff();

    const orphanCreatedAt = new Date(
      NOW.getTime() - (STALE_PENDING_THRESHOLD_MS + 30_000)
    );
    expect(orphanCreatedAt.getTime()).toBeLessThan(cutoff.getTime());
  });
});
