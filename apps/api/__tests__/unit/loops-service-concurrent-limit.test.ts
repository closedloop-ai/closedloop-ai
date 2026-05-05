/**
 * Tests that:
 * - resolveOrgLoopLimit correctly falls back to DEFAULT_MAX_CONCURRENT_LOOPS
 *   for null, missing key, zero, negative, or non-integer values
 * - loopsService.create throws ConcurrentLoopLimitError when active loop count
 *   meets or exceeds the limit
 * - loopsService.create proceeds (calls db.loop.create) when count is below limit
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
const mockFindFirst = vi.fn().mockResolvedValue(null);
const mockOrgFindUnique = vi.fn().mockResolvedValue({ settings: null });
const mockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          count: mockCount,
          create: mockCreate,
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: mockFindFirst,
          findUnique: vi.fn().mockResolvedValue(null),
          updateMany: mockUpdateMany,
        },
        loopEvent: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        organization: {
          findUnique: mockOrgFindUnique,
        },
      })
    ),
    { tx: vi.fn() }
  ),
  LoopStatus: {
    Pending: "PENDING",
    Claimed: "CLAIMED",
    Running: "RUNNING",
    Failed: "FAILED",
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
  isLoopAlreadyActiveError,
  type LoopAlreadyActiveError,
  loopsService,
  resolveOrgLoopLimit,
} from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Minimal valid CreateLoopRequest for use in tests
// ---------------------------------------------------------------------------

const baseInput = {
  command: "PLAN" as const,
  documentId: "artifact-1",
  documentVersion: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveOrgLoopLimit", () => {
  it("returns DEFAULT (10) for null", () => {
    expect(resolveOrgLoopLimit(null)).toBe(10);
  });

  it("returns DEFAULT (10) for empty object (missing key)", () => {
    expect(resolveOrgLoopLimit({})).toBe(10);
  });

  it("returns the configured value when maxConcurrentLoops is a positive integer", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: 25 })).toBe(25);
  });

  it("returns DEFAULT (10) when maxConcurrentLoops is 0", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: 0 })).toBe(10);
  });

  it("returns DEFAULT (10) when maxConcurrentLoops is negative", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: -1 })).toBe(10);
  });

  it("returns DEFAULT (10) when maxConcurrentLoops is a string (non-integer)", () => {
    expect(resolveOrgLoopLimit({ maxConcurrentLoops: "25" })).toBe(10);
  });
});

describe("loopsService.create — concurrent loop limit enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue(null);
    mockUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("throws ConcurrentLoopLimitError when active count meets the default limit", async () => {
    mockCount.mockResolvedValue(10);

    let caught: unknown;
    try {
      await loopsService.create("org-1", "user-1", baseInput);
    } catch (err) {
      caught = err;
    }

    expect(isConcurrentLoopLimitError(caught)).toBe(true);
    const limitError = caught as ConcurrentLoopLimitError;
    expect(limitError.limit).toBe(10);
    expect(limitError.activeCount).toBe(10);
  });

  it("does NOT throw when active count is below a custom org limit", async () => {
    mockCount.mockResolvedValue(5);
    mockOrgFindUnique.mockResolvedValueOnce({
      settings: { maxConcurrentLoops: 10 },
    });

    // Should not throw — 5 active loops is below the org limit of 10
    await expect(
      loopsService.create("org-1", "user-1", baseInput)
    ).resolves.toBeDefined();

    // Verify that db.loop.create was actually called (loop was created)
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("loopsService.create — Chat command exemption from per-document gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: below concurrency limit, no active loop returned
    mockCount.mockResolvedValue(0);
    mockFindFirst.mockResolvedValue(null);
    mockUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("does NOT call db.loop.findFirst (findActiveLoopForDocumentAndCommand) when command is CHAT", async () => {
    const chatInput = {
      command: "CHAT" as const,
      documentId: "artifact-1",
      documentVersion: 1,
    };

    await expect(
      loopsService.create("org-1", "user-1", chatInput)
    ).resolves.toBeDefined();

    // The per-document concurrency gate must be skipped entirely for Chat.
    // findFirst backs findActiveLoopForDocumentAndCommand — it must not be called.
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("creates a Chat loop successfully even when an existing active Chat loop exists on the same document", async () => {
    const existingChatLoop = {
      id: "loop-existing",
      status: "RUNNING",
      command: "CHAT",
      artifactId: "artifact-1",
      organizationId: "org-1",
      userId: "user-2",
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      containerId: "container-abc",
      workstreamId: null,
      parentLoopId: null,
      computeTargetId: null,
      prompt: null,
      repo: null,
      additionalRepos: null,
      contextRefs: null,
      artifactVersion: null,
      metadata: {},
      uploadedArtifacts: null,
      tokensByModel: null,
      tokensInput: 0,
      tokensOutput: 0,
      estimatedCost: null,
      error: null,
      s3StateKey: null,
      prUrl: null,
      prNumber: null,
      branchName: null,
      sessionId: null,
      startedAt: null,
    };

    // Even if findFirst would return an active Chat loop (if queried), the gate is skipped.
    mockFindFirst.mockResolvedValue(existingChatLoop);

    const chatInput = {
      command: "CHAT" as const,
      documentId: "artifact-1",
      documentVersion: 1,
    };

    // Must not throw LoopAlreadyActiveError — Chat is exempt from the gate.
    await expect(
      loopsService.create("org-1", "user-1", chatInput)
    ).resolves.toBeDefined();

    // db.loop.create must have been called — the loop was created.
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // findFirst must not have been called — the gate was skipped.
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P2002 backstop helpers
// ---------------------------------------------------------------------------

/**
 * Simulate a Prisma P2002 unique constraint violation error.
 * The service checks `error instanceof Error && "code" in error && error.code === "P2002"`.
 */
function makePrismaP2002Error(): Error & { code: string } {
  const err = new Error(
    "Unique constraint failed on the fields: (`artifact_id`,`command`)"
  );
  (err as Error & { code: string }).code = "P2002";
  return err as Error & { code: string };
}

/** Minimal Prisma loop record for use in findFirst mock responses. */
const activeLoopRecord = {
  id: "loop-existing",
  status: "RUNNING",
  command: "PLAN",
  artifactId: "artifact-1",
  organizationId: "org-1",
  userId: "user-2",
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
  containerId: "container-abc",
  workstreamId: null,
  parentLoopId: null,
  computeTargetId: null,
  prompt: null,
  repo: null,
  additionalRepos: null,
  contextRefs: null,
  artifactVersion: null,
  metadata: {},
  uploadedArtifacts: null,
  tokensByModel: null,
  tokensInput: 0,
  tokensOutput: 0,
  estimatedCost: null,
  error: null,
  s3StateKey: null,
  prUrl: null,
  prNumber: null,
  branchName: null,
  sessionId: null,
  startedAt: null,
};

describe("loopsService.create — P2002 backstop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCount.mockResolvedValue(0);
    mockFindFirst.mockResolvedValue(null);
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockCreate.mockResolvedValue({ id: "loop-new", status: "PENDING" });
  });

  it("throws LoopAlreadyActiveError when db.loop.create throws P2002 and findActiveLoopForDocumentAndCommand finds an active loop", async () => {
    // Arrange: create throws P2002; first findFirst call (pre-insert gate) returns
    // null; second findFirst call (backstop re-read) returns the active loop.
    mockCreate.mockRejectedValueOnce(makePrismaP2002Error());
    mockFindFirst
      .mockResolvedValueOnce(null) // pre-insert gate: no conflict yet
      .mockResolvedValueOnce(activeLoopRecord); // backstop re-read: conflict found

    let caught: unknown;
    try {
      await loopsService.create("org-1", "user-1", baseInput);
    } catch (err) {
      caught = err;
    }

    expect(isLoopAlreadyActiveError(caught)).toBe(true);
    const loopError = caught as LoopAlreadyActiveError;
    expect(loopError.existingLoopId).toBe(activeLoopRecord.id);
    expect(loopError.existingCommand).toBe(activeLoopRecord.command);
    expect(loopError.existingStatus).toBe(activeLoopRecord.status);
  });

  it("rethrows the original P2002 error when db.loop.create throws P2002 but findActiveLoopForDocumentAndCommand returns null", async () => {
    // Arrange: both findFirst calls return null — no competing loop found either
    // before or after the insert attempt.
    mockCreate.mockRejectedValueOnce(makePrismaP2002Error());
    mockFindFirst.mockResolvedValue(null);

    let caught: unknown;
    try {
      await loopsService.create("org-1", "user-1", baseInput);
    } catch (err) {
      caught = err;
    }

    // Must NOT be a LoopAlreadyActiveError — the raw P2002 is rethrown.
    expect(isLoopAlreadyActiveError(caught)).toBe(false);
    // Must be the original error with code P2002.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("P2002");
  });

  it("rethrows the original error unchanged when db.loop.create throws a non-P2002 error (backstop not triggered)", async () => {
    const originalError = new Error("Connection timed out");

    mockCreate.mockRejectedValueOnce(originalError);
    // pre-insert gate returns null (no conflict before insert)
    mockFindFirst.mockResolvedValue(null);

    let caught: unknown;
    try {
      await loopsService.create("org-1", "user-1", baseInput);
    } catch (err) {
      caught = err;
    }

    // Must be the exact same error object — no wrapping, no substitution.
    expect(caught).toBe(originalError);
    // Must NOT be a LoopAlreadyActiveError.
    expect(isLoopAlreadyActiveError(caught)).toBe(false);
  });
});

describe("loopsService.create — staleness reaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCount.mockResolvedValue(0);
    mockFindFirst.mockResolvedValue(null);
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockCreate.mockResolvedValue({ id: "loop-new", status: "PENDING" });
  });

  it("calls db.loop.updateMany with correct staleness filter for the (artifactId, command) slice", async () => {
    const before = new Date(Date.now() - 30_000);

    await loopsService.create("org-1", "user-1", baseInput);

    // updateMany must have been called at least once (the reaper call)
    expect(mockUpdateMany).toHaveBeenCalled();

    // The first call is the reaper — verify its where clause
    const reaperCall = mockUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    expect(reaperCall.where.artifactId).toBe(baseInput.documentId);
    expect(reaperCall.where.command).toBe(baseInput.command);
    expect(reaperCall.where.status).toBe("PENDING");
    expect(reaperCall.where.containerId).toBeNull();

    // createdAt.lt must be close to 30 seconds ago (within 1 second of tolerance)
    const threshold = (reaperCall.where.createdAt as { lt: Date }).lt;
    expect(threshold).toBeInstanceOf(Date);
    expect(threshold.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(threshold.getTime()).toBeLessThanOrEqual(Date.now() - 29_000);
  });

  it("sets status=FAILED and completedAt in the reaper updateMany data payload", async () => {
    const beforeCall = new Date();

    await loopsService.create("org-1", "user-1", baseInput);

    const reaperCall = mockUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    expect(reaperCall.data.status).toBe("FAILED");
    expect(reaperCall.data.completedAt).toBeInstanceOf(Date);
    expect(
      (reaperCall.data.completedAt as Date).getTime()
    ).toBeGreaterThanOrEqual(beforeCall.getTime());
  });

  it("runs the reaper BEFORE the findActiveLoopForDocumentAndCommand gate check", async () => {
    await loopsService.create("org-1", "user-1", baseInput);

    // Both must have been called
    expect(mockUpdateMany).toHaveBeenCalled();
    expect(mockFindFirst).toHaveBeenCalled();

    // Vitest tracks a global invocation counter — lower order = called first
    const reaperOrder = mockUpdateMany.mock.invocationCallOrder[0];
    const gateOrder = mockFindFirst.mock.invocationCallOrder[0];
    expect(reaperOrder).toBeLessThan(gateOrder);
  });

  it("does NOT call the reaper when documentId is missing", async () => {
    const inputWithoutDocument = {
      command: "PLAN" as const,
      documentId: undefined as unknown as string,
      documentVersion: 1,
    };

    await loopsService.create("org-1", "user-1", inputWithoutDocument);

    // The reaper guard requires both documentId and command — no updateMany call expected
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
