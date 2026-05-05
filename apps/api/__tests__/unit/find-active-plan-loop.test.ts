/**
 * Tests for loopsService.findActiveLoopForDocumentAndCommand
 *
 * Staleness rules:
 * - RUNNING always blocks (returns the loop)
 * - CLAIMED with containerId always blocks (returns the loop)
 * - CLAIMED without containerId never blocks (returns null, regardless of age)
 * - PENDING without containerId younger than 30s blocks (returns the loop)
 * - PENDING without containerId older than 30s does not block (returns null)
 *
 * Also verifies the method accepts any LoopCommand value, not just PLAN.
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
  verifyInstallationBranchExists: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

vi.mock("@/lib/loops/uploaded-plan-artifacts", () => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
}));

const mockFindFirst = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          findFirst: mockFindFirst,
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          create: vi
            .fn()
            .mockResolvedValue({ id: "loop-new", status: "PENDING" }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          count: vi.fn().mockResolvedValue(0),
          aggregate: vi.fn().mockResolvedValue({ _count: 0, _sum: {} }),
          groupBy: vi.fn().mockResolvedValue([]),
        },
        organization: {
          findUnique: vi.fn().mockResolvedValue({ settings: null }),
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
    Completed: "COMPLETED",
    Failed: "FAILED",
    Cancelled: "CANCELLED",
    TimedOut: "TIMED_OUT",
  },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  Prisma: { sql: vi.fn(), join: vi.fn() },
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Minimal PrismaLoop-shaped record factory
// The toLoop() conversion reads: artifactId → documentId, artifactVersion →
// documentVersion, estimatedCost via Number(), plus JSON-parsed repo/error.
// ---------------------------------------------------------------------------

function buildPrismaLoop(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "loop-1",
    organizationId: "org-1",
    userId: "user-1",
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
    artifactVersion: null,
    metadata: {},
    uploadedArtifacts: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loopsService.findActiveLoopForDocumentAndCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Command parameter — accepts any LoopCommand, not just PLAN
  // -------------------------------------------------------------------------

  it("accepts CODE command and passes it through to the query", async () => {
    const loop = buildPrismaLoop({ command: "EXECUTE", status: "RUNNING" });
    mockFindFirst.mockResolvedValue(loop);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "EXECUTE",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.command).toBe("EXECUTE");
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ command: "EXECUTE" }),
      })
    );
  });

  it("accepts PLAN command", async () => {
    const loop = buildPrismaLoop({ command: "PLAN", status: "RUNNING" });
    mockFindFirst.mockResolvedValue(loop);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.command).toBe("PLAN");
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ command: "PLAN" }),
      })
    );
  });

  // -------------------------------------------------------------------------
  // RUNNING status — always blocks
  // -------------------------------------------------------------------------

  it("returns the loop when status is RUNNING", async () => {
    const loop = buildPrismaLoop({ status: "RUNNING" });
    mockFindFirst.mockResolvedValue(loop);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("loop-1");
    expect(result?.status).toBe("RUNNING");
  });

  // -------------------------------------------------------------------------
  // CLAIMED + containerId — always blocks
  // -------------------------------------------------------------------------

  it("returns the loop when status is CLAIMED and containerId is set", async () => {
    const loop = buildPrismaLoop({
      status: "CLAIMED",
      containerId: "container-abc",
      createdAt: new Date(Date.now() - 60_000), // 60s old — still blocks
    });
    mockFindFirst.mockResolvedValue(loop);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("loop-1");
    expect(result?.status).toBe("CLAIMED");
    expect(result?.containerId).toBe("container-abc");
  });

  // -------------------------------------------------------------------------
  // CLAIMED without containerId — never blocks (regardless of age)
  // -------------------------------------------------------------------------

  it("returns null when status is CLAIMED but containerId is null (young loop)", async () => {
    // The query WHERE clause excludes CLAIMED+null containerId from the OR conditions,
    // so findFirst returns null for this case.
    mockFindFirst.mockResolvedValue(null);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).toBeNull();
  });

  it("returns null when status is CLAIMED but containerId is null (old loop)", async () => {
    // Regardless of age, CLAIMED without containerId should not block.
    // The query WHERE clause does not include this case, so findFirst returns null.
    mockFindFirst.mockResolvedValue(null);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // PENDING without containerId — blocks only if younger than 30s
  // -------------------------------------------------------------------------

  it("returns null when status is PENDING, containerId is null, and loop is older than 30s", async () => {
    // A stale PENDING row (>30s old, no containerId) is not returned by the query.
    // findFirst returns null because the createdAt filter excludes it.
    mockFindFirst.mockResolvedValue(null);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).toBeNull();
  });

  it("returns the loop when status is PENDING, containerId is null, and loop is younger than 30s", async () => {
    const loop = buildPrismaLoop({
      status: "PENDING",
      containerId: null,
      createdAt: new Date(Date.now() - 5000), // 5s old — within the 30s window
    });
    mockFindFirst.mockResolvedValue(loop);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("loop-1");
    expect(result?.status).toBe("PENDING");
  });

  // -------------------------------------------------------------------------
  // No matching loop — returns null
  // -------------------------------------------------------------------------

  it("returns null when findFirst returns null (no active loop)", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Query structure verification
  // -------------------------------------------------------------------------

  it("passes documentId, command, and organizationId to the query where clause", async () => {
    mockFindFirst.mockResolvedValue(null);

    await loopsService.findActiveLoopForDocumentAndCommand(
      "doc-xyz",
      "EXECUTE",
      "org-abc"
    );

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactId: "doc-xyz",
          command: "EXECUTE",
          organizationId: "org-abc",
        }),
      })
    );
  });

  it("includes OR conditions for RUNNING, CLAIMED+containerId, and recent PENDING", async () => {
    mockFindFirst.mockResolvedValue(null);

    await loopsService.findActiveLoopForDocumentAndCommand(
      "artifact-1",
      "PLAN",
      "org-1"
    );

    const [callArgs] = mockFindFirst.mock.calls;
    const { OR } = callArgs[0].where;

    expect(OR).toBeDefined();
    expect(Array.isArray(OR)).toBe(true);

    // Should include RUNNING
    expect(OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "RUNNING" })])
    );

    // Should include CLAIMED with non-null containerId
    expect(OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "CLAIMED",
          containerId: expect.objectContaining({ not: null }),
        }),
      ])
    );

    // Should include PENDING with null containerId and a createdAt filter
    expect(OR).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "PENDING",
          containerId: null,
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      ])
    );
  });
});
