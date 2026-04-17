/**
 * Tests for loopsService.findActivePlanLoopForDocument staleness gating.
 *
 * The method guards re-launches by returning an active loop when one exists,
 * but must NOT block retries for stale PENDING/CLAIMED loops that never got
 * a containerId (i.e. the relay dispatch failed or was never delivered).
 *
 * Staleness threshold: 30 seconds.
 * Rules:
 * - RUNNING → always active (no time limit)
 * - CLAIMED with containerId → always active (dispatched + acknowledged)
 * - PENDING or CLAIMED without containerId, created <30s ago → active
 * - PENDING or CLAIMED without containerId, created ≥30s ago → stale → returns null
 */

import { type Mock, vi } from "vitest";

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

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
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

import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockWithDb = withDb as unknown as Mock;

/** Minimal Prisma loop row that toLoop() can transform without errors. */
function buildPrismaLoopRow(overrides: {
  status: string;
  containerId?: string | null;
  createdAt: Date;
  command?: string;
}) {
  return {
    id: "loop-1",
    organizationId: "org-1",
    userId: "user-1",
    status: overrides.status,
    command: overrides.command ?? "PLAN",
    documentId: "artifact-1",
    workstreamId: null,
    parentLoopId: null,
    computeTargetId: null,
    prompt: null,
    repo: null,
    contextRefs: null,
    containerId: overrides.containerId ?? null,
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
    uploadedArtifacts: null,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
  };
}

/** Configure withDb to call the Prisma callback with a stub db. */
function setupFindFirst(
  returnRow: ReturnType<typeof buildPrismaLoopRow> | null
) {
  const mockFindFirst = vi.fn().mockResolvedValue(returnRow);
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ loop: { findFirst: mockFindFirst } })
  );
  return mockFindFirst;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loopsService.findActivePlanLoopForDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a RUNNING loop regardless of age", async () => {
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    const row = buildPrismaLoopRow({
      status: "RUNNING",
      createdAt: twoMinutesAgo,
    });
    setupFindFirst(row);

    const result = await loopsService.findActivePlanLoopForDocument(
      "artifact-1",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("loop-1");
    expect(result?.status).toBe("RUNNING");
  });

  it("returns a CLAIMED loop with containerId regardless of age", async () => {
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    const row = buildPrismaLoopRow({
      status: "CLAIMED",
      containerId: "arn:aws:ecs:task/abc",
      createdAt: twoMinutesAgo,
    });
    setupFindFirst(row);

    const result = await loopsService.findActivePlanLoopForDocument(
      "artifact-1",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe("CLAIMED");
    expect(result?.containerId).toBe("arn:aws:ecs:task/abc");
  });

  it("returns a recent PENDING loop (created 5 seconds ago, no containerId)", async () => {
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    const row = buildPrismaLoopRow({
      status: "PENDING",
      createdAt: fiveSecondsAgo,
    });
    setupFindFirst(row);

    const result = await loopsService.findActivePlanLoopForDocument(
      "artifact-1",
      "org-1"
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe("PENDING");
  });

  it("returns null for a stale PENDING loop (created 2 minutes ago, no containerId)", async () => {
    // Stale loops have createdAt before the 30s staleness threshold.
    // findFirst returns null when no matching loops satisfy the OR conditions.
    setupFindFirst(null);

    const result = await loopsService.findActivePlanLoopForDocument(
      "artifact-1",
      "org-1"
    );

    expect(result).toBeNull();
  });

  it("returns null for a stale CLAIMED loop (created 2 minutes ago, no containerId)", async () => {
    // CLAIMED without containerId and older than 30s should be excluded by the
    // OR conditions — findFirst returns null.
    setupFindFirst(null);

    const result = await loopsService.findActivePlanLoopForDocument(
      "artifact-1",
      "org-1"
    );

    expect(result).toBeNull();
  });

  it("returns null when no matching loops exist", async () => {
    setupFindFirst(null);

    const result = await loopsService.findActivePlanLoopForDocument(
      "artifact-1",
      "org-1"
    );

    expect(result).toBeNull();
  });

  it("passes the correct staleness threshold in the OR clause", async () => {
    const mockFindFirst = setupFindFirst(null);
    const before = Date.now();

    await loopsService.findActivePlanLoopForDocument("artifact-1", "org-1");

    const after = Date.now();
    const callArgs = mockFindFirst.mock.calls[0][0];
    const orConditions = callArgs.where.OR as Record<string, unknown>[];

    // The third OR branch carries the staleness threshold.
    const stalenessCondition = orConditions.find(
      (c) => typeof (c as { createdAt?: unknown }).createdAt === "object"
    );
    expect(stalenessCondition).toBeDefined();

    const threshold = (
      stalenessCondition as { createdAt: { gte: Date } }
    ).createdAt.gte.getTime();

    // The threshold must be 30 seconds in the past, ±50ms tolerance.
    expect(threshold).toBeGreaterThanOrEqual(before - 30_000 - 50);
    expect(threshold).toBeLessThanOrEqual(after - 30_000 + 50);
  });

  it("queries only PLAN command loops", async () => {
    const mockFindFirst = setupFindFirst(null);

    await loopsService.findActivePlanLoopForDocument("artifact-1", "org-1");

    const callArgs = mockFindFirst.mock.calls[0][0];
    expect(callArgs.where.command).toBe("PLAN");
  });

  it("queries by the provided artifactId and organizationId", async () => {
    const mockFindFirst = setupFindFirst(null);

    await loopsService.findActivePlanLoopForDocument("artifact-abc", "org-xyz");

    const callArgs = mockFindFirst.mock.calls[0][0];
    expect(callArgs.where.documentId).toBe("artifact-abc");
    expect(callArgs.where.organizationId).toBe("org-xyz");
  });
});
