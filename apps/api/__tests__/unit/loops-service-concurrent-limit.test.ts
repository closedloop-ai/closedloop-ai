/**
 * Tests that:
 * - resolveOrgLoopLimit correctly falls back to DEFAULT_MAX_CONCURRENT_LOOPS
 *   for null, missing key, zero, negative, or non-integer values
 * - loopsService.create throws ConcurrentLoopLimitError when active loop count
 *   meets or exceeds the limit
 * - loopsService.create proceeds (calls db.loop.create) when count is below limit
 * - loopsService.createIfNotExists throws ConcurrentLoopLimitError (not returns null)
 *   when at the concurrent limit
 * - isConcurrentLoopLimitError correctly identifies ConcurrentLoopLimitError instances
 *
 * // TOCTOU: count check and insert are not atomic. Two concurrent requests at
 * // count=N-1 can both proceed. Accepted tradeoff — limit is a soft cap, not a
 * // security boundary.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@aws-sdk/client-ecs", () => ({
  ECSClient: vi.fn(),
  RunTaskCommand: vi.fn(),
  StopTaskCommand: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCount = vi.fn().mockResolvedValue(0);
const mockCreate = vi.fn().mockResolvedValue({
  id: "loop-new",
  status: "PENDING",
});
const mockCreateManyAndReturn = vi
  .fn()
  .mockResolvedValue([{ id: "loop-new", status: "PENDING" }]);

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          count: mockCount,
          create: mockCreate,
          createManyAndReturn: mockCreateManyAndReturn,
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        loopEvent: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
      })
    ),
    { tx: vi.fn() }
  ),
  LoopStatus: {
    Pending: "PENDING",
    Claimed: "CLAIMED",
    Running: "RUNNING",
  },
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import {
  type ConcurrentLoopLimitError,
  isConcurrentLoopLimitError,
  loopsService,
  resolveOrgLoopLimit,
} from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Minimal valid CreateLoopRequest for use in tests
// ---------------------------------------------------------------------------

const baseInput = {
  command: "PLAN" as const,
  artifactId: "artifact-1",
  artifactVersion: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveOrgLoopLimit", () => {
  it("returns DEFAULT (5) for null", () => {
    expect(resolveOrgLoopLimit(null)).toBe(5);
  });

  it("returns DEFAULT (5) for empty object (missing key)", () => {
    expect(resolveOrgLoopLimit({})).toBe(5);
  });

  it("returns the configured value when maxConcurrentLoops is a positive integer", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: 25 })).toBe(25);
  });

  it("returns DEFAULT (5) when maxConcurrentLoops is 0", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: 0 })).toBe(5);
  });

  it("returns DEFAULT (5) when maxConcurrentLoops is negative", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: -1 })).toBe(5);
  });

  it("returns DEFAULT (5) when maxConcurrentLoops is a string (non-integer)", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: "25" })).toBe(5);
  });
});

describe("loopsService.create — concurrent loop limit enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws ConcurrentLoopLimitError when active count meets the default limit", async () => {
    mockCount.mockResolvedValue(5);

    let caught: unknown;
    try {
      await loopsService.create("org-1", "user-1", baseInput);
    } catch (err) {
      caught = err;
    }

    expect(isConcurrentLoopLimitError(caught)).toBe(true);
    const limitError = caught as ConcurrentLoopLimitError;
    expect(limitError.limit).toBe(5);
    expect(limitError.activeCount).toBe(5);
  });

  it("does NOT throw when active count is below a custom limit", async () => {
    mockCount.mockResolvedValue(5);

    // Should not throw — 5 active loops is below the limit of 10
    await expect(
      loopsService.create("org-1", "user-1", baseInput, 10)
    ).resolves.toBeDefined();

    // Verify that db.loop.create was actually called (loop was created)
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("loopsService.createIfNotExists — concurrent loop limit enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws ConcurrentLoopLimitError (not returns null) when at the limit", async () => {
    mockCount.mockResolvedValue(5);

    let caught: unknown;
    try {
      await loopsService.createIfNotExists("org-1", "user-1", baseInput);
    } catch (err) {
      caught = err;
    }

    expect(isConcurrentLoopLimitError(caught)).toBe(true);
    const limitError = caught as ConcurrentLoopLimitError;
    expect(limitError.limit).toBe(5);
    expect(limitError.activeCount).toBe(5);
  });
});
