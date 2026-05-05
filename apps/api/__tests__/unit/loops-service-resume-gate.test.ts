/**
 * T-6.5 — Resume gate: sibling concurrency check in loopsService.resume
 *
 * Verifies that loopsService.resume:
 *   a. throws LoopAlreadyActiveError when an active sibling loop exists for the
 *      same (artifactId, command) pair (and is NOT the parent itself)
 *   b. does NOT throw when no active sibling exists
 *   c. does NOT throw when the only active loop found IS the parent itself
 *      (the exclusion guard `activeLoop.id !== parent.id` must pass through)
 *
 * The resume method first fetches the parent loop via db.loop.findUnique, then
 * checks the sibling gate via findActiveLoopForDocumentAndCommand (backed by
 * db.loop.findFirst), and finally creates the child loop via db.loop.create.
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
  verifyInstallationBranchExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockFindUnique = vi.fn();
const mockFindFirst = vi.fn().mockResolvedValue(null);
const mockCount = vi.fn().mockResolvedValue(0);
const mockCreate = vi.fn().mockResolvedValue({
  id: "loop-child",
  status: "PENDING",
});
const mockOrgFindUnique = vi.fn().mockResolvedValue({ settings: null });

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          findUnique: mockFindUnique,
          findFirst: mockFindFirst,
          count: mockCount,
          create: mockCreate,
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
    Completed: "COMPLETED",
    Failed: "FAILED",
    Cancelled: "CANCELLED",
    TimedOut: "TIMED_OUT",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
  Prisma: { sql: vi.fn(), join: vi.fn() },
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

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: { getDocumentPullRequests: vi.fn() },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import {
  isLoopAlreadyActiveError,
  type LoopAlreadyActiveError,
  loopsService,
} from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal PrismaLoop record for the parent — already in a terminal state. */
const parentLoopRecord = {
  id: "loop-parent",
  organizationId: "org-1",
  userId: "user-1",
  status: "COMPLETED",
  command: "PLAN",
  artifactId: "artifact-1",
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
  containerId: null,
  startedAt: null,
  completedAt: new Date("2026-02-25T01:00:00Z"),
  createdAt: new Date("2026-02-25T00:00:00Z"),
  updatedAt: new Date("2026-02-25T01:00:00Z"),
};

/** A sibling loop record that is actively RUNNING (a different loop, same artifact+command). */
const siblingLoopRecord = {
  id: "loop-sibling",
  organizationId: "org-1",
  userId: "user-2",
  status: "RUNNING",
  command: "PLAN",
  artifactId: "artifact-1",
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
  containerId: "container-abc",
  startedAt: new Date("2026-02-25T00:30:00Z"),
  completedAt: null,
  createdAt: new Date("2026-02-25T00:30:00Z"),
  updatedAt: new Date("2026-02-25T00:30:00Z"),
};

/** Minimal ResumeLoopRequest input. */
const resumeInput = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loopsService.resume — sibling concurrency gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindUnique.mockResolvedValue({ settings: null });
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({ id: "loop-child", status: "PENDING" });
    mockFindFirst.mockResolvedValue(null);
    // Default: parent loop is found
    mockFindUnique.mockResolvedValue(parentLoopRecord);
  });

  it("(a) throws LoopAlreadyActiveError when an active sibling exists for the same (artifactId, command)", async () => {
    // Arrange: findFirst returns a different active loop (not the parent)
    mockFindFirst.mockResolvedValue(siblingLoopRecord);

    let caught: unknown;
    try {
      await loopsService.resume(
        parentLoopRecord.id,
        "org-1",
        "user-1",
        resumeInput
      );
    } catch (err) {
      caught = err;
    }

    expect(isLoopAlreadyActiveError(caught)).toBe(true);
    const loopError = caught as LoopAlreadyActiveError;
    expect(loopError.existingLoopId).toBe(siblingLoopRecord.id);
    expect(loopError.existingCommand).toBe(siblingLoopRecord.command);
    expect(loopError.existingStatus).toBe(siblingLoopRecord.status);
  });

  it("(b) does NOT throw when no active sibling exists — proceeds to create the child loop", async () => {
    // Arrange: findFirst returns null — no active loop for this (artifactId, command)
    mockFindFirst.mockResolvedValue(null);

    await expect(
      loopsService.resume(parentLoopRecord.id, "org-1", "user-1", resumeInput)
    ).resolves.toEqual({
      loopId: "loop-child",
      status: "PENDING",
    });

    // db.loop.create must be called — the child loop was created
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("(c) does NOT throw when the only active loop found IS the parent itself (exclusion guard)", async () => {
    // Arrange: findFirst returns the parent loop record itself.
    // The gate condition is `activeLoop != null && activeLoop.id !== parent.id`,
    // so when activeLoop.id === parent.id the gate must NOT throw.
    mockFindFirst.mockResolvedValue(parentLoopRecord);

    await expect(
      loopsService.resume(parentLoopRecord.id, "org-1", "user-1", resumeInput)
    ).resolves.toEqual({
      loopId: "loop-child",
      status: "PENDING",
    });

    // db.loop.create must still have been called
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("calls findActiveLoopForDocumentAndCommand (db.loop.findFirst) with the parent artifactId and command", async () => {
    mockFindFirst.mockResolvedValue(null);

    await loopsService.resume(
      parentLoopRecord.id,
      "org-1",
      "user-1",
      resumeInput
    );

    // findFirst must have been called — it backs findActiveLoopForDocumentAndCommand
    expect(mockFindFirst).toHaveBeenCalled();

    // Verify the where clause targets the correct (artifactId, command)
    const whereArg = (
      mockFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }
    ).where;
    expect(whereArg.artifactId).toBe(parentLoopRecord.artifactId);
    expect(whereArg.command).toBe(parentLoopRecord.command);
  });
});
