/**
 * Tests that:
 * - toLoopWithUser maps computeTarget fields correctly when present and when null
 * - findAll builds a projectId filter that joins through artifact.projectId
 * - findAll includes computeTarget relation in the query
 *
 * Uses vi.mock to replace withDb with a fake that captures Prisma query args.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const mockFindMany = vi.fn().mockResolvedValue([]);
const mockFindUnique = vi.fn().mockResolvedValue(null);

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          findMany: mockFindMany,
          findUnique: mockFindUnique,
          count: vi.fn().mockResolvedValue(0),
          create: vi.fn(),
          updateMany: vi.fn(),
        },
        loopEvent: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
      })
    ),
    { tx: vi.fn() }
  ),
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

import { loopsService } from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loopsService.findAll — compute target and projectId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes computeTarget in the Prisma include clause", async () => {
    mockFindMany.mockResolvedValue([]);

    await loopsService.findAll("org-1", {});

    const call = mockFindMany.mock.calls[0][0];
    expect(call.include).toHaveProperty("computeTarget");
    expect(call.include.computeTarget).toEqual({
      select: { id: true, machineName: true, isOnline: true },
    });
  });

  it("adds artifact.projectId filter when projectId is provided", async () => {
    mockFindMany.mockResolvedValue([]);

    await loopsService.findAll("org-1", { projectId: "proj-1" });

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({
        artifact: { projectId: "proj-1" },
      })
    );
  });

  it("does not add artifact filter when projectId is not provided", async () => {
    mockFindMany.mockResolvedValue([]);

    await loopsService.findAll("org-1", {});

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("artifact");
  });

  it("maps computeTarget from Prisma record when present", async () => {
    const computeTarget = {
      id: "ct-1",
      machineName: "Mikes-MacBook",
      isOnline: true,
    };
    mockFindMany.mockResolvedValue([
      {
        id: "loop-1",
        organizationId: "org-1",
        userId: "user-1",
        status: "RUNNING",
        command: "PLAN",
        artifactId: null,
        artifactVersion: null,
        workstreamId: null,
        parentLoopId: null,
        computeTargetId: "ct-1",
        prompt: null,
        repo: null,
        contextRefs: null,
        containerId: null,
        s3StateKey: null,
        prUrl: null,
        prNumber: null,
        branchName: null,
        sessionId: null,
        tokensInput: 0,
        tokensOutput: 0,
        tokensByModel: null,
        estimatedCost: null,
        startedAt: null,
        completedAt: null,
        error: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        user: {
          id: "user-1",
          email: "mike@example.com",
          firstName: "Mike",
          lastName: "A",
          avatarUrl: null,
        },
        computeTarget,
      },
    ]);

    const result = await loopsService.findAll("org-1", {});

    expect(result).toHaveLength(1);
    expect(result[0].computeTarget).toEqual(computeTarget);
    expect(result[0].computeTargetId).toBe("ct-1");
  });

  it("maps computeTarget as null when not present", async () => {
    mockFindMany.mockResolvedValue([
      {
        id: "loop-2",
        organizationId: "org-1",
        userId: "user-1",
        status: "RUNNING",
        command: "PLAN",
        artifactId: null,
        artifactVersion: null,
        workstreamId: null,
        parentLoopId: null,
        computeTargetId: null,
        prompt: null,
        repo: null,
        contextRefs: null,
        containerId: "arn:aws:ecs:task/abc",
        s3StateKey: null,
        prUrl: null,
        prNumber: null,
        branchName: null,
        sessionId: null,
        tokensInput: 0,
        tokensOutput: 0,
        tokensByModel: null,
        estimatedCost: null,
        startedAt: null,
        completedAt: null,
        error: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        user: {
          id: "user-1",
          email: "mike@example.com",
          firstName: "Mike",
          lastName: "A",
          avatarUrl: null,
        },
        computeTarget: null,
      },
    ]);

    const result = await loopsService.findAll("org-1", {});

    expect(result).toHaveLength(1);
    expect(result[0].computeTarget).toBeNull();
    expect(result[0].computeTargetId).toBeNull();
    expect(result[0].containerId).toBe("arn:aws:ecs:task/abc");
  });
});

describe("loopsService.findById — compute target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes computeTarget in the Prisma include clause", async () => {
    mockFindUnique.mockResolvedValue(null);

    await loopsService.findById("loop-1", "org-1");

    const call = mockFindUnique.mock.calls[0][0];
    expect(call.include).toHaveProperty("computeTarget");
    expect(call.include.computeTarget).toEqual({
      select: { id: true, machineName: true, isOnline: true },
    });
  });
});

describe("loopsService.findLatestStateBearingDesktopForArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters to completed desktop loops before checking raw plan state", async () => {
    mockFindMany.mockResolvedValue([]);

    await loopsService.findLatestStateBearingDesktopForArtifact(
      "doc-1",
      "org-1"
    );

    const call = mockFindMany.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({
        artifactId: "doc-1",
        organizationId: "org-1",
        status: "COMPLETED",
        computeTargetId: { not: null },
        branchName: { not: null },
        sessionId: { not: null },
      })
    );
    expect(call.orderBy).toEqual({ createdAt: "desc" });
    expect(call.take).toBe(50);
  });
});
